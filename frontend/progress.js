
'use strict';

/* =========================================
   NEUROLEARN - PROGRESS PAGE
========================================= */

const api = window.NeuroLearnApi;
const roleRouting = window.NeuroLearnRoleRouting;

const SELECTED_COURSE_KEY = 'neurolearn.selectedCourseId';

const elements = {
    header: document.getElementById('student-header'),
    content: document.getElementById('progress-content'),
    sessionMessage: document.getElementById('progress-session-message'),
    learnerName: document.getElementById('learner-name'),
    logoutButton: document.getElementById('logout-button'),

    courseFilter: document.getElementById('progress-course-filter'),
    refreshButton: document.getElementById('refresh-progress'),
    status: document.getElementById('progress-status'),

    overview: document.getElementById('course-overview-content'),
    mastery: document.getElementById('mastery-summary-content'),
    concepts: document.getElementById('concept-progression-content'),
    prerequisites: document.getElementById('prerequisite-eligibility-content')
};

let learner = null;
let courses = [];
let isLoading = false;

/* =========================================
   DOM HELPERS
========================================= */

function createElement(tag, className, text) {
    const element = document.createElement(tag);

    if (className) {
        element.className = className;
    }

    if (text !== undefined && text !== null) {
        element.textContent = String(text);
    }

    return element;
}

function displayStatus(message) {
    elements.status.textContent = message || '';
}

function showEmptyState(container, heading, message) {
    const card = createElement('div', 'progress-empty-state');

    card.appendChild(createElement('h3', '', heading));
    card.appendChild(createElement('p', '', message));

    container.replaceChildren(card);
}

function formatPercentage(value) {
    if (value === null || value === undefined ||
        !Number.isFinite(value)) {
        return 'Not available';
    }

    return `${value.toFixed(1)}%`;
}

function validMastery(value) {
    return value === null ||
        (typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 100);
}

function createProgressBar(value) {
    const percentage = Number.isFinite(value)
        ? Math.min(100, Math.max(0, value))
        : 0;

    const wrapper = createElement('div');

    const track = createElement('div', 'progress-track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(percentage));
    track.setAttribute('aria-label', 'Learning progress');

    const fill = createElement('div', 'progress-fill');

    fill.style.width = `${percentage}%`;

    if (percentage >= 100) {
        fill.classList.add('is-complete');
    }

    track.appendChild(fill);

    const caption = createElement('div', 'progress-bar-caption');
    caption.appendChild(createElement('span', '', 'Progress'));
    caption.appendChild(createElement('strong', '', formatPercentage(value)));

    wrapper.append(track, caption);

    return wrapper;
}

function createOverviewCard(label, value, description) {
    const card = createElement('article', 'progress-overview-card');

    card.appendChild(createElement('p', 'progress-card-label', label));
    card.appendChild(createElement('div', 'progress-card-value', value));
    card.appendChild(
        createElement('p', 'progress-card-description', description)
    );

    return card;
}

function createSummaryCard(label, value, description) {
    const card = createElement('article', 'progress-summary-card');

    card.appendChild(createElement('h3', '', label));
    card.appendChild(createElement('strong', '', value));
    card.appendChild(createElement('p', '', description));

    return card;
}

/* =========================================
   COURSE LOADING
========================================= */

async function loadCourses() {
    const response = await api.get('/submissions/resource-options');

    if (response?.success !== true ||
        !Array.isArray(response.courses)) {
        throw new Error('Approved courses could not be loaded.');
    }

    courses = response.courses
        .map(course => ({
            courseId: course.courseId ?? course.course_id,
            name: course.name || course.courseName || 'Unnamed course'
        }))
        .filter(course =>
            typeof course.courseId === 'string' &&
            course.courseId.trim() !== ''
        );

    const urlCourseId = new URLSearchParams(
        window.location.search
    ).get('courseId');

    const savedCourseId = localStorage.getItem(SELECTED_COURSE_KEY);

    const previousSelection = urlCourseId || savedCourseId || '';

    elements.courseFilter.replaceChildren();

    if (!courses.length) {
        const option = createElement('option', '', 'No approved courses');
        option.value = '';
        elements.courseFilter.appendChild(option);
        elements.courseFilter.disabled = true;
        return;
    }

    elements.courseFilter.disabled = false;

    courses.forEach(course => {
        const option = createElement('option', '', course.name);
        option.value = String(course.courseId);
        elements.courseFilter.appendChild(option);
    });

    const selectionExists = courses.some(
        course => String(course.courseId) === previousSelection
    );

    elements.courseFilter.value = selectionExists
        ? previousSelection
        : String(courses[0].courseId);

    localStorage.setItem(
        SELECTED_COURSE_KEY,
        elements.courseFilter.value
    );
}

/* =========================================
   COURSE OVERVIEW
========================================= */

function renderCourseOverview(response) {
    const progress = response?.progress;
    const completion = response?.courseCompletion;

    if (!progress ||
        !Number.isFinite(progress.percentage) ||
        !Number.isSafeInteger(progress.masteredConcepts) ||
        !Number.isSafeInteger(progress.totalConcepts)) {
        throw new Error('Invalid course progress data.');
    }

    elements.overview.replaceChildren();

    const progressCard = createElement('article', 'progress-overview-card');

    progressCard.appendChild(
        createElement('p', 'progress-card-label', 'Overall Course Progress')
    );

    progressCard.appendChild(
        createElement(
            'div',
            'progress-card-value',
            formatPercentage(progress.percentage)
        )
    );

    progressCard.appendChild(
        createElement(
            'p',
            'progress-card-description',
            'Average mastery across all course concepts, including unassessed concepts as zero.'
        )
    );

    progressCard.appendChild(createProgressBar(progress.percentage));

    const masteredCard = createOverviewCard(
        'Mastered Concepts',
        `${progress.masteredConcepts} / ${progress.totalConcepts}`,
        'Concepts that have achieved the required mastery and assessment evidence.'
    );

    elements.overview.append(progressCard, masteredCard);

    if (completion) {
        const completionCard = createOverviewCard(
            'Course Completion',
            completion.complete ? 'Complete' : 'In Progress',
            `${completion.masteredConcepts} of ${completion.totalConcepts} concepts mastered.`
        );

        elements.overview.appendChild(completionCard);
    }
}

/* =========================================
   MASTERY SUMMARY
========================================= */

function renderMasterySummary(response) {
    const mastery = response?.mastery;
    const progress = response?.progress;

    if (!mastery ||
        !Number.isSafeInteger(mastery.assessedConcepts) ||
        !Number.isSafeInteger(mastery.totalConcepts) ||
        !validMastery(mastery.percentage)) {
        throw new Error('Invalid mastery summary data.');
    }

    const mastered = progress.masteredConcepts;
    const assessed = mastery.assessedConcepts;
    const total = mastery.totalConcepts;
    const notMastered = Math.max(0, total - mastered);

    elements.mastery.replaceChildren();

    elements.mastery.append(
        createSummaryCard(
            'Mastered',
            mastered,
            'Concepts that meet the mastery and evidence requirements.'
        ),
        createSummaryCard(
            'Assessed',
            assessed,
            'Concepts with assessment evidence.'
        ),
        createSummaryCard(
            'Not Yet Mastered',
            notMastered,
            'Concepts that have not yet met the mastery requirements.'
        ),
        createSummaryCard(
            'Assessed Mastery Average',
            formatPercentage(mastery.percentage),
            'Average mastery among assessed concepts only.'
        ),
        createSummaryCard(
            'Mastery Status',
            mastery.status || 'Unknown',
            'Current evidence qualification status.'
        )
    );
}

/* =========================================
   CONCEPT PROGRESSION
========================================= */

function renderConceptCard(concept, courseId) {
    if (!concept ||
        !Number.isSafeInteger(concept.conceptId) ||
        typeof concept.conceptName !== 'string' ||
        typeof concept.accessible !== 'boolean' ||
        concept.status !== (concept.accessible ? 'UNLOCKED' : 'LOCKED') ||
        !validMastery(concept.mastery) ||
        !Array.isArray(concept.prerequisites)) {
        throw new Error('Invalid concept progression data.');
    }

    const card = createElement(
        'article',
        `progress-concept-card ${concept.accessible ? '' : 'is-locked'}`
    );

    const header = createElement('div', 'progress-concept-header');

    header.appendChild(
        createElement('h3', '', concept.conceptName)
    );

    const status = createElement(
        'span',
        `progress-tag ${concept.accessible ? '' : 'is-locked'}`,
        concept.accessible ? 'Unlocked' : 'Locked'
    );

    header.appendChild(status);
    card.appendChild(header);

    card.appendChild(
        createElement(
            'p',
            'progress-concept-description',
            concept.mastery === null
                ? 'Mastery has not yet been assessed.'
                : `Current mastery: ${formatPercentage(concept.mastery)}`
        )
    );

    if (concept.mastery !== null) {
        card.appendChild(createProgressBar(concept.mastery));
    }

    if (concept.message) {
        card.appendChild(
            createElement(
                'p',
                'progress-concept-description',
                concept.message
            )
        );
    }

    if (concept.prerequisites.length) {
        const prerequisiteHeading = createElement(
            'p',
            'progress-concept-description',
            'Concept prerequisites:'
        );

        const list = createElement('ul');

        concept.prerequisites.forEach(prerequisite => {
            if (!prerequisite ||
                typeof prerequisite.conceptName !== 'string' ||
                typeof prerequisite.satisfied !== 'boolean' ||
                !validMastery(prerequisite.mastery)) {
                throw new Error('Invalid concept prerequisite data.');
            }

            const masteryText = prerequisite.mastery === null
                ? 'Not assessed'
                : formatPercentage(prerequisite.mastery);

            const item = createElement(
                'li',
                '',
                `${prerequisite.satisfied ? 'Satisfied' : 'Outstanding'}: ${prerequisite.conceptName} — ${masteryText}`
            );

            list.appendChild(item);
        });

        card.append(prerequisiteHeading, list);
    }

    if (concept.revisionTarget?.conceptName) {
        card.appendChild(
            createElement(
                'p',
                'progress-concept-description',
                `Revision target: ${concept.revisionTarget.conceptName}`
            )
        );
    }

    const tags = createElement('div', 'progress-concept-meta');

    if (concept.accessible) {
        tags.appendChild(
            createElement('span', 'progress-tag', 'Ready to study')
        );

        const action = createElement('a', 'progress-tag', 'Open Study Workspace');

        action.href = `study.html?courseId=${encodeURIComponent(courseId)}`;

        card.appendChild(tags);
        card.appendChild(action);
    } else {
        tags.appendChild(
            createElement('span', 'progress-tag is-locked', 'Complete prerequisites first')
        );

        card.appendChild(tags);
    }

    return card;
}

function renderConceptProgression(response, courseId) {
    const progression = response?.conceptProgression;

    if (!progression ||
        !Array.isArray(progression.concepts) ||
        !Number.isFinite(progression.progressionThreshold)) {
        throw new Error('Concept progression is unavailable.');
    }

    elements.concepts.replaceChildren();

    if (!progression.concepts.length) {
        showEmptyState(
            elements.concepts,
            'No concepts available',
            'There are currently no approved concepts associated with this course.'
        );
        return;
    }

    progression.concepts.forEach(concept => {
        elements.concepts.appendChild(
            renderConceptCard(concept, courseId)
        );
    });
}

/* =========================================
   COURSE PREREQUISITE ELIGIBILITY
========================================= */

function renderPrerequisites(progressResponse, recommendationResponse) {
    const eligibility =
        progressResponse?.prerequisiteEligibility ||
        recommendationResponse?.coursePrerequisiteEligibility;

    elements.prerequisites.replaceChildren();

    if (!eligibility ||
        typeof eligibility.eligible !== 'boolean' ||
        !Array.isArray(eligibility.prerequisites)) {
        throw new Error('Prerequisite eligibility data is unavailable.');
    }

    if (!eligibility.prerequisites.length) {
        showEmptyState(
            elements.prerequisites,
            'No course prerequisites',
            'This course has no earlier courses that you need to complete first.'
        );
        return;
    }

    eligibility.prerequisites.forEach(prerequisite => {
        if (!prerequisite ||
            typeof prerequisite.title !== 'string' ||
            typeof prerequisite.satisfied !== 'boolean') {
            throw new Error('Invalid course prerequisite data.');
        }

        const card = createElement(
            'article',
            'progress-prerequisite-card'
        );

        const details = createElement('div');

        details.appendChild(
            createElement('h3', '', prerequisite.title)
        );

        details.appendChild(
            createElement(
                'p',
                '',
                prerequisite.satisfied
                    ? 'The prerequisite requirements have been satisfied.'
                    : 'This prerequisite still needs attention.'
            )
        );

        const status = createElement(
            'span',
            `progress-prerequisite-status ${prerequisite.satisfied ? 'is-satisfied' : ''}`,
            prerequisite.satisfied ? 'Satisfied' : 'Pending'
        );

        card.append(details, status);
        elements.prerequisites.appendChild(card);
    });
}

/* =========================================
   LOAD PROGRESS DATA
========================================= */

async function loadProgress() {
    const courseId = elements.courseFilter.value;

    if (!courseId) {
        displayStatus('Select an approved course to view your progress.');

        showEmptyState(
            elements.overview,
            'No course selected',
            'Select a course to view your learning progress.'
        );

        showEmptyState(
            elements.mastery,
            'No mastery data',
            'Select a course to view your mastery summary.'
        );

        showEmptyState(
            elements.concepts,
            'No concepts available',
            'Select a course to view concept progression.'
        );

        showEmptyState(
            elements.prerequisites,
            'No prerequisite data',
            'Select a course to view prerequisite eligibility.'
        );

        return;
    }

    displayStatus('Loading your learning progress...');

    elements.overview.replaceChildren();
    elements.mastery.replaceChildren();
    elements.concepts.replaceChildren();
    elements.prerequisites.replaceChildren();

    const encodedCourseId = encodeURIComponent(courseId);

    const results = await Promise.allSettled([
        api.get(`/learners/me/progress?courseId=${encodedCourseId}`),
        api.get(`/recommendations/me?courseId=${encodedCourseId}`)
    ]);

    const progressResult = results[0];
    const recommendationResult = results[1];

    let progressResponse = null;
    let recommendationResponse = null;
    const errors = [];

    if (progressResult.status === 'fulfilled' &&
        progressResult.value?.success === true) {
        progressResponse = progressResult.value;
    } else {
        errors.push(
            progressResult.status === 'rejected'
                ? progressResult.reason?.message
                : progressResult.value?.message
        );
    }

    if (recommendationResult.status === 'fulfilled' &&
        recommendationResult.value?.success === true) {
        recommendationResponse = recommendationResult.value;
    } else {
        errors.push(
            recommendationResult.status === 'rejected'
                ? recommendationResult.reason?.message
                : recommendationResult.value?.message
        );
    }

    if (!progressResponse && !recommendationResponse) {
        throw new Error(
            errors.filter(Boolean).join(' ') ||
            'Learning progress could not be loaded.'
        );
    }

    if (progressResponse) {
        try {
            renderCourseOverview(progressResponse);
            renderMasterySummary(progressResponse);
        } catch (error) {
            console.error('Progress summary rendering failed:', error);
            showEmptyState(
                elements.overview,
                'Progress unavailable',
                'The course progress data could not be displayed.'
            );
            showEmptyState(
                elements.mastery,
                'Mastery unavailable',
                'The mastery summary could not be displayed.'
            );
            errors.push(error.message);
        }
    } else {
        showEmptyState(
            elements.overview,
            'Progress unavailable',
            'Course progress could not be retrieved.'
        );

        showEmptyState(
            elements.mastery,
            'Mastery unavailable',
            'The mastery summary could not be retrieved.'
        );
    }

    if (recommendationResponse) {
        try {
            renderConceptProgression(recommendationResponse, courseId);
        } catch (error) {
            console.error('Concept progression rendering failed:', error);

            showEmptyState(
                elements.concepts,
                'Concept progression unavailable',
                'Concept progression could not be displayed.'
            );

            errors.push(error.message);
        }
    } else {
        showEmptyState(
            elements.concepts,
            'Concept progression unavailable',
            'Concept progression could not be retrieved.'
        );
    }

    if (progressResponse || recommendationResponse) {
        try {
            renderPrerequisites(
                progressResponse,
                recommendationResponse
            );
        } catch (error) {
            console.error('Prerequisite rendering failed:', error);

            showEmptyState(
                elements.prerequisites,
                'Prerequisites unavailable',
                'Prerequisite eligibility could not be displayed.'
            );

            errors.push(error.message);
        }
    }

    displayStatus(
        errors.length
            ? 'Some progress information could not be loaded. Please refresh to try again.'
            : ''
    );
}

/* =========================================
   PAGE REFRESH
========================================= */

async function refreshProgressPage() {
    if (isLoading) return;

    isLoading = true;

    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = 'Refreshing...';

    try {
        if (!courses.length) {
            await loadCourses();
        }

        const selectedCourseId = elements.courseFilter.value;

        if (selectedCourseId) {
            localStorage.setItem(
                SELECTED_COURSE_KEY,
                selectedCourseId
            );
        }

        await loadProgress();
    } catch (error) {
        console.error('Progress page refresh failed:', error);

        displayStatus(
            error.message ||
            'Your learning progress could not be loaded. Please try again.'
        );
    } finally {
        isLoading = false;

        elements.refreshButton.disabled = false;
        elements.refreshButton.textContent = 'Refresh';
    }
}

/* =========================================
   PAGE INITIALIZATION
========================================= */

async function initializeProgressPage() {
    try {
        const result = await roleRouting.validateAndRoute({
            api,
            location: window.location,
            expectedRole: 'student',

            onUnavailable(message) {
                displayStatus(message);
            }
        });

        if (!result.ok) {
            if (result.reason === 'unauthenticated') {
                window.location.replace('login_signup.html');
            }

            return;
        }

        learner = result.learner;

        elements.learnerName.textContent =
            learner.username || learner.name || 'Learner';

        elements.header.hidden = false;
        elements.content.hidden = false;
        elements.sessionMessage.hidden = true;

        await loadCourses();
        await loadProgress();
    } catch (error) {
        console.error('Progress page initialization failed:', error);

        displayStatus(
            error.message ||
            'The Progress page could not be initialized. Please refresh and try again.'
        );
    }
}

/* =========================================
   EVENT LISTENERS
========================================= */

elements.logoutButton?.addEventListener('click', () => {
    api.clearSession();
});

elements.refreshButton?.addEventListener(
    'click',
    refreshProgressPage
);

elements.courseFilter?.addEventListener('change', async () => {
    const courseId = elements.courseFilter.value;

    if (courseId) {
        localStorage.setItem(SELECTED_COURSE_KEY, courseId);
    } else {
        localStorage.removeItem(SELECTED_COURSE_KEY);
    }

    if (!isLoading) {
        await refreshProgressPage();
    }
});

/* =========================================
   START PAGE
========================================= */

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        initializeProgressPage,
        { once: true }
    );
} else {
    initializeProgressPage();
}
