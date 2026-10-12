const storedLearner = sessionStorage.getItem('neurolearnLearner');

if (!storedLearner) {
    // No learner information is available; return to login
    window.location.replace('login_signup.html');
} else {
    try {
        const learner = JSON.parse(storedLearner);

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

document.getElementById('logout-button').addEventListener(
    'click',
    function () {
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    }
);