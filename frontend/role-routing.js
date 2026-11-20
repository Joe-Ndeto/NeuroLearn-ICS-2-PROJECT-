'use strict';

(function initializeNeuroLearnRoleRouting(root) {
    const DASHBOARDS = Object.freeze({
        student: 'dashboard.html',
        admin: 'admin.html'
    });

    function currentPage(location) {
        try {
            return new URL(location.href).pathname.split('/').pop() || 'index.html';
        } catch {
            return String(location.pathname || '').split('/').pop();
        }
    }

    function navigateIfNeeded(location, destination) {
        if (currentPage(location) === destination) return false;
        location.replace(new URL(destination, location.href).href);
        return true;
    }

    async function validateAndRoute({ api, location = root.location, expectedRole = null, onUnavailable = () => {} }) {
        let learner;
        try {
            // This is the only role source used by routing. Cached session data
            // and URL parameters never grant page access.
            learner = await api.validateSession();
        } catch (error) {
            if (error.status !== 401) {
                onUnavailable('Your session could not be verified. Check your connection and try again.');
            }
            return { ok: false, reason: error.status === 401 ? 'unauthenticated' : 'verification_unavailable' };
        }

        const destination = DASHBOARDS[learner?.role];
        if (!destination) {
            api.clearSession({ redirect: false });
            navigateIfNeeded(location, 'login_signup.html');
            return { ok: false, reason: 'unsupported_role' };
        }

        if (expectedRole === null || learner.role !== expectedRole) {
            navigateIfNeeded(location, destination);
            return { ok: false, redirected: true, reason: 'role_mismatch' };
        }

        return { ok: true, learner };
    }

    const roleRouting = { currentPage, navigateIfNeeded, validateAndRoute };
    root.NeuroLearnRoleRouting = roleRouting;
    if (typeof module !== 'undefined' && module.exports) module.exports = roleRouting;
})(typeof window === 'undefined' ? globalThis : window);
