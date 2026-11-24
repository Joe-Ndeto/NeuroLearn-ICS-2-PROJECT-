'use strict';

const api = window.NeuroLearnApi;
const roleRouting = window.NeuroLearnRoleRouting;

const SELECTED_COURSE_KEY = 'neurolearn.selectedCourseId';

const elements = {
    header: document.getElementById('student-header'),
    content: document.getElementById('quizzes-content'),
    sessionMessage: document.getElementById('quizzes-session-message'),
    learnerName: document.getElementById('learner-name'),
    logoutButton: document.getElementById('logout-button'),

    courseFilter: document.getElementById('quiz-course-filter'),
    refreshButton: document.getElementById('refresh-available-quizzes'),

    availableStatus: document.getElementById('available-quizzes-status'),
    availableList: document.getElementById('available-quizzes-list'),

    historyStatus: document.getElementById('quiz-history-status'),
    historyList: document.getElementById('quiz-history-list')
};

let learner = null;
let availableDocuments = [];
let quizHistory = [];
let isLoading = false;

/* =========================================
   General helpers
========================================= */

function appendText(parent, tag, className, value) {
    const element = document.createElement(tag);

    if (className) {
        element.className = className;
    }

    element.textContent = String(value ?? '');
    parent.appendChild(element);

    return element;
}

function getDocumentId(item) {
    return item.documentId ?? item.document_id ?? null;
}

function getCourseId(item) {
    return item.courseId ?? item.course_id ?? null;
}

function getConceptId(item) {
    return item.conceptId ?? item.concept_id ?? null;
}

function getProcessingStatus(item) {
    return String(
        item.processingStatus ?? item.processing_status ?? ''
    ).toLowerCase();
}

function normalizeDocument(item, course) {
    return {
        documentId: getDocumentId(item),
        title: item.title || item.filename || 'Untitled learning material',
        filename: item.filename || item.title || 'Untitled learning material',
        fileType: item.fileType || item.file_type || 'Document',
        scope: item.scope || 'personal',
        reviewStatus: item.reviewStatus || item.review_status || '',
        processingStatus: getProcessingStatus(item),
        courseId: getCourseId(item) ?? course.courseId,
        courseName: item.courseName || item.course_name || course.name,
        conceptId: getConceptId(item),
        conceptName: item.conceptName || item.concept_name || 'Course concept'
    };
}

function formatDate(value) {
    if (!value) return 'Date unavailable';

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return 'Date unavailable';
    }

    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short'
    }).format(date);
}

function formatPercentage(value) {
    const score = Number(value);

    return Number.isFinite(score)
        ? `${score.toFixed(2)}%`
        : 'Score unavailable';
}

function displayStatus(element, message) {
    if (element) {
        element.textContent = message;
    }
}

function showEmptyState(parent, heading, message) {
    const state = document.createElement('div');
    state.className = 'quizzes-empty-state';

    appendText(state, 'strong', '', heading);
    appendText(state, 'p', '', message);

    parent.replaceChildren(state);
}

function validIdentifier(value) {
    return value !== null &&
        value !== undefined &&
        String(value).trim() !== '';
}

/* =========================================
   Course loading
========================================= */

async function loadCourses() {
    const result = await api.get('/submissions/resource-options');

    if (result?.success !== true || !Array.isArray(result.courses)) {
        throw new Error('Approved courses could not be loaded.');
    }

    const courses = result.courses
        .map(course => ({
            courseId: course.courseId ?? course.course_id,
            name: course.name || course.courseName || 'Unnamed course'
        }))
        .filter(course => validIdentifier(course.courseId));

    const previousSelection =
        elements.courseFilter.value ||
        localStorage.getItem(SELECTED_COURSE_KEY) ||
        '';

    elements.courseFilter.replaceChildren();

    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = 'All courses';
    elements.courseFilter.appendChild(allOption);

    courses.forEach(course => {
        const option = document.createElement('option');
        option.value = String(course.courseId);
        option.textContent = course.name;
        elements.courseFilter.appendChild(option);
    });

    const selectionExists = courses.some(
        course => String(course.courseId) === String(previousSelection)
    );

    elements.courseFilter.value = selectionExists
        ? String(previousSelection)
        : '';

    return courses;
}

/* =========================================
   Available quizzes
========================================= */

async function loadAvailableQuizzes(courses) {
    displayStatus(
        elements.availableStatus,
        'Loading approved learning materials...'
    );

    elements.availableList.replaceChildren();

    const selectedCourseId = elements.courseFilter.value;

    const selectedCourses = selectedCourseId
        ? courses.filter(
            course => String(course.courseId) === selectedCourseId
        )
        : courses;

    if (!selectedCourses.length) {
        availableDocuments = [];

        displayStatus(elements.availableStatus, '');
        showEmptyState(
            elements.availableList,
            'No approved courses available',
            'Your approved learning courses will appear here when they become available.'
        );

        return;
    }

    const results = await Promise.allSettled(
        selectedCourses.map(async course => {
            const query = `?courseId=${encodeURIComponent(course.courseId)}`;
            const response = await api.get(`/upload/library${query}`);

            const documents = Array.isArray(response)
                ? response
                : response?.documents || [];

            return documents.map(item => normalizeDocument(item, course));
        })
    );

    const successfulResults = results.filter(
        result => result.status === 'fulfilled'
    );

    const failedCount = results.length - successfulResults.length;

    availableDocuments = successfulResults
        .flatMap(result => result.value)
        .filter(item =>
            validIdentifier(item.documentId) &&
            validIdentifier(item.courseId) &&
            validIdentifier(item.conceptId) &&
            item.scope === 'shared' &&
            item.reviewStatus === 'approved' &&
            item.processingStatus === 'processed'
        );

    const uniqueDocuments = new Map();

    availableDocuments.forEach(item => {
        uniqueDocuments.set(String(item.documentId), item);
    });

    availableDocuments = [...uniqueDocuments.values()];

    renderAvailableQuizzes();

    if (failedCount > 0) {
        displayStatus(
            elements.availableStatus,
            `${failedCount} course library request(s) could not be completed. Some results may be missing.`
        );
    } else {
        displayStatus(
            elements.availableStatus,
            `${availableDocuments.length} approved learning material(s) available.`
        );
    }
}

function renderAvailableQuizzes() {
    elements.availableList.replaceChildren();

    if (!availableDocuments.length) {
        showEmptyState(
            elements.availableList,
            'No quizzes available yet',
            'Approved, processed learning materials linked to course concepts will appear here.'
        );

        return;
    }

    availableDocuments.forEach(item => {
        const card = document.createElement('article');
        card.className = 'available-quiz-card';

        appendText(card, 'div', 'quiz-card-icon', 'Q');

        appendText(card, 'h3', 'quiz-card-title', item.title);

        appendText(
            card,
            'p',
            'quiz-card-course',
            `Course: ${item.courseName}`
        );

        appendText(
            card,
            'p',
            'quiz-card-concept',
            `Concept: ${item.conceptName}`
        );

        appendText(
            card,
            'p',
            'quiz-card-type',
            `Material type: ${item.fileType}`
        );

        const action = document.createElement('a');
        action.className = 'quiz-card-action';

        const params = new URLSearchParams({
            courseId: String(item.courseId),
            conceptId: String(item.conceptId),
            documentId: String(item.documentId)
        });

        action.href = `study.html?${params.toString()}`;
        action.textContent = 'Open in Study Workspace';

        card.appendChild(action);
        elements.availableList.appendChild(card);
    });
}

/* =========================================
   Quiz history
========================================= */

function renderQuizReview(review) {
    const list = document.createElement('div');
    list.className = 'quiz-review-list';

    if (!Array.isArray(review) || !review.length) {
        appendText(
            list,
            'p',
            'quizzes-status',
            'No answer review is available for this attempt.'
        );

        return list;
    }

    review.forEach((item, index) => {
        const card = document.createElement('article');
        card.className = 'quiz-review-item';

        appendText(
            card,
            'p',
            'quiz-review-question',
            `${index + 1}. ${item.question || 'Question unavailable'}`
        );

        if (Array.isArray(item.options) && item.options.length) {
            appendText(
                card,
                'p',
                'quiz-review-answer',
                `Options: ${item.options.join(' | ')}`
            );
        }

        appendText(
            card,
            'p',
            'quiz-review-answer',
            `Your answer: ${item.selectedAnswer ?? 'Not recorded'}`
        );

        appendText(
            card,
            'p',
            'quiz-review-answer',
            `Correct answer: ${item.correctAnswer ?? 'Unavailable'}`
        );

        const isCorrect = item.isCorrect === true;

        appendText(
            card,
            'span',
            `quiz-review-result ${isCorrect ? 'correct' : 'incorrect'}`,
            isCorrect ? 'Correct' : 'Incorrect'
        );

        if (item.conceptName) {
            appendText(
                card,
                'p',
                'quiz-review-answer',
                `Concept: ${item.conceptName}`
            );
        }

        if (item.explanation) {
            appendText(
                card,
                'p',
                'quiz-review-explanation',
                `Explanation: ${item.explanation}`
            );
        }

        list.appendChild(card);
    });

    return list;
}

function renderQuizHistory() {
    elements.historyList.replaceChildren();

    if (!quizHistory.length) {
        showEmptyState(
            elements.historyList,
            'No quiz attempts yet',
            'Your completed quizzes and results will appear here.'
        );

        return;
    }

    quizHistory.forEach((attempt, index) => {
        const card = document.createElement('article');
        card.className = 'quiz-history-card';

        const header = document.createElement('div');
        header.className = 'quiz-history-header';

        const headingGroup = document.createElement('div');

        const matchingDocument = availableDocuments.find(
            item => String(item.documentId) === String(attempt.documentId)
        );

        appendText(
            headingGroup,
            'h3',
            'quiz-history-title',
            `Quiz Attempt #${index + 1}`
        );

        if (matchingDocument) {
            appendText(
                headingGroup,
                'p',
                'quiz-history-date',
                matchingDocument.title
            );
        }

        appendText(
            headingGroup,
            'p',
            'quiz-history-date',
            formatDate(attempt.submittedAt)
        );

        header.appendChild(headingGroup);

        appendText(
            header,
            'span',
            'quiz-history-score',
            formatPercentage(attempt.overallScore)
        );

        card.appendChild(header);

        const meta = document.createElement('div');
        meta.className = 'quiz-history-meta';

        appendText(
            meta,
            'span',
            '',
            `Correct answers: ${attempt.correctCount ?? 0} / ${attempt.totalQuestions ?? 0}`
        );

        if (attempt.assessmentId) {
            appendText(
                meta,
                'span',
                '',
                `Assessment ID: ${attempt.assessmentId}`
            );
        }

        card.appendChild(meta);

        const details = document.createElement('details');
        details.className = 'quiz-review-details';

        const summary = document.createElement('summary');
        summary.textContent = 'Review answers';
        details.appendChild(summary);

        details.appendChild(renderQuizReview(attempt.review));

        card.appendChild(details);
        elements.historyList.appendChild(card);
    });
}

async function loadQuizHistory() {
    displayStatus(
        elements.historyStatus,
        'Loading your quiz history...'
    );

    elements.historyList.replaceChildren();

    const result = await api.get('/ai/quiz/history');

    if (result?.success !== true || !Array.isArray(result.history)) {
        throw new Error('Quiz history could not be loaded.');
    }

    quizHistory = result.history;
    renderQuizHistory();

    displayStatus(
        elements.historyStatus,
        `${quizHistory.length} completed quiz attempt(s) found.`
    );
}

/* =========================================
   Page refresh
========================================= */

async function refreshPage() {
    if (isLoading) return;

    isLoading = true;
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = 'Refreshing...';

    try {
        const courses = await loadCourses();

        if (elements.courseFilter.value) {
            localStorage.setItem(
                SELECTED_COURSE_KEY,
                elements.courseFilter.value
            );
        }

        const results = await Promise.allSettled([
            loadAvailableQuizzes(courses),
            loadQuizHistory()
        ]);

        const historyFailed = results[1].status === 'rejected';

        if (historyFailed) {
            console.error('Quiz history loading failed:', results[1].reason);

            displayStatus(
                elements.historyStatus,
                `Could not load quiz history: ${results[1].reason.message}`
            );

            showEmptyState(
                elements.historyList,
                'Quiz history unavailable',
                'Check your connection and refresh the page to try again.'
            );
        }
    } catch (error) {
        console.error('Quizzes page loading failed:', error);

        displayStatus(
            elements.availableStatus,
            `Could not load available quizzes: ${error.message}`
        );

        showEmptyState(
            elements.availableList,
            'Learning materials unavailable',
            'Check your connection and refresh the page to try again.'
        );
    } finally {
        isLoading = false;
        elements.refreshButton.disabled = false;
        elements.refreshButton.textContent = 'Refresh';
    }
}

/* =========================================
   Page initialization
========================================= */

async function initializeQuizzesPage() {
    try {
        const result = await roleRouting.validateAndRoute({
            api,
            location: window.location,
            expectedRole: 'student',
            onUnavailable(message) {
                displayStatus(elements.sessionMessage, message);
            }
        });

        if (!result.ok) {
            if (result.reason === 'unauthenticated') {
                window.location.replace('login_signup.html');
            }

            return;
        }

        learner = result.learner;

        if (elements.learnerName) {
            elements.learnerName.textContent =
                learner.username || learner.name || 'Learner';
        }

        elements.header.hidden = false;
        elements.content.hidden = false;
        elements.sessionMessage.hidden = true;

        await refreshPage();
    } catch (error) {
        console.error('Quizzes page initialization failed:', error);

        displayStatus(
            elements.sessionMessage,
            'The Quizzes page could not be initialized. Please refresh and try again.'
        );
    }
}

/* =========================================
   Event listeners
========================================= */

elements.logoutButton?.addEventListener('click', () => {
    api.clearSession();
});

elements.refreshButton?.addEventListener('click', refreshPage);

elements.courseFilter?.addEventListener('change', async () => {
    const selectedCourseId = elements.courseFilter.value;

    if (selectedCourseId) {
        localStorage.setItem(SELECTED_COURSE_KEY, selectedCourseId);
    } else {
        localStorage.removeItem(SELECTED_COURSE_KEY);
    }

    if (isLoading) return;

    isLoading = true;
    elements.refreshButton.disabled = true;

    try {
        const courses = [...elements.courseFilter.options]
            .filter(option => option.value !== '')
            .map(option => ({
                courseId: option.value,
                name: option.textContent
            }));

        await loadAvailableQuizzes(courses);
    } catch (error) {
        console.error('Course filtering failed:', error);

        displayStatus(
            elements.availableStatus,
            `Could not filter learning materials: ${error.message}`
        );
    } finally {
        isLoading = false;
        elements.refreshButton.disabled = false;
    }
});

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        initializeQuizzesPage,
        { once: true }
    );
} else {
    initializeQuizzesPage();
}
