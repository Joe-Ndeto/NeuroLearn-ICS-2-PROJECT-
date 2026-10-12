const API_URL = 'http://localhost:5000/api/auth';

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

        sessionStorage.setItem(
            'neurolearnLearner',
            JSON.stringify(result.learner)
        );

        window.location.href = new URL(
            'dashboard.html',
            window.location.href
        ).href;

    } catch (error) {
        message.textContent = error.message;
        console.error('Authentication error:', error);
    }
}

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