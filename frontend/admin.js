'use strict';

const api = window.NeuroLearnApi;
const roleRouting = window.NeuroLearnRoleRouting;

function loadAdminModules() {
    return ['admin-submissions.js', 'admin-sync-operations.js'].reduce((chain, src) =>
        chain.then(() => new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = resolve;
            script.onerror = () => reject(new Error('Administrator dashboard tools could not be loaded.'));
            document.head.appendChild(script);
        })), Promise.resolve());
}

async function initializeAdminDashboard() {
    const content = document.getElementById('admin-dashboard-content');
    const sessionMessage = document.getElementById('admin-session-message');
    const result = await roleRouting.validateAndRoute({
        api,
        location: window.location,
        expectedRole: 'admin',
        onUnavailable(message) {
            if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(sessionMessage, message);
            else sessionMessage.textContent = message;
        }
    });
    if (!result.ok) return;

    try {
        await loadAdminModules();
    } catch {
        if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(sessionMessage, 'Administrator tools could not be loaded. Refresh the page to try again.');
        else sessionMessage.textContent = 'Administrator tools could not be loaded. Refresh the page to try again.';
        return;
    }

    document.body.dataset.role = 'admin';
    sessionMessage.hidden = true;
    sessionMessage.setAttribute('aria-busy', 'false');
    content.hidden = false;
    const name = document.getElementById('administrator-name');
    if (name && result.learner.username) name.textContent = result.learner.username;

    window.NeuroLearnAdminSubmissions.initializeAdminSubmissionReview({ document, api });
    window.NeuroLearnSyncOperations.initializeKnowledgeSyncOperations({ document, api });
    const isSubmissionDetail = Boolean(new URLSearchParams(window.location.search).get('submission'));
    document.getElementById('admin-sync-operations').hidden = isSubmissionDetail;
}

const logoutButton = document.getElementById('admin-logout-button');
if (logoutButton) logoutButton.addEventListener('click', () => api.clearSession());

initializeAdminDashboard();
