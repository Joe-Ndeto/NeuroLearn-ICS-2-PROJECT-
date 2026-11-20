'use strict';

const api = window.NeuroLearnApi;
const roleRouting = window.NeuroLearnRoleRouting;

function loadStudentContributionModule() {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'knowledge-contributions.js';
        script.onload = resolve;
        script.onerror = () => reject(new Error('Student contribution tools could not be loaded.'));
        document.head.appendChild(script);
    });
}

async function initializeDashboard() {
    const header = document.getElementById('student-header');
    const content = document.getElementById('student-dashboard-content');
    const sessionMessage = document.getElementById('dashboard-session-message');

    const result = await roleRouting.validateAndRoute({
        api,
        location: window.location,
        expectedRole: 'student',
        onUnavailable(message) {
            if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(sessionMessage, message);
            else sessionMessage.textContent = message;
        }
    });
    if (!result.ok) return;

    document.body.dataset.role = 'student';
    header.hidden = false;
    content.hidden = false;
    try {
        await loadStudentContributionModule();
    } catch {
        sessionMessage.hidden = false;
        if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(sessionMessage, 'Student contribution tools could not be loaded. Refresh the page to try again.');
        else sessionMessage.textContent = 'Student contribution tools could not be loaded. Refresh the page to try again.';
        return;
    }

    sessionMessage.hidden = true;
    sessionMessage.setAttribute('aria-busy', 'false');
    window.NeuroLearnContributions.initializeKnowledgeContributions({ document, api });

    const learnerName = document.getElementById('learner-name');
    if (learnerName && result.learner.username) {
        learnerName.textContent = result.learner.username;
    }
}

const logoutButton = document.getElementById('logout-button');
if (logoutButton) logoutButton.addEventListener('click', () => api.clearSession());

const studyWorkspaceButton = document.getElementById('open-study-workspace');
if (studyWorkspaceButton) {
    studyWorkspaceButton.addEventListener('click', () => {
        window.location.href = 'study.html';
    });
}

initializeDashboard();
