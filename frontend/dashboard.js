
const API_URL = 'http://localhost:5000/api/auth';

async function initializeDashboard() {
    const token = sessionStorage.getItem('neurolearnToken');

    if (!token) {
        window.location.replace('login_signup.html');
        return;
    }

    try {
        const response = await fetch(`${API_URL}/me`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(
                result.error || result.message ||
                'Your session could not be verified.'
            );
        }

        const learner = result.learner;

        if (!learner) {
            throw new Error('Learner information is missing.');
        }

        // Refresh the stored learner information using trusted server data.
        sessionStorage.setItem(
            'neurolearnLearner',
            JSON.stringify(learner)
        );

        const learnerName = document.getElementById('learner-name');

        if (learnerName && learner.username) {
            learnerName.textContent = learner.username;
        }

    } catch (error) {
        console.error('Dashboard authentication error:', error);

        sessionStorage.removeItem('neurolearnLearner');
        sessionStorage.removeItem('neurolearnToken');

        window.location.replace('login_signup.html');
    }
}

// Logout.
const logoutButton = document.getElementById('logout-button');

if (logoutButton) {
    logoutButton.addEventListener('click', function () {
        sessionStorage.removeItem('neurolearnLearner');
        sessionStorage.removeItem('neurolearnToken');

        window.location.replace('login_signup.html');
    });
}

// Open the AI Study Workspace.
const studyWorkspaceButton = document.getElementById(
    'open-study-workspace'
);

if (studyWorkspaceButton) {
    studyWorkspaceButton.addEventListener('click', function () {
        window.location.href = 'study.html';
    });
}

// Verify authentication before loading learner information.
initializeDashboard();
