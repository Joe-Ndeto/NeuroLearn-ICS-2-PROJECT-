
const storedLearner = sessionStorage.getItem('neurolearnLearner');

if (!storedLearner) {
    window.location.replace('login_signup.html');
} else {
    try {
        const learner = JSON.parse(storedLearner);

        if (!learner) {
            throw new Error('Learner information is missing.');
        }

        const learnerName = document.getElementById('learner-name');

        if (learnerName && learner.username) {
            learnerName.textContent = learner.username;
        }
    } catch (error) {
        console.error('Could not load learner information:', error);

        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    }
}

const logoutButton = document.getElementById('logout-button');

if (logoutButton) {
    logoutButton.addEventListener('click', function () {
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    });
}

// Open the new AI Study Workspace.
const studyWorkspaceButton = document.getElementById(
    'open-study-workspace'
);

if (studyWorkspaceButton) {
    studyWorkspaceButton.addEventListener('click', function () {
        window.location.href = 'study.html';
    });
}

