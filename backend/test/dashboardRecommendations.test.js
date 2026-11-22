'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const dashboardSource = fs.readFileSync(path.join(__dirname, '../../frontend/dashboard.js'), 'utf8');

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toLowerCase();
        this.children = [];
        this.attributes = {};
        this.dataset = {};
        this.hidden = false;
        this.textContent = '';
        this.className = '';
        this.href = '';
        this.style = {};
        this.listeners = new Map();
        this.disabled = false;
    }

    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    appendChild(child) { this.children.push(child); return child; }
    replaceChildren(...children) { this.children = children; }
}

const DEFAULT_PROGRESS = {
    success: true,
    progress: { percentage: 0, masteredConcepts: 0, totalConcepts: 2 },
    mastery: { percentage: null, status: 'UNKNOWN', assessedConcepts: 0, totalConcepts: 2 }
};

function createDashboardHarness(recommendationResponse, {
    progressResponse = DEFAULT_PROGRESS, progressError = null, progressPromise = null, recommendationError = null
} = {}) {
    const elements = new Map();
    const document = {
        body: new FakeElement('body'),
        head: new FakeElement('head'),
        getElementById(id) {
            if (!elements.has(id)) {
                const element = new FakeElement();
                if (['review-gaps-panel', 'review-gaps-loading', 'review-gaps-empty', 'review-gaps-error',
                    'review-gaps-retry', 'recommendations-loading', 'recommendations-empty', 'recommendations-error',
                    'recommendations-retry', 'dashboard-progress-loading', 'dashboard-progress-empty',
                    'dashboard-progress-error', 'dashboard-progress-retry'].includes(id)) element.hidden = true;
                const initialText = {
                    'overall-progress': '—',
                    'courses-completed': '—',
                    'mastery-level': '—'
                }[id];
                if (initialText !== undefined) element.textContent = initialText;
                elements.set(id, element);
            }
            return elements.get(id);
        },
        createElement(tagName) { return new FakeElement(tagName); }
    };
    const apiCalls = [];
    const normalizedRecommendationResponse = {
        ...recommendationResponse,
        concepts: recommendationResponse.concepts || [],
        coursePrerequisiteEligibility: recommendationResponse.coursePrerequisiteEligibility || { eligible: true, prerequisites: [] }
    };
    const window = {
        NeuroLearnApi: {
            async get(pathname) {
                apiCalls.push(pathname);
                if (pathname === '/learners/me/progress') {
                    const failure = typeof progressError === 'function' ? progressError() : progressError;
                    if (failure) throw failure;
                    if (progressPromise) return progressPromise;
                    return progressResponse;
                }
                const failure = typeof recommendationError === 'function' ? recommendationError() : recommendationError;
                if (failure) throw failure;
                return normalizedRecommendationResponse;
            },
            clearSession() {}
        },
        NeuroLearnRoleRouting: {
            async validateAndRoute() { return { ok: true, learner: { username: 'Student' } }; }
        },
        location: { href: '' }
    };
    vm.runInNewContext(dashboardSource, { window, document, console, Promise, setTimeout });
    return { document, elements, apiCalls };
}

async function flushDashboardWork() {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
}

function allText(element) {
    return `${element.textContent} ${element.children.map(allText).join(' ')}`;
}

test('dashboard renders cold-start foundations without exposing internal ranking details', async () => {
    const recommendation = {
        conceptId: 10,
        conceptName: 'Relational Foundations',
        priorityScore: 85,
        mastery: null,
        evidenceStatus: 'UNKNOWN',
        G: 1,
        R: 1,
        U: 0,
        explanation: 'Priority score 85 from G=1 and R=1.',
        prerequisiteReadiness: { satisfied: true, satisfiedCount: 0, totalCount: 0, prerequisites: [] }
    };
    const { document, elements, apiCalls } = createDashboardHarness({
        success: true,
        recommendationMode: 'cold_start',
        recommendations: [recommendation]
    });
    await flushDashboardWork();

    assert.ok(apiCalls.includes('/recommendations/me'));
    assert.ok(apiCalls.includes('/learners/me/progress'));
    assert.equal(elements.get('student-recommendations-title').textContent, 'Recommended topics to get started');
    assert.match(elements.get('recommendations-intro').textContent, /Complete a lesson and take an assessment/);
    const list = elements.get('recommendations-list');
    assert.equal(list.children.length, 1);
    const content = allText(list.children[0]);
    assert.match(content, /Relational Foundations/);
    assert.match(content, /Not started/);
    assert.match(content, /Start here: this is a foundational topic/);
    assert.doesNotMatch(content, /Priority score|\bUNKNOWN\b|\bPROVISIONAL\b|\bG=|\bR=|\bU=/);
    assert.equal(list.children[0].children.some(child => child.tagName === 'img'), false);
    const action = list.children[0].children.find(child => child.textContent === 'Start learning');
    assert.ok(action);
    assert.equal(action.href, 'study.html');
    assert.equal(document.getElementById('recommendations-empty').hidden, true);
});

test('dashboard renders adaptive recommendations with friendly progress and prerequisite text', async () => {
    const { elements } = createDashboardHarness({
        success: true,
        recommendationMode: 'adaptive',
        recommendations: [{
            conceptId: 22,
            conceptName: 'Indexing',
            priorityScore: 72.1234,
            mastery: 68.25,
            evidenceStatus: 'EVIDENCE_QUALIFIED',
            G: 0.3175,
            R: 0.9,
            U: 0.2,
            explanation: 'The ranking formula includes a priority score.',
            prerequisiteReadiness: { satisfied: true, satisfiedCount: 1, totalCount: 1, prerequisites: [] }
        }]
    });
    await flushDashboardWork();

    assert.equal(elements.get('student-recommendations-title').textContent, 'Recommended next concepts');
    const card = elements.get('recommendations-list').children[0];
    const content = allText(card);
    assert.match(content, /In progress/);
    assert.match(content, /useful next step based on your learning progress/);
    assert.match(content, /earlier topics needed for this concept are ready/);
    assert.doesNotMatch(content, /72\.1234|EVIDENCE_QUALIFIED|ranking formula|\bG=|\bR=|\bU=/);
});

test('dashboard displays a useful cold-start empty state', async () => {
    const { elements } = createDashboardHarness({
        success: true,
        recommendationMode: 'cold_start',
        recommendations: []
    });
    await flushDashboardWork();

    assert.equal(elements.get('recommendations-empty').hidden, false);
    assert.match(elements.get('recommendations-empty').textContent, /No foundational topics are ready yet/);
});

test('dashboard maps supported mastered data to a status and omits unverified prerequisite claims', async () => {
    const { elements } = createDashboardHarness({
        success: true,
        recommendationMode: 'adaptive',
        recommendations: [{
            conceptId: 30,
            conceptName: 'Transactions',
            priorityScore: 30,
            mastery: 90,
            evidenceStatus: 'EVIDENCE_QUALIFIED',
            explanation: 'Internal ranking detail.',
            prerequisiteReadiness: { satisfied: false, totalCount: 2 }
        }]
    });
    await flushDashboardWork();

    const content = allText(elements.get('recommendations-list').children[0]);
    assert.match(content, /Learning status: Mastered/);
    assert.doesNotMatch(content, /earlier topics needed/);
    assert.doesNotMatch(content, /Internal ranking detail|Priority/);
});

test('dashboard loads evidence-based progress and current mastery', async () => {
    const { elements } = createDashboardHarness({ success: true, recommendationMode: 'adaptive', recommendations: [] }, {
        progressResponse: {
            success: true,
            progress: { percentage: 50, masteredConcepts: 1, totalConcepts: 2 },
            mastery: { percentage: 82.5, status: 'PROVISIONAL', assessedConcepts: 1, totalConcepts: 2 }
        }
    });
    await flushDashboardWork();

    assert.equal(elements.get('overall-progress').textContent, '50.00%');
    assert.equal(elements.get('overall-progress-bar').style.width, '50%');
    assert.equal(elements.get('courses-completed').textContent, '1 mastered · 1 still requiring work (2 total)');
    assert.equal(elements.get('mastery-level').textContent, '82.50%');
    assert.match(elements.get('mastery-status').textContent, /Early estimate/);
});

test('dashboard shows loading spinner while progress is pending, then clears it', async () => {
    let resolveProgress;
    const pendingProgress = new Promise(resolve => { resolveProgress = resolve; });
    const { elements } = createDashboardHarness({ success: true, recommendationMode: 'cold_start', recommendations: [] }, {
        progressPromise: pendingProgress
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.get('dashboard-progress-loading').hidden, false);
    assert.equal(elements.get('dashboard-progress-feedback').attributes['aria-busy'], 'true');
    resolveProgress(DEFAULT_PROGRESS);
    await flushDashboardWork();
    assert.equal(elements.get('dashboard-progress-loading').hidden, true);
    assert.equal(elements.get('dashboard-progress-feedback').attributes['aria-busy'], 'false');
});

test('dashboard progress errors preserve placeholders and expose retry', async () => {
    const { elements } = createDashboardHarness({ success: true, recommendationMode: 'cold_start', recommendations: [] }, {
        progressError: new Error('internal database details')
    });
    await flushDashboardWork();

    assert.equal(elements.get('overall-progress').textContent, '—');
    assert.equal(elements.get('mastery-level').textContent, '—');
    assert.equal(elements.get('dashboard-progress-error').hidden, false);
    assert.equal(elements.get('dashboard-progress-retry').hidden, false);
    assert.doesNotMatch(elements.get('dashboard-progress-error').textContent, /internal database details/);
});

test('dashboard handles a course with no concepts and unknown mastery', async () => {
    const { elements } = createDashboardHarness({ success: true, recommendationMode: 'cold_start', recommendations: [] }, {
        progressResponse: {
            success: true,
            progress: { percentage: 0, masteredConcepts: 0, totalConcepts: 0 },
            mastery: { percentage: null, status: 'UNKNOWN', assessedConcepts: 0, totalConcepts: 0 }
        }
    });
    await flushDashboardWork();

    assert.equal(elements.get('overall-progress').textContent, '0.00%');
    assert.equal(elements.get('mastery-level').textContent, 'Not assessed yet');
    assert.equal(elements.get('dashboard-progress-empty').hidden, false);
});

test('dashboard shows safe API error messages and retry reloads progress', async () => {
    let failFirst = true;
    const { elements, apiCalls } = createDashboardHarness({
        success: true, recommendationMode: 'cold_start', recommendations: [], concepts: []
    }, {
        progressError: () => {
            if (!failFirst) return null;
            failFirst = false;
            return Object.assign(new Error('Database Concepts needs administrator reconciliation.'), { name: 'ApiError' });
        },
        progressResponse: {
            success: true,
            progress: { percentage: 0, masteredConcepts: 0, totalConcepts: 3 },
            mastery: { percentage: 72, status: 'PROVISIONAL', assessedConcepts: 1, totalConcepts: 3 }
        }
    });
    await flushDashboardWork();
    assert.match(elements.get('dashboard-progress-error').textContent, /administrator reconciliation/);
    assert.equal(elements.get('dashboard-progress-retry').hidden, false);
    elements.get('dashboard-progress-retry').listeners.get('click')();
    await flushDashboardWork();
    assert.equal(apiCalls.filter(path => path === '/learners/me/progress').length, 2);
    assert.equal(elements.get('dashboard-progress-error').hidden, true);
    assert.equal(elements.get('mastery-level').textContent, '72.00%');
    assert.match(elements.get('courses-completed').textContent, /0 mastered · 3 still requiring work/);
});

test('recommendation failure displays the safe server message and retry reloads', async () => {
    let failFirst = true;
    const { elements, apiCalls } = createDashboardHarness({
        success: true, recommendationMode: 'cold_start', recommendations: [], concepts: []
    }, {
        recommendationError: () => {
            if (!failFirst) return null;
            failFirst = false;
            return Object.assign(new Error('Course and prerequisite data are not fully synchronized.'), { name: 'ApiError' });
        }
    });
    await flushDashboardWork();
    assert.match(elements.get('recommendations-error').textContent, /not fully synchronized/);
    elements.get('recommendations-retry').listeners.get('click')();
    await flushDashboardWork();
    assert.equal(apiCalls.filter(path => path === '/recommendations/me').length, 2);
    assert.equal(elements.get('recommendations-error').hidden, true);
});

test('Review Gaps categorizes real mastery, preserves unknown values, names unmet prerequisites, and links to Study', async () => {
    const concepts = [
        { conceptId: 1, conceptName: '<Foundations>', mastery: null, evidenceStatus: 'UNKNOWN', assessmentCount: 0, prerequisites: [] },
        { conceptId: 2, conceptName: 'SQL', mastery: 92, evidenceStatus: 'PROVISIONAL', assessmentCount: 1, prerequisites: [] },
        { conceptId: 3, conceptName: 'Joins', mastery: 79.5, evidenceStatus: 'EVIDENCE_QUALIFIED', assessmentCount: 2,
            prerequisites: [{ conceptId: 1, conceptName: 'Foundations', mastery: null, evidenceStatus: 'UNKNOWN', satisfied: false }] },
        { conceptId: 4, conceptName: 'Normalization', mastery: 85, evidenceStatus: 'EVIDENCE_QUALIFIED', assessmentCount: 2, prerequisites: [] }
    ];
    const { elements, apiCalls } = createDashboardHarness({
        success: true, recommendationMode: 'cold_start', recommendations: [], concepts,
        coursePrerequisiteEligibility: { eligible: true, prerequisites: [] }
    });
    await flushDashboardWork();
    const button = elements.get('review-gaps-button');
    assert.equal(button.disabled, false);
    assert.match(elements.get('knowledge-gaps-count').textContent, /3 concepts to review/);
    assert.match(allText(elements.get('knowledge-gaps-list')), /Not assessed: 1/);
    button.listeners.get('click')();
    await flushDashboardWork();
    assert.equal(elements.get('review-gaps-panel').hidden, false);
    assert.equal(button.attributes['aria-expanded'], 'true');
    assert.equal(apiCalls.filter(path => path === '/recommendations/me').length, 2, 'Review Gaps refreshes through the authenticated API');
    const rendered = elements.get('review-gaps-list');
    const text = allText(rendered);
    assert.match(text, /Not assessed/);
    assert.match(text, /Needs more evidence/);
    assert.match(text, /Needs improvement/);
    assert.match(text, /Mastered/);
    assert.match(text, /Unmet prerequisites: Foundations/);
    assert.match(text, /Open Study Workspace/);
    assert.equal(rendered.children.some(group => allText(group).includes('<Foundations>')), true);
    assert.match(elements.get('knowledge-gaps-count').textContent, /3 concepts to review/);
    elements.get('review-gaps-close').listeners.get('click')();
    assert.equal(elements.get('review-gaps-panel').hidden, true);
    assert.equal(button.attributes['aria-expanded'], 'false');
});

test('Review Gaps retry reports API errors and can recover', async () => {
    let recommendationCall = 0;
    const { elements, apiCalls } = createDashboardHarness({
        success: true, recommendationMode: 'cold_start', recommendations: [], concepts: []
    }, {
        recommendationError: () => {
            recommendationCall++;
            return recommendationCall === 2
                ? Object.assign(new Error('The approved course catalogue is unavailable.'), { name: 'ApiError' })
                : null;
        }
    });
    await flushDashboardWork();
    elements.get('review-gaps-button').listeners.get('click')();
    await flushDashboardWork();
    assert.match(elements.get('review-gaps-error').textContent, /approved course catalogue/);
    elements.get('review-gaps-retry').listeners.get('click')();
    await flushDashboardWork();
    assert.equal(elements.get('review-gaps-error').hidden, true);
    assert.equal(elements.get('review-gaps-empty').hidden, false);
    assert.equal(apiCalls.filter(path => path === '/recommendations/me').length, 3);
});

test('course-prerequisite blocking is a valid response and Review Gaps names unmet course requirements separately', async () => {
    const { elements } = createDashboardHarness({
        success: true,
        recommendationMode: 'course_prerequisite_blocked',
        recommendations: [],
        concepts: [{ conceptId: 5, conceptName: 'Advanced SQL', mastery: null, evidenceStatus: 'UNKNOWN', assessmentCount: 0, prerequisites: [] }],
        coursePrerequisiteEligibility: {
            eligible: false,
            prerequisites: [{ courseId: 9, title: 'Database Foundations', satisfied: false }]
        }
    });
    await flushDashboardWork();
    assert.equal(elements.get('recommendations-error').hidden, true);
    assert.equal(elements.get('recommendations-empty').hidden, false);
    elements.get('review-gaps-button').listeners.get('click')();
    await flushDashboardWork();
    assert.match(allText(elements.get('review-gaps-list')), /Unmet course prerequisites: Database Foundations/);
    assert.match(allText(elements.get('review-gaps-list')), /separate from concept prerequisites/);
});
