
'use strict';

(function initializeNeuroLearnApi(root) {
    const LOCAL_API_BASE_URL = 'http://localhost:5000/api';
    const TOKEN_KEY = 'neurolearnToken';
    const LEARNER_KEY = 'neurolearnLearner';

    class ApiError extends Error {
        constructor(message, { status = 0, code = null, payload = null } = {}) {
            super(message);
            this.name = 'ApiError';
            this.status = status;
            this.code = code;
            this.payload = payload;
            this.unauthorized = status === 401;
            this.forbidden = status === 403;
        }
    }

    function defaultApiBaseUrl(location) {
        const hostname = String(location?.hostname || '').toLowerCase();

        const isLocal = location?.protocol === 'file:' ||
            ['localhost', '127.0.0.1', '::1'].includes(hostname);

        if (isLocal || !location?.origin || location.origin === 'null') {
            return LOCAL_API_BASE_URL;
        }

        return `${String(location.origin).replace(/\/+$/, '')}/api`;
    }

    function createApiClient({
        runtime = root,
        fetchImpl = runtime.fetch?.bind(runtime),
        storage = runtime.sessionStorage,
        config = runtime.NEUROLEARN_CONFIG || {},
        location = runtime.location,
        redirectOnUnauthorized = true
    } = {}) {
        let authenticatedLearner = null;

        const apiBaseUrl = String(config.apiBaseUrl || defaultApiBaseUrl(location))
            .trim()
            .replace(/\/+$/, '');

        function clearSession({ redirect = redirectOnUnauthorized } = {}) {
            storage?.removeItem(TOKEN_KEY);
            storage?.removeItem(LEARNER_KEY);
            authenticatedLearner = null;

            if (redirect) {
                location?.replace?.('login_signup.html');
            }
        }

        function setSession({ token, learner }) {
            if (
                typeof token !== 'string' ||
                !token ||
                !learner ||
                typeof learner !== 'object'
            ) {
                throw new ApiError(
                    'Login response is missing learner information or authentication token.'
                );
            }

            storage?.setItem(TOKEN_KEY, token);
            storage?.setItem(LEARNER_KEY, JSON.stringify(learner));

            authenticatedLearner = learner;
        }

        function getCachedLearner() {
            try {
                const serialized = storage?.getItem(LEARNER_KEY);
                return serialized ? JSON.parse(serialized) : null;
            } catch {
                return null;
            }
        }

        function hasToken() {
            return Boolean(storage?.getItem(TOKEN_KEY));
        }

        function resolveUrl(path) {
            if (typeof path !== 'string' || !path.trim()) {
                throw new TypeError('An API path is required.');
            }

            if (/^https?:\/\//i.test(path)) {
                return path;
            }

            return `${apiBaseUrl}/${path.replace(/^\/+/, '')}`;
        }

        async function request(path, options = {}) {
            if (typeof fetchImpl !== 'function') {
                throw new ApiError(
                    'Network requests are unavailable in this environment.'
                );
            }

            const {
                method = 'GET',
                headers: suppliedHeaders = {},
                body,
                auth = true,
                handleUnauthorized = true,
                ...fetchOptions
            } = options;

            const normalizedMethod = String(method).toUpperCase();
            const headers = new Headers(suppliedHeaders);

            const token = auth ? storage?.getItem(TOKEN_KEY) : null;

            if (auth && !token) {
                clearSession({ redirect: handleUnauthorized });

                throw new ApiError(
                    'Your session has expired. Please sign in again.',
                    { status: 401 }
                );
            }

            if (token) {
                headers.set('Authorization', `Bearer ${token}`);
            }

            let requestBody = body;

            if (
                body !== undefined &&
                body !== null &&
                typeof body === 'object' &&
                !(typeof FormData !== 'undefined' && body instanceof FormData) &&
                !(typeof Blob !== 'undefined' && body instanceof Blob) &&
                !(typeof URLSearchParams !== 'undefined' &&
                    body instanceof URLSearchParams)
            ) {
                requestBody = JSON.stringify(body);

                if (!headers.has('Content-Type')) {
                    headers.set('Content-Type', 'application/json');
                }
            }

            let response;

            try {
                response = await fetchImpl(resolveUrl(path), {
                    ...fetchOptions,

                    // Prevent stale conditional-cache responses for GET requests.
                    cache: fetchOptions.cache ??
                        (normalizedMethod === 'GET' ? 'no-store' : 'default'),

                    method: normalizedMethod,
                    headers,

                    ...(requestBody === undefined
                        ? {}
                        : { body: requestBody })
                });
            } catch {
                throw new ApiError(
                    'Could not reach the server. Check your connection and try again.'
                );
            }

            const responseText = await response.text().catch(() => '');

            let payload = null;

            if (responseText.trim()) {
                try {
                    payload = JSON.parse(responseText);
                } catch {
                    payload = null;
                }
            }

            if (
                response.status === 401 &&
                auth &&
                token &&
                handleUnauthorized
            ) {
                clearSession();
            }

            if (!response.ok) {
                const message = payload && typeof payload === 'object'
                    ? payload.message || payload.error
                    : null;

                throw new ApiError(
                    message || `Request failed with status ${response.status}.`,
                    {
                        status: response.status,
                        code: payload?.code || null,
                        payload
                    }
                );
            }

            if (!responseText.trim()) {
                return null;
            }

            if (payload === null) {
                throw new ApiError(
                    'The server returned an invalid response.',
                    { status: response.status }
                );
            }

            return payload;
        }

        async function validateSession() {
            if (!hasToken()) {
                clearSession();

                throw new ApiError(
                    'Please sign in to continue.',
                    { status: 401 }
                );
            }

            const result = await request('/auth/me');

            if (!result?.learner || typeof result.learner !== 'object') {
                throw new ApiError(
                    'The server did not return a valid learner account.',
                    { status: 502 }
                );
            }

            authenticatedLearner = result.learner;

            storage?.setItem(
                LEARNER_KEY,
                JSON.stringify(authenticatedLearner)
            );

            return authenticatedLearner;
        }

        return {
            apiBaseUrl,
            ApiError,
            clearSession,
            getCachedLearner,
            hasToken,

            isAdministrator: () => authenticatedLearner?.role === 'admin',
            isStudent: () => authenticatedLearner?.role === 'student',

            getAuthenticatedLearner: () => authenticatedLearner,

            request,

            get: (path, options = {}) =>
                request(path, { ...options, method: 'GET' }),

            post: (path, body, options = {}) =>
                request(path, { ...options, method: 'POST', body }),

            patch: (path, body, options = {}) =>
                request(path, { ...options, method: 'PATCH', body }),

            put: (path, body, options = {}) =>
                request(path, { ...options, method: 'PUT', body }),

            delete: (path, options = {}) =>
                request(path, { ...options, method: 'DELETE' }),

            setSession,
            validateSession
        };
    }

    const api = createApiClient();

    root.NeuroLearnApi = api;
    root.createNeuroLearnApiClient = createApiClient;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            ApiError,
            createApiClient,
            api
        };
    }
})(typeof window === 'undefined' ? globalThis : window);
