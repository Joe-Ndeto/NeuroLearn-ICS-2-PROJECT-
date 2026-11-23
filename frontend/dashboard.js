'use strict';

const api = window.NeuroLearnApi;
const roleRouting = window.NeuroLearnRoleRouting;

const SELECTED_COURSE_KEY = 'neurolearn.selectedCourseId';

let selectedCourseId = '';
let progressRequestVersion = 0;
let recommendationRequestVersion = 0;
let reviewGapsRequestVersion = 0;

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
        title: document.getElementById('student-recommendations-title'),
        intro: document.getElementById('recommendations-intro'),
        loading: document.getElementById('recommendations-loading'),
        empty: document.getElementById('recommendations-empty'),
        error: document.getElementById('recommendations-error'),
        list: document.getElementById('recommendations-list'),
        retry: document.getElementById('recommendations-retry')
    };
}

function getProgressElements() {
    return {
        container: document.getElementById('dashboard-progress-feedback'),
        loading: document.getElementById('dashboard-progress-loading'),
        empty: document.getElementById('dashboard-progress-empty'),
        error: document.getElementById('dashboard-progress-error'),
        retry: document.getElementById('dashboard-progress-retry'),
        overall: document.getElementById('overall-progress'),
        bar: document.getElementById('overall-progress-bar'),
        completed: document.getElementById('courses-completed'),
        mastery: document.getElementById('mastery-level'),
        masteryStatus: document.getElementById('mastery-status')
    };
}

function getReviewGapElements() {
    return {
        button: document.getElementById('review-gaps-button'),
        panel: document.getElementById('review-gaps-panel'),
        close: document.getElementById('review-gaps-close'),
        loading: document.getElementById('review-gaps-loading'),
        empty: document.getElementById('review-gaps-empty'),
        error: document.getElementById('review-gaps-error'),
        retry: document.getElementById('review-gaps-retry'),
        list: document.getElementById('review-gaps-list')
    };
}

function apiErrorMessage(error, fallback) {
    return error?.name === 'ApiError' && typeof error.message === 'string' && error.message.trim()
        ? error.message
        : fallback;
}

function validCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function selectedCourseQuery() {
    if (!selectedCourseId) return '';
    return `?courseId=${encodeURIComponent(selectedCourseId)}`;
}

function appendRecommendationText(documentRef, parent, tagName, className, value) {
    const element = documentRef.createElement(tagName);
    if (className) element.className = className;
    element.textContent = value;
    parent.appendChild(element);
    return element;
}

function recommendationLearningStatus(mastery) {
    if (typeof mastery !== 'number' || !Number.isFinite(mastery)) return 'Not started';
    return mastery >= 85 ? 'Mastered' : 'In progress';
}

function renderRecommendation(documentRef, recommendation, recommendationMode) {
    if (!recommendation || !Number.isSafeInteger(recommendation.conceptId) ||
        recommendation.conceptId < 1 ||
        typeof recommendation.conceptName !== 'string' ||
        !recommendation.conceptName.trim() ||
        !(recommendation.mastery === null ||
            (typeof recommendation.mastery === 'number' &&
                Number.isFinite(recommendation.mastery) &&
                recommendation.mastery >= 0 && recommendation.mastery <= 100))) {
        throw new Error('Invalid recommendation response.');
    }

    const card = documentRef.createElement('article');
    card.className = 'recommendation-card';

    appendRecommendationText(
        documentRef, card, 'h3', 'recommendation-title', recommendation.conceptName
    );

    const readiness = recommendation.prerequisiteReadiness;
    const hasPrerequisites = readiness?.satisfied === true &&
        Number.isSafeInteger(readiness.totalCount) && readiness.totalCount > 0;

    appendRecommendationText(
        documentRef,
        card,
        'span',
        'recommendation-status',
        `Learning status: ${recommendationLearningStatus(recommendation.mastery)}`
    );

    let explanation;

    if (recommendationMode === 'cold_start') {
        explanation = hasPrerequisites
            ? 'Build your understanding of this topic before moving on to more advanced concepts.'
            : 'Start here: this is a foundational topic for your course.';
    } else if (recommendation.mastery === null) {
        explanation = 'This topic is ready for you to begin.';
    } else {
        explanation = 'This topic is a useful next step based on your learning progress.';
    }

    appendRecommendationText(
        documentRef,
        card,
        'p',
        'recommendation-explanation',
        `Why this is recommended: ${explanation}`
    );

    if (hasPrerequisites) {
        appendRecommendationText(
            documentRef,
            card,
            'p',
            'recommendation-readiness-summary',
            'The earlier topics needed for this concept are ready.'
        );
    }

    const action = documentRef.createElement('a');
    action.className = 'btn-primary recommendation-action';

    action.href = selectedCourseId
        ? `study.html?courseId=${encodeURIComponent(selectedCourseId)}`
        : 'study.html';

    action.textContent = 'Start learning';
    card.appendChild(action);

    return card;
}

function conceptGapCategory(concept) {
    // Use learner-facing assessment counts and mastery, not internal evidence labels.
    if (concept.assessmentCount === 0 && concept.mastery === null) {
        return 'not-assessed';
    }

    if (concept.assessmentCount === 1 && typeof concept.mastery === 'number') {
        return 'more-evidence';
    }

    if (concept.assessmentCount >= 2 && typeof concept.mastery === 'number') {
        return concept.mastery >= 85 ? 'mastered' : 'improvement';
    }

    throw new Error('Invalid concept assessment data in review gaps response.');
}

function renderReviewGap(documentRef, concept) {
    if (!concept || !Number.isSafeInteger(concept.conceptId) ||
        concept.conceptId < 1 ||
        typeof concept.conceptName !== 'string' ||
        !concept.conceptName.trim() ||
        !(concept.mastery === null ||
            (typeof concept.mastery === 'number' &&
                Number.isFinite(concept.mastery) &&
                concept.mastery >= 0 && concept.mastery <= 100)) ||
        !Number.isSafeInteger(concept.assessmentCount) ||
        concept.assessmentCount < 0 ||
        !Array.isArray(concept.prerequisites)) {
        throw new Error('Invalid concept data in review gaps response.');
    }

    const category = conceptGapCategory(concept);

    const labels = {
        'not-assessed': 'Not assessed',
        'more-evidence': 'Needs more evidence',
        improvement: 'Needs improvement',
        mastered: 'Mastered'
    };

    const card = documentRef.createElement('article');
    card.className = 'review-gap-card';

    appendRecommendationText(
        documentRef, card, 'h4', 'review-gap-title', concept.conceptName
    );

    appendRecommendationText(
        documentRef, card, 'span', 'recommendation-status', labels[category]
    );

    appendRecommendationText(
        documentRef,
        card,
        'p',
        'review-gap-mastery',
        concept.mastery === null
            ? 'Current mastery: Not assessed'
            : `Current mastery: ${concept.mastery.toFixed(2)}%`
    );

    const explanations = {
        'not-assessed': 'No assessment evidence is recorded for this concept yet.',
        'more-evidence': `There is evidence from ${concept.assessmentCount} assessment; more is needed to confirm mastery.`,
        improvement: 'There is enough assessment evidence to estimate mastery, and the current level is below 85%.',
        mastered: 'Mastery is at least 85% and supported by evidence from multiple assessments.'
    };

    appendRecommendationText(
        documentRef, card, 'p', 'review-gap-explanation', explanations[category]
    );

    const unmet = concept.prerequisites.filter(prerequisite => {
        if (!prerequisite ||
            typeof prerequisite.conceptName !== 'string' ||
            !(prerequisite.mastery === null ||
                (typeof prerequisite.mastery === 'number' &&
                    Number.isFinite(prerequisite.mastery) &&
                    prerequisite.mastery >= 0 && prerequisite.mastery <= 100)) ||
            typeof prerequisite.satisfied !== 'boolean') {
            throw new Error('Invalid prerequisite data in review gaps response.');
        }

        return prerequisite.satisfied !== true;
    });

    if (unmet.length) {
        appendRecommendationText(
            documentRef,
            card,
            'p',
            'review-gap-prerequisites',
            `Unmet prerequisites: ${unmet.map(item => item.conceptName).join(', ')}.`
        );
    }

    const action = documentRef.createElement('a');
    action.className = 'btn-primary review-gap-action';

    action.href = selectedCourseId
        ? `study.html?courseId=${encodeURIComponent(selectedCourseId)}`
        : 'study.html';

    action.textContent = 'Open Study Workspace';
    card.appendChild(action);

    return { category, card };
}

function updateKnowledgeGapSummary(concepts) {
    if (!Array.isArray(concepts)) {
        throw new Error('Review gap data is unavailable.');
    }

    const renderedCategories = concepts.map(concept => conceptGapCategory(concept));
    const gapCount = renderedCategories.filter(category => category !== 'mastered').length;

    const countElement = document.getElementById('knowledge-gaps-count');

    if (countElement) {
        countElement.textContent = gapCount === 0
            ? concepts.length ? 'No current gaps' : 'No concepts available'
            : `${gapCount} concept${gapCount === 1 ? '' : 's'} to review`;
    }

    const summary = document.getElementById('knowledge-gaps-list');
    if (!summary) return;

    const categoryLabels = [
        ['not-assessed', 'Not assessed'],
        ['more-evidence', 'Needs more evidence'],
        ['improvement', 'Needs improvement']
    ];

    const tags = categoryLabels
        .map(([category, label]) => [
            label,
            renderedCategories.filter(item => item === category).length
        ])
        .filter(([, count]) => count > 0)
        .map(([label, count]) => {
            const tag = document.createElement('span');
            tag.className = 'gap-tag';
            tag.textContent = `${label}: ${count}`;
            return tag;
        });

    summary.replaceChildren(...tags);

    if (!tags.length) {
        appendRecommendationText(
            document,
            summary,
            'span',
            'gap-tag',
            concepts.length ? 'All approved concepts are mastered' : 'No approved concepts yet'
        );
    }
}

function renderReviewGaps(response, elements) {
    const concepts = response?.concepts;
    const courseEligibility = response?.coursePrerequisiteEligibility;

    if (!Array.isArray(concepts) ||
        !courseEligibility ||
        typeof courseEligibility.eligible !== 'boolean' ||
        !Array.isArray(courseEligibility.prerequisites) ||
        courseEligibility.prerequisites.some(item =>
            !item || typeof item.title !== 'string' ||
            typeof item.satisfied !== 'boolean')) {
        throw new Error('Review gap data is unavailable.');
    }

    const rendered = concepts.map(concept => renderReviewGap(document, concept));

    const categoryLabels = [
        ['not-assessed', 'Not assessed'],
        ['more-evidence', 'Needs more evidence'],
        ['improvement', 'Needs improvement'],
        ['mastered', 'Mastered']
    ];

    const groups = [];

    for (const [category, label] of categoryLabels) {
        const cards = rendered
            .filter(item => item.category === category)
            .map(item => item.card);

        if (!cards.length) continue;

        const group = document.createElement('section');
        group.className = 'review-gap-group';

        appendRecommendationText(
            document, group, 'h3', 'review-gap-group-title',
            `${label} (${cards.length})`
        );

        const list = document.createElement('div');
        list.className = 'review-gap-group-list';
        list.replaceChildren(...cards);
        group.appendChild(list);
        groups.push(group);
    }

    const coursePrerequisites = courseEligibility.prerequisites
        .filter(item => item.satisfied === false);

    if (coursePrerequisites.length) {
        const notice = document.createElement('p');
        notice.className = 'review-gap-course-prerequisites';
        notice.textContent =
            `Unmet course prerequisites: ${coursePrerequisites.map(item => item.title).join(', ')}. Course-level prerequisites are separate from concept prerequisites.`;

        elements.list.replaceChildren(notice, ...groups);
    } else {
        elements.list.replaceChildren(...groups);
    }

    elements.empty.textContent = concepts.length
        ? ''
        : 'No approved concepts are currently associated with this course.';

    elements.empty.hidden = concepts.length !== 0;

    updateKnowledgeGapSummary(concepts);
}

async function loadStudentProgress() {
    const elements = getProgressElements();

    if (!elements.container || !elements.loading || !elements.empty ||
        !elements.error || !elements.retry || !elements.overall ||
        !elements.bar || !elements.completed || !elements.mastery ||
        !elements.masteryStatus) {
        return;
    }

    const requestVersion = ++progressRequestVersion;

    elements.container.setAttribute('aria-busy', 'true');
    elements.loading.hidden = false;
    elements.loading.setAttribute('aria-busy', 'true');
    elements.empty.hidden = true;
    elements.error.hidden = true;
    elements.retry.hidden = true;

    try {
        const response = selectedCourseId
            ? await api.get(`/learners/me/progress?courseId=${encodeURIComponent(selectedCourseId)}`)
            : await api.get('/learners/me/progress');

        if (requestVersion !== progressRequestVersion) return;

        const progress = response?.progress;
        const mastery = response?.mastery;

        if (response?.success !== true ||
            !validCount(progress?.masteredConcepts) ||
            !validCount(progress?.totalConcepts) ||
            progress.masteredConcepts > progress.totalConcepts ||
            typeof progress.percentage !== 'number' ||
            !Number.isFinite(progress.percentage) ||
            progress.percentage < 0 || progress.percentage > 100 ||
            !(mastery?.percentage === null ||
                (typeof mastery?.percentage === 'number' &&
                    Number.isFinite(mastery.percentage) &&
                    mastery.percentage >= 0 && mastery.percentage <= 100)) ||
            typeof mastery?.status !== 'string' ||
            !validCount(mastery?.assessedConcepts)) {
            throw new Error('Invalid learner progress response.');
        }

        elements.overall.textContent = `${progress.percentage.toFixed(2)}%`;
        elements.bar.style.width = `${progress.percentage}%`;

        elements.completed.textContent = progress.totalConcepts === 0
            ? 'No course concepts are available yet'
            : `${progress.masteredConcepts} mastered · ${progress.totalConcepts - progress.masteredConcepts} still requiring work (${progress.totalConcepts} total)`;

        elements.mastery.textContent = mastery.percentage === null
            ? 'Not assessed yet'
            : `${mastery.percentage.toFixed(2)}%`;

        elements.masteryStatus.textContent = mastery.percentage === null || mastery.assessedConcepts === 0
            ? 'Complete a quiz to begin tracking mastery'
            : mastery.assessedConcepts >= 2
                ? 'Your learning progress is being tracked across assessments'
                : 'Early estimate based on your assessed concepts';

        elements.empty.hidden = progress.totalConcepts !== 0;
    } catch (error) {
        if (requestVersion !== progressRequestVersion) return;

        elements.error.textContent = apiErrorMessage(
            error, 'Progress could not be loaded. Please try again.'
        );

        elements.error.hidden = false;
        elements.retry.hidden = false;
    } finally {
        if (requestVersion === progressRequestVersion) {
            elements.loading.hidden = true;
            elements.loading.setAttribute('aria-busy', 'false');
            elements.container.setAttribute('aria-busy', 'false');
        }
    }
}

async function loadReviewGaps() {
    const elements = getReviewGapElements();

    if (!elements.panel || !elements.loading || !elements.empty ||
        !elements.error || !elements.retry || !elements.list) {
        return;
    }

    const requestVersion = ++reviewGapsRequestVersion;

    elements.panel.hidden = false;

    if (elements.button) {
        elements.button.setAttribute('aria-expanded', 'true');
    }

    elements.panel.setAttribute('aria-busy', 'true');
    elements.loading.hidden = false;
    elements.loading.setAttribute('aria-busy', 'true');
    elements.empty.hidden = true;
    elements.error.hidden = true;
    elements.retry.hidden = true;

    try {
        const response = selectedCourseId
            ? await api.get(`/recommendations/me?courseId=${encodeURIComponent(selectedCourseId)}`)
            : await api.get('/recommendations/me');

        if (requestVersion !== reviewGapsRequestVersion) return;

        if (!response || response.success !== true ||
            !Array.isArray(response.concepts)) {
            throw new Error('Invalid review gaps response.');
        }

        renderReviewGaps(response, elements);
    } catch (error) {
        if (requestVersion !== reviewGapsRequestVersion) return;

        elements.error.textContent = apiErrorMessage(
            error, 'Knowledge gaps could not be loaded. Please try again.'
        );

        elements.error.hidden = false;
        elements.retry.hidden = false;
    } finally {
        if (requestVersion === reviewGapsRequestVersion) {
            elements.loading.hidden = true;
            elements.loading.setAttribute('aria-busy', 'false');
            elements.panel.setAttribute('aria-busy', 'false');
        }
    }
}

async function loadStudentRecommendations() {
    const elements = getRecommendationElements();

    if (!elements.section || !elements.title || !elements.intro ||
        !elements.loading || !elements.empty || !elements.error ||
        !elements.list || !elements.retry) {
        return;
    }

    const requestVersion = ++recommendationRequestVersion;

    elements.section.setAttribute('aria-busy', 'true');
    elements.loading.hidden = false;
    elements.loading.setAttribute('aria-busy', 'true');
    elements.empty.hidden = true;
    elements.error.hidden = true;
    elements.retry.hidden = true;
    elements.list.replaceChildren();

    try {
        const response = selectedCourseId
            ? await api.get(`/recommendations/me?courseId=${encodeURIComponent(selectedCourseId)}`)
            : await api.get('/recommendations/me');

        if (requestVersion !== recommendationRequestVersion) return;

        if (!response || response.success !== true ||
            !Array.isArray(response.recommendations) ||
            !Array.isArray(response.concepts) ||
            !['cold_start', 'adaptive', 'course_prerequisite_blocked'].includes(
                response.recommendationMode
            )) {
            throw new Error('Invalid recommendation response.');
        }

        updateKnowledgeGapSummary(response.concepts);

        const coldStart = response.recommendationMode === 'cold_start';
        const prerequisiteBlocked =
            response.recommendationMode === 'course_prerequisite_blocked';

        elements.title.textContent = prerequisiteBlocked
            ? 'Course prerequisites need attention'
            : coldStart
                ? 'Recommended topics to get started'
                : 'Recommended next concepts';

        const unmetCoursePrerequisites =
            Array.isArray(response.coursePrerequisiteEligibility?.prerequisites)
                ? response.coursePrerequisiteEligibility.prerequisites
                    .filter(item => item?.satisfied === false)
                : [];

        elements.intro.textContent = prerequisiteBlocked
            ? `Complete the required earlier course learning before starting these recommendations.${unmetCoursePrerequisites.length
                ? ` Required first: ${unmetCoursePrerequisites.map(item => item.title).join(', ')}.`
                : ''}`
            : coldStart
                ? 'Begin with these foundational topics. Complete a lesson and take an assessment to receive personalized recommendations.'
                : 'Suggestions based on your learning progress.';

        if (response.recommendations.length === 0) {
            elements.empty.textContent = prerequisiteBlocked
                ? 'Recommendations are paused until the required course prerequisites are satisfied.'
                : coldStart
                    ? 'No foundational topics are ready yet. Check back after your course concepts and prerequisites are available.'
                    : 'No next topics are ready right now. Keep studying and complete assessments to refresh your recommendations.';

            elements.empty.hidden = false;
        } else {
            const cards = response.recommendations.map(recommendation =>
                renderRecommendation(
                    document, recommendation, response.recommendationMode
                )
            );

            elements.list.replaceChildren(...cards);
        }
    } catch (error) {
        if (requestVersion !== recommendationRequestVersion) return;

        elements.error.textContent = apiErrorMessage(
            error, 'Recommendations could not be loaded. Please try again.'
        );

        elements.error.hidden = false;
        elements.retry.hidden = false;

        const gapCount = document.getElementById('knowledge-gaps-count');
        const gapSummary = document.getElementById('knowledge-gaps-list');

        if (gapCount) gapCount.textContent = 'Knowledge gaps unavailable';

        if (gapSummary) {
            gapSummary.replaceChildren();

            appendRecommendationText(
                document, gapSummary, 'span', 'gap-tag',
                'Open Review Gaps to retry.'
            );
        }
    } finally {
        if (requestVersion === recommendationRequestVersion) {
            elements.loading.hidden = true;
            elements.loading.setAttribute('aria-busy', 'false');
            elements.section.setAttribute('aria-busy', 'false');
        }
    }
}

async function loadDashboardCourses() {
    const selector = document.getElementById('dashboard-course-selector');
    const message = document.getElementById('dashboard-course-message');

    if (!selector) return;

    selector.disabled = true;
    selector.replaceChildren();

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Loading your courses...';
    selector.appendChild(placeholder);

    try {
        const response = await api.get('/submissions/resource-options');

        if (response?.success !== true || !Array.isArray(response.courses)) {
            throw new Error('Course list is unavailable.');
        }

        const courses = response.courses
            .map(course => ({
                id: course?.courseId ?? course?.course_id,
                name: course?.name
            }))
            .filter(course =>
                typeof course.id === 'string' && course.id.trim() &&
                typeof course.name === 'string' && course.name.trim()
            );

        selector.replaceChildren();

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = courses.length
            ? 'Select a course'
            : 'No approved courses available';

        selector.appendChild(defaultOption);

        for (const course of courses) {
            const option = document.createElement('option');
            option.value = course.id;
            option.textContent = course.name.trim();
            selector.appendChild(option);
        }

        const query = typeof window.location?.search === 'string'
            ? window.location.search.replace(/^\?/, '')
            : '';

        const urlCourseId = query.split('&')
            .map(part => part.split('='))
            .find(([key]) => key === 'courseId')?.[1];

        const decodedUrlCourseId = urlCourseId
            ? decodeURIComponent(urlCourseId.replace(/\+/g, ' '))
            : '';

        let preferredCourseId = decodedUrlCourseId || '';

        if (!preferredCourseId) {
            try {
                preferredCourseId = localStorage.getItem(SELECTED_COURSE_KEY) || '';
            } catch {
                preferredCourseId = '';
            }
        }

        const preferredExists = courses.some(
            course => course.id === preferredCourseId
        );

        selectedCourseId = preferredExists
            ? preferredCourseId
            : courses[0]?.id || '';

        selector.value = selectedCourseId;

        if (selectedCourseId) {
            try {
                localStorage.setItem(SELECTED_COURSE_KEY, selectedCourseId);
            } catch {
                // The dashboard can still operate if browser storage is unavailable.
            }
        }

        selector.disabled = courses.length === 0;

        if (message) {
            message.textContent = courses.length
                ? 'Choose a course to view its progress and recommendations.'
                : 'No approved courses are available yet.';
        }
    } catch (error) {
        selector.replaceChildren();

        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Courses could not be loaded';
        selector.appendChild(option);

        selector.disabled = true;

        if (message) {
            message.textContent = apiErrorMessage(
                error, 'Courses could not be loaded. Refresh the dashboard and try again.'
            );
        }

        throw error;
    }
}

function handleCourseChange(event) {
    selectedCourseId = event.target.value || '';

    try {
        if (selectedCourseId) {
            localStorage.setItem(SELECTED_COURSE_KEY, selectedCourseId);
        } else {
            localStorage.removeItem(SELECTED_COURSE_KEY);
        }
    } catch {
        // Continue with the in-memory selection if storage is unavailable.
    }

    const message = document.getElementById('dashboard-course-message');

    if (message) {
        message.textContent = selectedCourseId
            ? 'Course selected. Updating your learning dashboard...'
            : 'Select a course to view its progress and recommendations.';
    }

    void refreshCourseDashboard();
}

async function refreshCourseDashboard() {
    await Promise.all([
        loadStudentRecommendations(),
        loadStudentProgress()
    ]);

    const reviewPanel = document.getElementById('review-gaps-panel');

    if (reviewPanel && !reviewPanel.hidden) {
        await loadReviewGaps();
    }

    const message = document.getElementById('dashboard-course-message');

    if (message && selectedCourseId) {
        message.textContent = 'Your dashboard is showing the selected course.';
    }
}

/*
 * COURSE SELECTOR FIX
 *
 * Bind the event listener before asynchronous session validation.
 * This ensures the selector is ready when the user interacts with it.
 * The dataset flag prevents duplicate event listeners.
 */
function bindDashboardCourseSelector() {
    const selector = document.getElementById('dashboard-course-selector');

    if (!selector || selector.tagName !== 'SELECT') {
        return false;
    }

    if (selector.dataset.courseChangeBound !== 'true') {
        selector.addEventListener('change', handleCourseChange);
        selector.dataset.courseChangeBound = 'true';
    }

    return true;
}

async function initializeDashboard() {
    // Register the course selector listener immediately.
    bindDashboardCourseSelector();

    const header = document.getElementById('student-header');
    const content = document.getElementById('student-dashboard-content');
    const sessionMessage = document.getElementById('dashboard-session-message');

    const result = await roleRouting.validateAndRoute({
        api,
        location: window.location,
        expectedRole: 'student',
        onUnavailable(message) {
            if (window.NeuroLearnLoading?.showMessage) {
                window.NeuroLearnLoading.showMessage(sessionMessage, message);
            } else if (sessionMessage) {
                sessionMessage.textContent = message;
            }
        }
    });

    if (!result.ok) return;

    document.body.dataset.role = 'student';

    if (header) header.hidden = false;
    if (content) content.hidden = false;

    const recommendationsRetry = document.getElementById('recommendations-retry');

    if (recommendationsRetry) {
        recommendationsRetry.addEventListener(
            'click', loadStudentRecommendations
        );
    }

    const progressRetry = document.getElementById('dashboard-progress-retry');

    if (progressRetry) {
        progressRetry.addEventListener('click', loadStudentProgress);
    }

    const gapsButton = document.getElementById('review-gaps-button');
    const gapsClose = document.getElementById('review-gaps-close');
    const gapsRetry = document.getElementById('review-gaps-retry');

    if (gapsButton) {
        gapsButton.disabled = false;

        gapsButton.addEventListener('click', () => {
            void loadReviewGaps();
        });
    }

    if (gapsClose) {
        gapsClose.addEventListener('click', () => {
            const panel = document.getElementById('review-gaps-panel');

            if (panel) panel.hidden = true;
            if (gapsButton) gapsButton.setAttribute('aria-expanded', 'false');
        });
    }

    if (gapsRetry) {
        gapsRetry.addEventListener('click', () => {
            void loadReviewGaps();
        });
    }

    // Recheck and bind after session validation in case the page was rendered dynamically.
    const hasCourseSelector = bindDashboardCourseSelector();

    if (hasCourseSelector) {
        try {
            await loadDashboardCourses();
        } catch {
            // The course selector displays its own error message.
        }

        if (selectedCourseId) {
            void refreshCourseDashboard();
        } else {
            const recommendationElements = getRecommendationElements();

            if (recommendationElements.empty) {
                recommendationElements.empty.textContent =
                    'Select an approved course to view your recommendations.';
                recommendationElements.empty.hidden = false;
            }

            const progressElements = getProgressElements();

            if (progressElements.empty) {
                progressElements.empty.textContent =
                    'Select an approved course to view your progress.';
                progressElements.empty.hidden = false;
            }
        }
    } else {
        // Backward-compatible default: pages without a course selector use the API's default course.
        void loadStudentRecommendations();
        void loadStudentProgress();
    }

    try {
        await loadStudentContributionModule();
    } catch {
        if (sessionMessage) {
            sessionMessage.hidden = false;

            if (window.NeuroLearnLoading?.showMessage) {
                window.NeuroLearnLoading.showMessage(
                    sessionMessage,
                    'Student contribution tools could not be loaded. Refresh the page to try again.'
                );
            } else {
                sessionMessage.textContent =
                    'Student contribution tools could not be loaded. Refresh the page to try again.';
            }
        }

        return;
    }

    if (sessionMessage) {
        sessionMessage.hidden = true;
        sessionMessage.setAttribute('aria-busy', 'false');
    }

    window.NeuroLearnContributions.initializeKnowledgeContributions({
        document,
        api
    });

    const learnerName = document.getElementById('learner-name');

    if (learnerName && result.learner.username) {
        learnerName.textContent = result.learner.username;
    }
}

/*
 * STARTUP
 *
 * Register global dashboard controls only after the DOM is ready.
 */
function startDashboard() {
    const logoutButton = document.getElementById('logout-button');

    if (logoutButton && logoutButton.dataset.logoutBound !== 'true') {
        logoutButton.addEventListener('click', () => api.clearSession());
        logoutButton.dataset.logoutBound = 'true';
    }

    const studyWorkspaceButton = document.getElementById('open-study-workspace');

    if (studyWorkspaceButton && studyWorkspaceButton.dataset.studyBound !== 'true') {
        studyWorkspaceButton.addEventListener('click', () => {
            window.location.href = selectedCourseId
                ? `study.html?courseId=${encodeURIComponent(selectedCourseId)}`
                : 'study.html';
        });

        studyWorkspaceButton.dataset.studyBound = 'true';
    }

    void initializeDashboard().catch(error => {
        console.error('Dashboard initialization failed:', error);

        const sessionMessage = document.getElementById('dashboard-session-message');

        if (sessionMessage) {
            sessionMessage.hidden = false;
            sessionMessage.textContent =
                'The dashboard could not be initialized. Refresh the page to try again.';
        }
    });
}

// Wait until the dashboard HTML exists before attaching listeners.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startDashboard, { once: true });
} else {
    startDashboard();
}