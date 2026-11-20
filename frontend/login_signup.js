
const api = window.NeuroLearnApi;

const GOOGLE_CLIENT_ID =
    '1019813293146-e10qgtk8iubmr79gamtq773acu37hie4.apps.googleusercontent.com';

let authPending = false;
let googleAuthPending = false;

function setAuthMessage(message) {
    const element = document.getElementById('auth-message');
    if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(element, message);
    else element.textContent = message;
}

function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });

    document.querySelectorAll('.form-box').forEach(form => {
        form.classList.remove('active');
    });

    const isLogin = tabName === 'login';

    document.querySelectorAll('.tab')[isLogin ? 0 : 1]
        .classList.add('active');

    document.getElementById(
        isLogin ? 'login-form' : 'signup-form'
    ).classList.add('active');

    setAuthMessage('');
}

// Store learner information and JWT after successful authentication.
async function completeLogin(learner, token) {
    if (!learner || !token) {
        throw new Error(
            'Login response is missing learner information or authentication token.'
        );
    }

    api.setSession({ learner, token });
    const result = await window.NeuroLearnRoleRouting.validateAndRoute({
        api,
        location: window.location,
        onUnavailable(message) {
            setAuthMessage(message);
        }
    });
    if (!result.ok && result.reason === 'unsupported_role') {
        document.getElementById('auth-message').textContent = 'This account does not have a supported NeuroLearn role.';
    }
}

// Handle email/password authentication.
async function sendAuthRequest(endpoint, data) {
    if (authPending || googleAuthPending) return;
    authPending = true;
    const message = document.getElementById('auth-message');
    const form = document.getElementById(endpoint === 'signup' ? 'signup-form' : 'login-form');
    const submitButton = form.querySelector('button[type="submit"]');
    window.NeuroLearnLoading?.setButtonLoading(submitButton, true, endpoint === 'signup' ? 'Creating account' : 'Signing in');
    if (window.NeuroLearnLoading?.showIndicator) window.NeuroLearnLoading.showIndicator(message, endpoint === 'signup' ? 'Creating account' : 'Signing in');

    try {
        const result = await api.post(`/auth/${endpoint}`, data, { auth: false });

        if (endpoint === 'signup') {
            document.getElementById('signup-form').reset();

            switchTab('login');

            setAuthMessage('Account created successfully! Please log in.');

            return;
        }

        await completeLogin(result.learner, result.token);

    } catch (error) {
        setAuthMessage(error.message);
        console.error('Authentication request failed.', { status: error.status || 0 });
    } finally {
        authPending = false;
        window.NeuroLearnLoading?.setButtonLoading(submitButton, false);
    }
}

// Handle Google authentication for BOTH buttons.
window.handleGoogleCredentialResponse = async function (response) {
    const message = document.getElementById('auth-message');

    if (googleAuthPending || authPending) return;

    if (!response || !response.credential) {
        setAuthMessage('Google did not return a sign-in credential.');
        return;
    }

    googleAuthPending = true;
    if (window.NeuroLearnLoading?.showIndicator) window.NeuroLearnLoading.showIndicator(message, 'Signing in with Google');

    try {
        const result = await sendGoogleRequest(response.credential);

        await completeLogin(result.learner, result.token);

    } catch (error) {
        setAuthMessage(error.message);
        console.error('Google authentication error:', error);
    } finally {
        googleAuthPending = false;
    }
};

// Send Google's verified credential to the backend.
async function sendGoogleRequest(credential) {
    return api.post('/auth/google', { credential }, { auth: false });
}

// Render separate Google buttons for Login and Sign Up.
function initializeGoogleSignIn() {
    if (!window.google?.accounts?.id) {
        console.error(
            'Google Identity Services has not loaded. Check your internet connection.'
        );
        return;
    }

    const loginButton = document.getElementById(
        'google-signin-button'
    );

    const signupButton = document.getElementById(
        'google-signup-button'
    );

    if (!loginButton && !signupButton) {
        console.error('No Google button containers were found.');
        return;
    }

    window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: window.handleGoogleCredentialResponse
    });

    const buttonOptions = {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        shape: 'rectangular',
        width: 280
    };

    // Google button on Login tab.
    if (loginButton) {
        window.google.accounts.id.renderButton(loginButton, {
            ...buttonOptions,
            text: 'continue_with'
        });
    }

    // Google button on Sign Up tab.
    if (signupButton) {
        window.google.accounts.id.renderButton(signupButton, {
            ...buttonOptions,
            text: 'signup_with'
        });
    }
}

window.addEventListener('load', initializeGoogleSignIn);

// Email/password sign-up.
document.getElementById('signup-form').addEventListener(
    'submit',
    async function (event) {
        event.preventDefault();

        const username = document
            .getElementById('signup-username')
            .value.trim();

        const email = document
            .getElementById('signup-email')
            .value.trim();

        const password = document
            .getElementById('signup-password')
            .value;

        const confirmPassword = document
            .getElementById('signup-confirm-password')
            .value;

        if (password !== confirmPassword) {
            setAuthMessage('Passwords do not match.');
            return;
        }

        await sendAuthRequest('signup', {
            username,
            email,
            password
        });
    }
);

// Email/password login.
document.getElementById('login-form').addEventListener(
    'submit',
    async function (event) {
        event.preventDefault();

        const email = document
            .getElementById('login-email')
            .value.trim();

        const password = document
            .getElementById('login-password')
            .value;

        await sendAuthRequest('login', {
            email,
            password
        });
    }
);
