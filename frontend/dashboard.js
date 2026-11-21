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

function getRecommendationElements() {
    return {
        section: document.getElementById('student-recommendations'),
        loading: document.getElementById('recommendations-loading'),
        empty: document.getElementById('recommendations-empty'),
        error: document.getElementById('recommendations-error'),
        list: document.getElementById('recommendations-list'),
        retry: document.getElementById('recommendations-retry')
    };
}

function appendRecommendationText(documentRef, parent, tagName, className, value) {
    const element = documentRef.createElement(tagName);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
}

function formatMastery(mastery) {
    return typeof mastery === 'number' && Number.isFinite(mastery)
        ? `${mastery.toFixed(2)}%`
        : 'Unknown';
}

function renderRecommendation(documentRef, recommendation) {
    if (!recommendation || typeof recommendation.conceptName !== 'string' ||
        !recommendation.conceptName.trim() || typeof recommendation.priorityScore !== 'number' ||
        !Number.isFinite(recommendation.priorityScore) ||
        !(recommendation.mastery === null || (typeof recommendation.mastery === 'number' &&
            Number.isFinite(recommendation.mastery) && recommendation.mastery >= 0 && recommendation.mastery <= 100)) ||
        typeof recommendation.evidenceStatus !== 'string' || typeof recommendation.explanation !== 'string') {
        throw new Error('Invalid recommendation response.');
    }

    const card = documentRef.createElement('article');
    card.className = 'recommendation-card';
    appendRecommendationText(documentRef, card, 'h3', 'recommendation-title', recommendation.conceptName);

    const metrics = documentRef.createElement('div');
    metrics.className = 'recommendation-metrics';
    appendRecommendationText(documentRef, metrics, 'span', 'recommendation-priority',
        `Priority ${recommendation.priorityScore}`);
    appendRecommendationText(documentRef, metrics, 'span', '', `Mastery ${formatMastery(recommendation.mastery)}`);
    appendRecommendationText(documentRef, metrics, 'span', '', `Evidence ${recommendation.evidenceStatus}`);
    card.appendChild(metrics);

    appendRecommendationText(documentRef, card, 'p', 'recommendation-explanation', recommendation.explanation);

    const readiness = recommendation.prerequisiteReadiness;
    if (readiness && typeof readiness === 'object') {
        const heading = appendRecommendationText(documentRef, card, 'h4', 'recommendation-prerequisites-title', 'Prerequisite readiness');
        heading.id = `recommendation-prerequisites-${recommendation.conceptId}`;
        const readinessText = typeof readiness.satisfiedCount === 'number' && typeof readiness.totalCount === 'number'
            ? `${readiness.satisfiedCount} of ${readiness.totalCount} prerequisites satisfied`
            : readiness.satisfied === true ? 'Prerequisites satisfied' : 'Prerequisite status unavailable';
        appendRecommendationText(documentRef, card, 'p', 'recommendation-readiness-summary', readinessText);

        if (Array.isArray(readiness.prerequisites) && readiness.prerequisites.length) {
            const list = documentRef.createElement('ul');
            list.className = 'recommendation-prerequisite-list';
            for (const prerequisite of readiness.prerequisites) {
                const item = documentRef.createElement('li');
                const name = typeof prerequisite?.conceptName === 'string' ? prerequisite.conceptName : 'Concept';
                const evidence = typeof prerequisite?.evidenceStatus === 'string' ? prerequisite.evidenceStatus : 'Unknown evidence';
                item.textContent = `${name}: ${formatMastery(prerequisite?.mastery)} mastery, ${evidence}`;
                list.appendChild(item);
            }
            card.appendChild(list);
        }
    }

    return card;
}

let recommendationRequestPending = false;

async function loadStudentRecommendations() {
    const elements = getRecommendationElements();
    if (!elements.section || !elements.loading || !elements.empty || !elements.error || !elements.list ||
        !elements.retry || recommendationRequestPending) return;

    recommendationRequestPending = true;
    elements.section.setAttribute('aria-busy', 'true');
    elements.loading.hidden = false;
    elements.loading.setAttribute('aria-busy', 'true');
    elements.empty.hidden = true;
    elements.error.hidden = true;
    elements.retry.hidden = true;
    elements.list.replaceChildren();

    try {
        const response = await api.get('/recommendations/me');
        if (!response || response.success !== true || !Array.isArray(response.recommendations)) {
            throw new Error('Invalid recommendation response.');
        }
        if (response.recommendations.length === 0) {
            elements.empty.hidden = false;
        } else {
            const cards = response.recommendations.map(recommendation =>
                renderRecommendation(document, recommendation)
            );
            elements.list.replaceChildren(...cards);
        }
    } catch {
        elements.error.hidden = false;
        elements.retry.hidden = false;
    } finally {
        elements.loading.hidden = true;
        elements.loading.setAttribute('aria-busy', 'false');
        elements.section.setAttribute('aria-busy', 'false');
        recommendationRequestPending = false;
    }
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

    void loadStudentRecommendations();
    const recommendationsRetry = document.getElementById('recommendations-retry');
    if (recommendationsRetry) recommendationsRetry.addEventListener('click', loadStudentRecommendations);

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
