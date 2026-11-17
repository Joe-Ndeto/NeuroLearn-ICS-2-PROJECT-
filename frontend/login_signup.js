
const API_URL = 'http://localhost:5000/api/auth';

const GOOGLE_CLIENT_ID =
    '1019813293146-e10qgtk8iubmr79gamtq773acu37hie4.apps.googleusercontent.com';

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

    document.getElementById('auth-message').textContent = '';
}

// Store learner information and JWT after successful authentication.
function completeLogin(learner, token) {
    if (!learner || !token) {
        throw new Error(
            'Login response is missing learner information or authentication token.'
        );
    }

    sessionStorage.setItem(
        'neurolearnLearner',
        JSON.stringify(learner)
    );

    sessionStorage.setItem(
        'neurolearnToken',
        token
    );

    window.location.href = new URL(
        'dashboard.html',
        window.location.href
    ).href;
}

// Handle email/password authentication.
async function sendAuthRequest(endpoint, data) {
    const message = document.getElementById('auth-message');
    message.textContent = 'Please wait...';

    try {
        const response = await fetch(`${API_URL}/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(
                result.error || 'Authentication request failed.'
            );
        }

        if (endpoint === 'signup') {
            document.getElementById('signup-form').reset();

            switchTab('login');

            message.textContent =
                'Account created successfully! Please log in.';

            return;
        }

        completeLogin(result.learner, result.token);

    } catch (error) {
        message.textContent = error.message;
        console.error('Authentication error:', error);
    }
}

// Handle Google authentication for BOTH buttons.
window.handleGoogleCredentialResponse = async function (response) {
    const message = document.getElementById('auth-message');

    if (!response || !response.credential) {
        message.textContent =
            'Google did not return a sign-in credential.';
        return;
    }

    message.textContent = 'Signing in with Google...';

    try {
        const result = await sendGoogleRequest(response.credential);

        completeLogin(result.learner, result.token);

    } catch (error) {
        message.textContent = error.message;
        console.error('Google authentication error:', error);
    }
};

// Send Google's verified credential to the backend.
async function sendGoogleRequest(credential) {
    const response = await fetch(`${API_URL}/google`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ credential })
    });

    const result = await response.json();

    if (!response.ok) {
        throw new Error(
            result.error || 'Google authentication failed.'
        );
    }

    return result;
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
            document.getElementById('auth-message').textContent =
                'Passwords do not match.';
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
