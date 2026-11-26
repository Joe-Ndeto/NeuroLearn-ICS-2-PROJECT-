
'use strict';

const api = window.NeuroLearnApi;
const roleRouting = window.NeuroLearnRoleRouting;

const elements = {
    header: document.getElementById('student-header'),
    content: document.getElementById('quizzes-content'),
    sessionMessage: document.getElementById('quizzes-session-message'),
    learnerName: document.getElementById('learner-name'),
    logoutButton: document.getElementById('logout-button'),
    historyStatus: document.getElementById('quiz-history-status'),
    historyList: document.getElementById('quiz-history-list')
};

let learner = null;
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

/* =========================================
   Quiz answer review
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
                `Topic: ${item.conceptName}`
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

/* =========================================
   Quiz history
========================================= */

function getTopicName(attempt) {
    const conceptNames = Array.isArray(attempt.conceptResults)
        ? attempt.conceptResults
            .map(result => result.conceptName)
            .filter(name => typeof name === 'string' && name.trim())
        : [];

    if (conceptNames.length > 0) {
        return [...new Set(conceptNames)].join(', ');
    }

    return (
        attempt.conceptName ||
        attempt.concept_name ||
        attempt.topicName ||
        attempt.topic_name ||
        attempt.topic ||
        attempt.concept?.conceptName ||
        attempt.concept?.concept_name ||
        'Topic information unavailable'
    );
}
function getCourseName(attempt) {
    return (
        attempt.courseName ||
        attempt.course_name ||
        attempt.course?.name ||
        (typeof attempt.course === 'string' ? attempt.course : '') ||
        ''
    );
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

        appendText(
            headingGroup,
            'h3',
            'quiz-history-title',
            getTopicName(attempt)
        );

        const courseName = getCourseName(attempt);

        if (courseName) {
            appendText(
                headingGroup,
                'p',
                'quiz-history-date',
                `Course: ${courseName}`
            );
        }

        appendText(
            headingGroup,
            'p',
            'quiz-history-date',
            `Attempt #${index + 1} · ${formatDate(
                attempt.submittedAt ?? attempt.submitted_at
            )}`
        );

        header.appendChild(headingGroup);

        appendText(
            header,
            'span',
            'quiz-history-score',
            formatPercentage(
                attempt.overallScore ?? attempt.overall_score
            )
        );

        card.appendChild(header);

        const meta = document.createElement('div');
        meta.className = 'quiz-history-meta';

        appendText(
            meta,
            'span',
            '',
            `Correct answers: ${
                attempt.correctCount ?? attempt.correct_count ?? 0
            } / ${
                attempt.totalQuestions ?? attempt.total_questions ?? 0
            }`
        );

        card.appendChild(meta);

        const details = document.createElement('details');
        details.className = 'quiz-review-details';

        const summary = document.createElement('summary');
        summary.textContent = 'Review answers';

        details.appendChild(summary);
        details.appendChild(
            renderQuizReview(attempt.review ?? attempt.answers)
        );

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

    try {
        await loadQuizHistory();
    } catch (error) {
        console.error('Quiz history loading failed:', error);

        displayStatus(
            elements.historyStatus,
            `Could not load quiz history: ${error.message}`
        );

        showEmptyState(
            elements.historyList,
            'Quiz history unavailable',
            'Check your connection and refresh the page to try again.'
        );
    } finally {
        isLoading = false;
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

if (document.readyState === 'loading') {
    document.addEventListener(
        'DOMContentLoaded',
        initializeQuizzesPage,
        { once: true }
    );
} else {
    initializeQuizzesPage();
}
