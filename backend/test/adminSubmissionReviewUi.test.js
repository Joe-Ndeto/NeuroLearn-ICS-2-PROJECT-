'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
    createAdminReviewController,
    initializeAdminSubmissionReview,
    populateCourseSelect,
    renderQueue,
    renderSubmissionDetails
} = require('../../frontend/admin-submissions');

const COURSE_ID = 'COURSE-00111111-1111-4111-8111-111111111111';
const COURSE_ID_2 = 'COURSE-00222222-2222-4222-8222-222222222222';

class FakeElement {
    constructor() {
        this.textContent = '';
        this.className = '';
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.dataset = {};
        this.children = [];
        this.listeners = {};
        this.selectedOptions = [];
    }

    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    cloneNode() {
        const clone = new FakeElement();
        clone.value = this.value;
        clone.textContent = this.textContent;
        return clone;
    }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute(name, value) { this[name] = value; }
}

function createDocument() {
    return {
        createElement() { return new FakeElement(); },
        createTextNode(text) { return { textContent: text }; }
    };
}

function createElements() {
    const elements = {
        statusFilter: new FakeElement(),
        typeFilter: new FakeElement(),
        refresh: new FakeElement(),
        queueLoading: new FakeElement(),
        queueError: new FakeElement(),
        queueNotice: new FakeElement(),
        queueEmpty: new FakeElement(),
        queue: new FakeElement(),
        queueView: new FakeElement(),
        pagination: new FakeElement(),
        previous: new FakeElement(),
        next: new FakeElement(),
        detail: new FakeElement(),
        detailLoading: new FakeElement(),
        detailError: new FakeElement(),
        detailContent: new FakeElement(),
        actions: new FakeElement(),
        notes: new FakeElement(),
        courseField: new FakeElement(),
        courses: new FakeElement(),
        difficultyField: new FakeElement(),
        difficulty: new FakeElement(),
        courseDifficultyField: new FakeElement(),
        courseDifficulty: new FakeElement(),
        courseMessage: new FakeElement(),
        resourceConceptField: new FakeElement(),
        resourceConcept: new FakeElement(),
        resourceConceptMessage: new FakeElement(),
        actionMessage: new FakeElement(),
        approve: new FakeElement(),
        reject: new FakeElement(),
        closeDetail: new FakeElement(),
        pageHeading: new FakeElement(),
        syncSection: new FakeElement()
    };

    elements.statusFilter.value = 'pending';
    elements.typeFilter.value = '';

    return elements;
}

function createController({
    api,
    confirmFn = () => true,
    elements = createElements(),
    location,
    history,
    windowRef
} = {}) {
    return {
        controller: createAdminReviewController({
            api,
            document: createDocument(),
            elements,
            confirmFn,
            location,
            history,
            windowRef
        }),
        elements
    };
}

function submission(overrides = {}) {
    return {
        submissionId: 17,
        submissionType: 'CONCEPT',
        submissionData: {
            name: 'Graph Theory',
            description: 'Study of graphs',
            difficultyLevel: 'Intermediate'
        },
        status: 'pending',
        submittedAt: '2026-03-04T10:00:00Z',
        reviewedBy: null,
        reviewNotes: null,
        reviewedAt: null,
        submitter: {
            learnerId: 5,
            username: 'student',
            email: 'student@example.test'
        },
        reviewer: null,
        sync: { status: null },
        ...overrides
    };
}

function queueResult(
    rows = [submission()],
    page = 1,
    totalPages = 1,
    total = rows.length
) {
    return {
        success: true,
        submissions: rows,
        pagination: { page, limit: 20, total, totalPages }
    };
}

test('administrator visibility requires server-confirmed administrator role', async () => {
    const section = new FakeElement();
    section.hidden = true;

    const document = {
        getElementById: id =>
            id === 'admin-submission-review' ? section : null
    };

    let calls = 0;

    const result = initializeAdminSubmissionReview({
        document,
        api: {
            isAdministrator: () => false,
            async get() { calls += 1; }
        }
    });

    assert.equal(result, null);
    assert.equal(section.hidden, true);
    assert.equal(calls, 0);
});

test('confirmed administrator role reveals the review section and loads the queue', async () => {
    const elements = createElements();

    const ids = {
        'admin-submission-review': new FakeElement(),
        'admin-review-status-filter': elements.statusFilter,
        'admin-review-type-filter': elements.typeFilter,
        'admin-review-refresh': elements.refresh,
        'admin-review-loading': elements.queueLoading,
        'admin-review-queue-error': elements.queueError,
        'admin-review-queue-notice': elements.queueNotice,
        'admin-review-empty': elements.queueEmpty,
        'admin-review-queue': elements.queue,
        'admin-review-queue-view': elements.queueView,
        'admin-review-pagination': elements.pagination,
        'admin-review-previous': elements.previous,
        'admin-review-next': elements.next,
        'admin-review-detail': elements.detail,
        'admin-review-detail-loading': elements.detailLoading,
        'admin-review-detail-error': elements.detailError,
        'admin-review-detail-content': elements.detailContent,
        'admin-review-actions': elements.actions,
        'admin-review-notes': elements.notes,
        'admin-review-course-field': elements.courseField,
        'admin-review-courses': elements.courses,
        'admin-review-courses-message': elements.courseMessage,
        'admin-review-action-message': elements.actionMessage,
        'admin-review-approve': elements.approve,
        'admin-review-reject': elements.reject,
        'admin-review-close-detail': elements.closeDetail,
        'admin-page-heading': elements.pageHeading,
        'admin-sync-operations': elements.syncSection
    };

    ids['admin-submission-review'].hidden = true;

    let requestedPath;

    const controller = initializeAdminSubmissionReview({
        document: {
            getElementById: id => ids[id] || null,
            createElement() { return new FakeElement(); }
        },
        api: {
            isAdministrator: () => true,
            async get(path) {
                requestedPath = path;
                return queueResult([], 1, 0, 0);
            }
        },
        confirmFn: () => true
    });

    await new Promise(resolve => setImmediate(resolve));

    assert.ok(controller);
    assert.equal(ids['admin-submission-review'].hidden, false);
    assert.equal(
        requestedPath,
        '/admin/submissions?page=1&limit=20&status=pending'
    );
});

test('administrator course manager displays assigned concepts without manual assignment controls', async () => {
    const { initializeCourseManagement } =
        require('../../frontend/admin-submissions');

    const ids = Object.fromEntries([
        'admin-course-management',
        'admin-course-select',
        'admin-course-title',
        'admin-course-description',
        'admin-course-difficulty',
        'admin-course-edit-form',
        'admin-course-save',
        'admin-course-prerequisite-select',
        'admin-course-prerequisite-add',
        'admin-course-prerequisite-list',
        'admin-course-concept-list',
        'admin-course-management-message'
    ].map(id => [id, new FakeElement()]));

    const calls = [];

    const document = {
        getElementById: id => ids[id] || null,
        createElement: () => new FakeElement(),
        createTextNode: text => ({ textContent: text })
    };

    const api = {
        isAdministrator: () => true,

        async get(path) {
            calls.push(['GET', path]);

            if (path === '/admin/submissions/courses') {
                return {
                    success: true,
                    courses: [{
                        courseId: 3,
                        title: 'Data Systems',
                        concepts: []
                    }]
                };
            }

            return {
                success: true,
                assigned: [{
                    conceptId: 10,
                    name: 'Relational Algebra'
                }]
            };
        },

        async post(path, body) {
            calls.push(['POST', path, body]);
            return { success: true };
        },

        async patch() {
            return { success: true };
        },

        async delete() {
            return { success: true };
        }
    };

    const controller = initializeCourseManagement({ document, api });

    await new Promise(resolve => setImmediate(resolve));

    assert.ok(controller);

    await controller.load('3');

    assert.deepEqual(
        ids['admin-course-concept-list'].children.map(
            item => item.textContent
        ),
        ['Relational Algebra']
    );

    assert.ok(
        calls.some(call =>
            call[0] === 'GET' &&
            call[1] ===
            '/admin/submissions/courses/3/concept-management'
        )
    );

    assert.equal(ids['admin-course-concept-select'], undefined);
    assert.equal(ids['admin-course-concept-add'], undefined);

    assert.equal(
        calls.some(call =>
            call[0] === 'POST' &&
            call[1] === '/admin/submissions/courses/3/concepts'
        ),
        false
    );

    assert.equal(
        typeof ids['admin-course-prerequisite-add'].listeners.click,
        'function'
    );
});

test('admin queue uses actual filters and renders concepts, resources, prerequisites, reviewer and separate sync status', async () => {
    const elements = createElements();

    elements.statusFilter.value = '';
    elements.typeFilter.value = 'RESOURCE';

    const rows = [
        submission(),
        submission({
            submissionId: 18,
            submissionType: 'RESOURCE',
            submissionData: {
                title: 'Notes',
                type: 'article',
                url: 'https://example.test'
            },
            status: 'approved',
            sync: { status: 'completed' },
            reviewer: { username: 'admin' }
        }),
        submission({
            submissionId: 19,
            submissionType: 'PREREQUISITE',
            submissionData: {
                prerequisiteId: 'C001',
                targetId: 'C002'
            },
            status: 'rejected'
        })
    ];

    let requested;

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                requested = path;
                return queueResult(rows, 1, 1, 3);
            }
        }
    });

    await controller.loadQueue(1);

    assert.equal(
        requested,
        '/admin/submissions?page=1&limit=20&type=RESOURCE'
    );

    assert.equal(elements.queue.children.length, 3);

    assert.match(
        elements.queue.children[0].children[0].children[0].textContent,
        /Graph Theory/
    );

    assert.match(
        elements.queue.children[1].children[0].children[0].textContent,
        /Notes/
    );

    assert.equal(
        elements.queue.children[1].children[0].children[4].textContent,
        'Knowledge sync: completed'
    );

    assert.equal(
        elements.queue.children[1].children[0].children[5].textContent,
        'Reviewed by admin'
    );

    assert.match(
        elements.queue.children[2].children[0].children[0].textContent,
        /C001 must be learned before C002/
    );

    assert.match(
        elements.queue.children[0].children[0].children[0].textContent,
        /Submission #17/
    );

    assert.equal(
        elements.queue.children[2].children[0].children[3].textContent,
        'Review: Rejected'
    );
});

test('submission detail URL restores a dedicated view and Back to Queue preserves page and filters', async () => {
    const elements = createElements();

    const location = {
        href: 'https://app.example.test/admin.html?page=2&status=pending&type=RESOURCE&submission=42'
    };

    const history = {
        entries: [],
        pushState(_state, _title, url) {
            this.entries.push(['push', url]);
            location.href = url;
        },
        replaceState(_state, _title, url) {
            this.entries.push(['replace', url]);
            location.href = url;
        }
    };

    const requested = [];

    const { controller } = createController({
        elements,
        location,
        history,
        api: {
            async get(path) {
                requested.push(path);

                if (path === '/admin/submissions/42') {
                    return {
                        success: true,
                        submission: submission({
                            submissionId: 42,
                            submissionType: 'RESOURCE',
                            status: 'approved',
                            submissionData: {
                                conceptId: 'C001',
                                title: 'Textbook',
                                type: 'book',
                                url: 'https://example.test/book'
                            },
                            reviewNotes: 'Verified',
                            reviewedAt: '2026-03-05T10:00:00Z',
                            sync: { status: 'completed' }
                        })
                    };
                }

                return queueResult([], 2, 2, 21);
            }
        }
    });

    await controller.restoreRoute();

    assert.deepEqual(requested, ['/admin/submissions/42']);
    assert.equal(elements.queueView.hidden, true);
    assert.equal(elements.detail.hidden, false);
    assert.equal(elements.pageHeading.hidden, true);
    assert.equal(elements.syncSection.hidden, true);

    assert.equal(
        elements.actions.hidden,
        true,
        'review actions are hidden for an approved submission'
    );

    const detailRows = elements.detailContent.children[0].children;

    assert.ok(
        detailRows.some(row =>
            row.children[0].textContent === 'Submission ID'
        )
    );

    assert.ok(
        detailRows.some(row =>
            row.children[0].textContent === 'Reviewer notes'
        )
    );

    assert.ok(
        detailRows.some(row =>
            row.children[0].textContent ===
            'Knowledge synchronization status'
        )
    );

    await elements.closeDetail.listeners.click();

    assert.equal(elements.queueView.hidden, false);
    assert.equal(elements.detail.hidden, true);
    assert.equal(elements.syncSection.hidden, false);

    assert.equal(
        new URL(location.href).searchParams.has('submission'),
        false
    );

    assert.equal(new URL(location.href).searchParams.get('page'), '2');
    assert.equal(new URL(location.href).searchParams.get('status'), 'pending');
    assert.equal(new URL(location.href).searchParams.get('type'), 'RESOURCE');

    assert.equal(
        requested[1],
        '/admin/submissions?page=2&limit=20&status=pending&type=RESOURCE'
    );
});

test('opening a submission pushes a refreshable URL and browser back restores the queue route', async () => {
    const elements = createElements();

    const location = {
        href: 'https://app.example.test/admin.html?page=3&status=rejected&type=PREREQUISITE'
    };

    const history = {
        pushState(_state, _title, url) {
            location.href = url;
        },
        replaceState(_state, _title, url) {
            location.href = url;
        }
    };

    const listeners = {};

    const windowRef = {
        addEventListener(type, callback) {
            listeners[type] = callback;
        }
    };

    const requested = [];

    const { controller } = createController({
        elements,
        location,
        history,
        windowRef,
        api: {
            async get(path) {
                requested.push(path);

                if (path === '/admin/submissions/17') {
                    return {
                        success: true,
                        submission: submission({
                            submissionType: 'RESOURCE',
                            status: 'rejected'
                        })
                    };
                }

                return queueResult([], 3, 3, 41);
            }
        }
    });

    await controller.restoreRoute();
    await controller.openDetail(17);

    const detailUrl = new URL(location.href);

    assert.equal(detailUrl.searchParams.get('submission'), '17');
    assert.equal(detailUrl.searchParams.get('page'), '3');
    assert.equal(detailUrl.searchParams.get('status'), 'rejected');
    assert.equal(detailUrl.searchParams.get('type'), 'PREREQUISITE');
    assert.equal(elements.queueView.hidden, true);

    location.href =
        'https://app.example.test/admin.html?page=3&status=rejected&type=PREREQUISITE';

    await listeners.popstate();

    assert.equal(elements.queueView.hidden, false);
    assert.equal(elements.detail.hidden, true);
    assert.equal(elements.statusFilter.value, 'rejected');
    assert.equal(elements.typeFilter.value, 'PREREQUISITE');

    assert.equal(
        requested[2],
        '/admin/submissions?page=3&limit=20&status=rejected&type=PREREQUISITE'
    );
});

test('queue shows loading, empty, errors, and server pagination boundaries', async t => {
    await t.test('empty and pagination', async () => {
        const elements = createElements();

        const { controller } = createController({
            elements,
            api: {
                async get() {
                    return queueResult([], 1, 0, 0);
                }
            }
        });

        await controller.loadQueue(1);

        assert.equal(elements.queueEmpty.hidden, false);
        assert.equal(elements.pagination.textContent, 'No submissions');
        assert.equal(elements.previous.disabled, true);
        assert.equal(elements.next.disabled, true);
        assert.equal(elements.queueLoading.hidden, true);
    });

    await t.test('loading then network failure', async () => {
        const elements = createElements();

        let rejectRequest;

        const { controller } = createController({
            elements,
            api: {
                get() {
                    return new Promise((resolve, reject) => {
                        rejectRequest = reject;
                    });
                }
            }
        });

        const pending = controller.loadQueue(1);

        assert.equal(elements.queueLoading.hidden, false);

        rejectRequest(new Error('private database detail'));

        await pending;

        assert.equal(elements.queueLoading.hidden, true);
        assert.match(elements.queueError.textContent, /could not be loaded/i);
        assert.doesNotMatch(
            elements.queueError.textContent,
            /private database detail/i
        );
    });

    await t.test('pagination', async () => {
        const elements = createElements();
        const calls = [];

        const { controller } = createController({
            elements,
            api: {
                async get(path) {
                    calls.push(path);

                    const page = Number(
                        new URL(`https://local.test${path}`)
                            .searchParams.get('page')
                    );

                    return queueResult([submission()], page, 2, 21);
                }
            }
        });

        await controller.loadQueue(1);

        assert.equal(elements.previous.disabled, true);
        assert.equal(elements.next.disabled, false);

        await elements.next.listeners.click();

        assert.equal(controller.getCurrentPage(), 2);
        assert.equal(elements.previous.disabled, false);
        assert.equal(elements.next.disabled, true);

        assert.deepEqual(
            calls.map(path =>
                new URL(`https://local.test${path}`)
                    .searchParams.get('page')
            ),
            ['1', '2']
        );
    });
});

test('detail endpoint renders supported submission data, reviewer data, and sync separately as safe text', async () => {
    const document = createDocument();

    for (const row of [
        submission({
            submissionData: {
                name: '<img src=x onerror=alert(1)>',
                description: 'A concept'
            }
        }),
        submission({
            submissionType: 'RESOURCE',
            submissionData: {
                title: 'Book',
                type: 'textbook',
                url: 'https://example.test',
                conceptId: 'C001'
            }
        }),
        submission({
            submissionType: 'PREREQUISITE',
            submissionData: {
                prerequisiteId: 'C001',
                targetId: 'C002'
            }
        })
    ]) {
        const container = new FakeElement();

        renderSubmissionDetails(container, row, document);

        const text = container.children[0].children
            .flatMap(item => item.children)
            .map(child => child.textContent)
            .join(' ');

        if (row.submissionType === 'CONCEPT') {
            assert.match(text, /<img src=x onerror=alert\(1\)>/);
            assert.doesNotMatch(text, /<script>|innerHTML/i);
        } else if (row.submissionType === 'RESOURCE') {
            assert.match(text, /Book/);
            assert.match(text, /Historical concept reference C001/);
        } else {
            assert.match(
                text,
                /Prerequisite concept ID \(learn first\) C001/
            );
            assert.match(
                text,
                /Target concept ID \(learn after\) C002/
            );
        }
    }

    const detail = new FakeElement();

    renderSubmissionDetails(
        detail,
        submission({
            status: 'approved',
            sync: { status: 'processing' },
            reviewer: { learnerId: 2, username: 'reviewer' },
            reviewNotes: 'Reviewed'
        }),
        document
    );

    const detailText = detail.children[0].children
        .flatMap(item => item.children)
        .map(child => child.textContent)
        .join(' ');

    assert.match(detailText, /Review status Approved/);
    assert.match(detailText, /Knowledge synchronization status processing/);
    assert.match(detailText, /Reviewed by reviewer/);
});

test('concept approval requires and sends administrator difficulty with course IDs', async () => {
    const elements = createElements();
    const paths = [];

    let approvalPayload;
    let confirmation = '';

    const callsByPath = {
        '/admin/submissions/17': {
            success: true,
            submission: submission()
        },
        '/admin/submissions/courses': {
            success: true,
            courses: [
                {
                    courseId: 1,
                    courseGraphId: COURSE_ID,
                    title: 'Database Concepts'
                },
                {
                    courseId: 2,
                    courseGraphId: COURSE_ID_2,
                    title: 'Algorithms'
                }
            ]
        }
    };

    const { controller } = createController({
        elements,

        confirmFn(message) {
            confirmation = message;
            return true;
        },

        api: {
            async get(path) {
                paths.push(path);
                return callsByPath[path];
            },

            async patch(path, body) {
                paths.push(path);
                approvalPayload = body;

                return {
                    success: true,
                    submission: submission({ status: 'approved' })
                };
            }
        }
    });

    await controller.openDetail(17);

    assert.equal(elements.difficultyField.hidden, false);

    assert.deepEqual(paths, [
        '/admin/submissions/17',
        '/admin/submissions/courses'
    ]);

    assert.deepEqual(
        elements.courses.children.map(option => option.value),
        [COURSE_ID, COURSE_ID_2]
    );

    assert.match(
        elements.courses.children[0].textContent,
        new RegExp(`Database Concepts \\(${COURSE_ID}\\)`)
    );

    assert.match(
        elements.courses.children[1].textContent,
        new RegExp(`Algorithms \\(${COURSE_ID_2}\\)`)
    );

    assert.equal(elements.approve.disabled, true);

    elements.courses.selectedOptions = [elements.courses.children[1]];
    elements.courses.listeners.change();

    assert.equal(elements.approve.disabled, true);

    elements.difficulty.value = 'Advanced';
    elements.difficulty.listeners.change();

    assert.equal(elements.approve.disabled, false);

    elements.notes.value = 'Looks good';

    await elements.approve.listeners.click();

    assert.match(confirmation, /Approve submission #17/);

    assert.deepEqual(approvalPayload, {
        reviewNotes: 'Looks good',
        courseIds: [COURSE_ID_2],
        difficultyLevel: 'Advanced'
    });

    assert.ok(paths.includes('/admin/submissions/17/approve'));
    assert.equal(elements.queueNotice.textContent, 'Submission approved.');
});

test('concept approval cannot proceed without a valid administrator difficulty', async () => {
    const elements = createElements();
    let approvalCalls = 0;

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                if (path === '/admin/submissions/courses') {
                    return {
                        courses: [{
                            courseId: 1,
                            courseGraphId: COURSE_ID,
                            title: 'Database Concepts'
                        }]
                    };
                }

                return { submission: submission() };
            },

            async patch() {
                approvalCalls += 1;
                return { success: true };
            }
        }
    });

    await controller.openDetail(17);

    elements.courses.selectedOptions = [elements.courses.children[0]];
    elements.courses.listeners.change();

    assert.equal(elements.approve.disabled, true);

    await controller.review('approved');

    assert.equal(approvalCalls, 0);
    assert.match(elements.actionMessage.textContent, /difficulty level/i);
});

test('course load failure keeps concept approval unavailable without creating a course', async () => {
    const elements = createElements();
    const paths = [];

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                paths.push(path);

                if (path === '/admin/submissions/courses') {
                    throw new Error('graph unavailable');
                }

                return { success: true, submission: submission() };
            }
        }
    });

    await controller.openDetail(17);

    assert.deepEqual(paths, [
        '/admin/submissions/17',
        '/admin/submissions/courses'
    ]);

    assert.equal(elements.approve.disabled, true);
    assert.match(elements.courseMessage.textContent, /Course lookup failed/i);
});

test('course proposal approval requires administrator difficulty and records the canonical course', async () => {
    const elements = createElements();
    const paths = [];

    let approvalPayload;

    const courseSubmission = submission({
        submissionType: 'COURSE',
        submissionData: {
            title: 'Database Foundations',
            description: 'Core topics'
        }
    });

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                paths.push(path);

                if (path.startsWith('/admin/submissions?page=')) {
                    return queueResult([submission()]);
                }

                return { submission: courseSubmission };
            },

            async patch(path, body) {
                paths.push(path);
                approvalPayload = body;

                return {
                    success: true,
                    submission: courseSubmission
                };
            }
        }
    });

    await controller.openDetail(17);

    assert.equal(elements.courseDifficultyField.hidden, false);
    assert.equal(elements.approve.disabled, true);

    elements.courseDifficulty.value = 'Advanced';
    elements.courseDifficulty.listeners.change();

    assert.equal(elements.approve.disabled, false);

    await elements.approve.listeners.click();

    assert.ok(paths.includes('/admin/submissions/17/approve'));

    assert.deepEqual(approvalPayload, {
        reviewNotes: null,
        difficultyLevel: 'Advanced'
    });

    assert.ok(controller);
});

test('course selector distinguishes an empty graph from a failed course lookup', async () => {
    const empty = createElements();

    const emptyController = createController({
        elements: empty,
        api: {
            async get(path) {
                return path === '/admin/submissions/courses'
                    ? { courses: [] }
                    : { submission: submission() };
            }
        }
    }).controller;

    await emptyController.openDetail(17);

    assert.match(
        empty.courseMessage.textContent,
        /No approved courses are available/i
    );

    assert.equal(empty.approve.disabled, true);

    const failed = createElements();

    const failedController = createController({
        elements: failed,
        api: {
            async get(path) {
                if (path === '/admin/submissions/courses') {
                    throw new Error('offline');
                }

                return { submission: submission() };
            }
        }
    }).controller;

    await failedController.openDetail(17);

    assert.match(
        failed.courseMessage.textContent,
        /Course lookup failed/i
    );

    assert.equal(failed.approve.disabled, true);

    const malformed = createElements();

    const malformedController = createController({
        elements: malformed,
        api: {
            async get(path) {
                if (path === '/admin/submissions/courses') {
                    return {
                        courses: [{
                            courseId: 3,
                            courseGraphId: 'legacy-id',
                            title: 'Database Concepts'
                        }]
                    };
                }

                return { submission: submission() };
            }
        }
    }).controller;

    await malformedController.openDetail(17);

    assert.match(
        malformed.courseMessage.textContent,
        /none has a valid knowledge-graph course ID/i
    );

    assert.equal(malformed.approve.disabled, true);
});

test('resource approval requires an administrator-selected Database Concept', async () => {
    const elements = createElements();
    const paths = [];
    const payloads = [];

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                paths.push(path);

                if (path === '/admin/submissions/23') {
                    return {
                        success: true,
                        submission: submission({
                            submissionId: 23,
                            submissionType: 'RESOURCE',
                            submissionData: {
                                title: 'Relational notes',
                                type: 'document',
                                document: {
                                    originalName: 'notes.pdf',
                                    documentType: 'PDF'
                                }
                            }
                        })
                    };
                }

                if (path === '/admin/submissions/database-concepts') {
                    return {
                        success: true,
                        concepts: [
                            { concept_id: 9, name: 'Relational Model' },
                            { concept_id: 10, name: 'Normalization' }
                        ]
                    };
                }

                return queueResult([], 1, 0, 0);
            },

            async patch(path, payload) {
                paths.push(path);
                payloads.push(payload);
                return { success: true };
            }
        }
    });

    await controller.openDetail(23);

    assert.equal(elements.difficultyField.hidden, true);
    assert.equal(elements.resourceConceptField.hidden, false);

    assert.deepEqual(
        elements.resourceConcept.children.slice(1).map(option => option.value),
        ['9', '10']
    );

    assert.equal(elements.approve.disabled, true);

    await elements.approve.listeners.click();

    assert.equal(payloads.length, 0);

    elements.resourceConcept.value = '10';
    elements.resourceConcept.listeners.change();

    assert.equal(elements.approve.disabled, false);

    await elements.approve.listeners.click();

    assert.deepEqual(payloads[0], {
        reviewNotes: null,
        conceptId: '10'
    });

    assert.ok(paths.includes('/admin/submissions/23/approve'));
});

test('resource approval stays unavailable when the approved Database Concepts list is empty', async () => {
    const elements = createElements();

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                if (path === '/admin/submissions/24') {
                    return {
                        success: true,
                        submission: submission({
                            submissionId: 24,
                            submissionType: 'RESOURCE',
                            submissionData: {
                                title: 'Lecture notes',
                                type: 'document',
                                document: {
                                    originalName: 'notes.pdf'
                                }
                            }
                        })
                    };
                }

                if (path === '/admin/submissions/database-concepts') {
                    return {
                        success: true,
                        domainAvailable: true,
                        emptyReason: 'no_approved_concepts',
                        concepts: []
                    };
                }

                return queueResult([], 1, 0, 0);
            },

            async patch() {
                assert.fail('resource must not be approved without a concept');
            }
        }
    });

    await controller.openDetail(24);

    assert.equal(elements.difficultyField.hidden, true);
    assert.equal(elements.resourceConceptField.hidden, false);
    assert.equal(elements.resourceConcept.disabled, true);
    assert.equal(elements.approve.disabled, true);

    assert.match(
        elements.resourceConceptMessage.textContent,
        /Approve a concept first/i
    );
});

test('resource approval preserves the student-selected course and concept association', async () => {
    const elements = createElements();
    const payloads = [];

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                if (path === '/admin/submissions/26') {
                    return {
                        submission: submission({
                            submissionId: 26,
                            submissionType: 'RESOURCE',
                            submissionData: {
                                title: 'Joins notes',
                                type: 'document',
                                courseId: 'COURSE-1',
                                conceptId: 11,
                                document: {
                                    originalName: 'joins.pdf'
                                }
                            }
                        })
                    };
                }

                if (path === '/admin/submissions/database-concepts') {
                    return {
                        concepts: [{
                            concept_id: 1,
                            name: 'Other Database concept'
                        }]
                    };
                }

                if (path === '/admin/submissions/courses/COURSE-1/concepts') {
                    return {
                        concepts: [
                            { concept_id: 11, name: 'Joins' },
                            { concept_id: 12, name: 'Indexes' }
                        ]
                    };
                }

                return queueResult([], 1, 0, 0);
            },

            async patch(path, payload) {
                payloads.push({ path, payload });
                return { success: true };
            }
        }
    });

    await controller.openDetail(26);

    assert.deepEqual(
        elements.resourceConcept.children.slice(1).map(option => option.value),
        ['11']
    );

    assert.match(
        elements.resourceConceptMessage.textContent,
        /cannot be changed during review/i
    );

    elements.resourceConcept.value = '11';
    elements.resourceConcept.listeners.change();

    assert.equal(elements.approve.disabled, false);

    await elements.approve.listeners.click();

    assert.deepEqual(payloads[0].payload, {
        reviewNotes: null,
        conceptId: '11'
    });
});

test('opening a resource refreshes a previously empty approved concept cache', async () => {
    const elements = createElements();

    elements.prerequisiteForm = new FakeElement();
    elements.prerequisiteFields = new FakeElement();
    elements.prerequisiteBefore = new FakeElement();
    elements.prerequisiteAfter = new FakeElement();
    elements.prerequisiteSubmit = new FakeElement();
    elements.prerequisiteMessage = new FakeElement();

    let lookupCount = 0;

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                if (path === '/admin/submissions/database-concepts') {
                    lookupCount += 1;

                    return lookupCount === 1
                        ? {
                            success: true,
                            domainAvailable: true,
                            emptyReason: 'no_approved_concepts',
                            concepts: []
                        }
                        : {
                            success: true,
                            domainAvailable: true,
                            concepts: [{
                                concept_id: 88,
                                name: 'Normalization'
                            }]
                        };
                }

                if (path === '/admin/submissions/25') {
                    return {
                        submission: submission({
                            submissionId: 25,
                            submissionType: 'RESOURCE',
                            submissionData: {
                                title: 'Notes',
                                type: 'document'
                            }
                        })
                    };
                }

                return queueResult([], 1, 0, 0);
            }
        }
    });

    await new Promise(resolve => setImmediate(resolve));
    await controller.openDetail(25);

    assert.equal(lookupCount, 2);

    assert.deepEqual(
        elements.resourceConcept.children.slice(1).map(option => option.value),
        ['88']
    );

    assert.equal(elements.resourceConcept.disabled, false);

    elements.resourceConcept.value = '88';
    elements.resourceConcept.listeners.change();

    assert.equal(elements.approve.disabled, false);
});

test('prerequisite controls stay hidden with fewer than two approved Database Concepts', async t => {
    for (const concepts of [
        [],
        [{ concept_id: 31, name: 'Tables' }]
    ]) {
        await t.test(`${concepts.length} concepts`, async () => {
            const elements = createElements();

            elements.prerequisiteForm = new FakeElement();
            elements.prerequisiteFields = new FakeElement();
            elements.prerequisiteBefore = new FakeElement();
            elements.prerequisiteAfter = new FakeElement();
            elements.prerequisiteSubmit = new FakeElement();
            elements.prerequisiteMessage = new FakeElement();

            const { controller } = createController({
                elements,
                api: {
                    async get(path) {
                        return path === '/admin/submissions/database-concepts'
                            ? { success: true, concepts }
                            : queueResult([], 1, 0, 0);
                    }
                }
            });

            await new Promise(resolve => setImmediate(resolve));

            assert.equal(elements.prerequisiteFields.hidden, true);
            assert.equal(elements.prerequisiteBefore.disabled, true);
            assert.equal(elements.prerequisiteAfter.disabled, true);
            assert.equal(elements.prerequisiteSubmit.disabled, true);

            assert.match(
                elements.prerequisiteMessage.textContent,
                /at least two approved Database Concepts must exist/i
            );

            assert.ok(controller);
        });
    }
});

test('prerequisite controls appear with two concepts and require distinct selections before submission', async () => {
    const elements = createElements();

    elements.prerequisiteForm = Object.assign(
        new FakeElement(),
        {
            reset() {
                this.resetCount = (this.resetCount || 0) + 1;
            }
        }
    );

    elements.prerequisiteFields = new FakeElement();
    elements.prerequisiteBefore = new FakeElement();
    elements.prerequisiteAfter = new FakeElement();
    elements.prerequisiteSubmit = new FakeElement();
    elements.prerequisiteSubmit.disabled = true;
    elements.prerequisiteMessage = new FakeElement();

    const posted = [];

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                if (path === '/admin/submissions/database-concepts') {
                    return {
                        success: true,
                        concepts: [
                            { concept_id: 31, name: 'Tables' },
                            { concept_id: 32, name: 'Keys' }
                        ]
                    };
                }

                return queueResult([], 1, 0, 0);
            },

            async post(path, payload) {
                posted.push({ path, payload });
                return { success: true };
            }
        }
    });

    await new Promise(resolve => setImmediate(resolve));

    assert.equal(elements.prerequisiteFields.hidden, false);
    assert.equal(elements.prerequisiteBefore.disabled, false);
    assert.equal(elements.prerequisiteAfter.disabled, false);
    assert.equal(elements.prerequisiteSubmit.disabled, true);

    elements.prerequisiteBefore.value = '31';
    elements.prerequisiteAfter.value = '31';

    elements.prerequisiteBefore.listeners.change();
    elements.prerequisiteAfter.listeners.change();

    assert.equal(
        elements.prerequisiteSubmit.disabled,
        true,
        'same concept cannot be selected on both sides'
    );

    elements.prerequisiteBefore.value = '31';
    elements.prerequisiteAfter.value = '32';

    elements.prerequisiteAfter.listeners.change();

    assert.equal(elements.prerequisiteSubmit.disabled, false);

    await elements.prerequisiteForm.listeners.submit({
        preventDefault() { }
    });

    assert.deepEqual(posted, [{
        path: '/admin/submissions/prerequisites',
        payload: {
            prerequisiteId: '31',
            targetId: '32'
        }
    }]);

    assert.match(
        elements.prerequisiteMessage.textContent,
        /added to the review queue/i
    );

    assert.equal(elements.prerequisiteForm.resetCount, 1);
    assert.ok(controller);
});

test('difficulty selector is present for pending concepts only with the three supported levels', async () => {
    const html = fs.readFileSync(
        path.join(__dirname, '../../frontend/admin.html'),
        'utf8'
    );

    // Check the complete HTML instead of relying on a restrictive div regex.
    assert.match(html, /id="admin-review-difficulty"/);

    const difficultyLevels = Array.from(
        html.matchAll(
            /<option value="(Beginner|Intermediate|Advanced)">/g
        ),
        match => match[1]
    );

    assert.equal(difficultyLevels.length, 6);

    assert.deepEqual(
        difficultyLevels.slice(0, 3),
        ['Beginner', 'Intermediate', 'Advanced']
    );

    assert.deepEqual(
        difficultyLevels.slice(3, 6),
        ['Beginner', 'Intermediate', 'Advanced']
    );

    const elements = createElements();

    const { controller } = createController({
        elements,
        api: {
            async get(path) {
                if (path === '/admin/submissions/courses') {
                    return {
                        courses: [{
                            courseId: 1,
                            courseGraphId: COURSE_ID,
                            title: 'Database Concepts'
                        }]
                    };
                }

                if (path === '/admin/submissions/18') {
                    return {
                        submission: submission({ status: 'approved' })
                    };
                }

                if (path === '/admin/submissions/19') {
                    return {
                        submission: submission({
                            submissionType: 'RESOURCE'
                        })
                    };
                }

                return { submission: submission() };
            }
        }
    });

    await controller.openDetail(17);
    assert.equal(elements.difficultyField.hidden, false);

    await controller.openDetail(18);
    assert.equal(elements.difficultyField.hidden, true);

    await controller.openDetail(19);
    assert.equal(elements.difficultyField.hidden, true);
});

test('rejection confirms finality and sends the actual notes payload', async () => {
    const elements = createElements();
    const paths = [];

    let payload;
    let confirmation = '';

    const { controller } = createController({
        elements,

        confirmFn(message) {
            confirmation = message;
            return true;
        },

        api: {
            async get(path) {
                paths.push(path);

                return path === '/admin/submissions/17'
                    ? {
                        success: true,
                        submission: submission({
                            submissionType: 'PREREQUISITE',
                            submissionData: {
                                prerequisiteId: 'C001',
                                targetId: 'C002'
                            }
                        })
                    }
                    : queueResult([], 1, 0, 0);
            },

            async patch(path, body) {
                paths.push(path);
                payload = body;
                return { success: true };
            }
        }
    });

    await controller.openDetail(17);

    elements.notes.value = 'Please provide a stronger rationale.';

    await elements.reject.listeners.click();

    assert.match(confirmation, /final and cannot be undone/i);

    assert.deepEqual(payload, {
        reviewNotes: 'Please provide a stronger rationale.'
    });

    assert.ok(paths.includes('/admin/submissions/17/reject'));

    assert.ok(
        paths.some(path =>
            path.startsWith('/admin/submissions?page=')
        )
    );
});

test('cancelled confirmation makes no change and duplicate action requests are prevented', async t => {
    await t.test('cancel', async () => {
        const elements = createElements();
        let patches = 0;

        const { controller } = createController({
            elements,
            confirmFn: () => false,
            api: {
                async get(path) {
                    return {
                        success: true,
                        submission: submission({
                            submissionType: 'RESOURCE'
                        })
                    };
                },

                async patch() {
                    patches += 1;
                }
            }
        });

        await controller.openDetail(17);
        await elements.reject.listeners.click();

        assert.equal(patches, 0);
        assert.equal(elements.detail.hidden, false);
    });

    await t.test('duplicate action', async () => {
        const elements = createElements();

        let resolvePatch;
        let patches = 0;

        const { controller } = createController({
            elements,
            api: {
                async get(path) {
                    if (path === '/admin/submissions/courses') {
                        return {
                            courses: [{
                                courseId: 1,
                                courseGraphId: COURSE_ID,
                                title: 'Database Concepts'
                            }]
                        };
                    }

                    if (path === '/admin/submissions/database-concepts') {
                        return { concepts: [] };
                    }

                    if (path.includes('?')) {
                        return queueResult([], 1, 0, 0);
                    }

                    return {
                        success: true,
                        submission: submission()
                    };
                },

                patch() {
                    patches += 1;
                    return new Promise(resolve => {
                        resolvePatch = resolve;
                    });
                }
            }
        });

        await controller.openDetail(17);

        elements.courses.selectedOptions = [elements.courses.children[0]];
        elements.courses.listeners.change();

        elements.difficulty.value = 'Beginner';
        elements.difficulty.listeners.change();

        const first = elements.approve.listeners.click();
        const second = elements.approve.listeners.click();

        assert.equal(patches, 1);
        assert.equal(elements.approve.disabled, true);

        resolvePatch({ success: true });

        await Promise.all([first, second]);

        assert.equal(
            elements.queueNotice.textContent,
            'Submission approved.'
        );
    });
});

test('approval and rejection failures preserve notes and selected courses', async t => {
    await t.test('validation failure', async () => {
        const elements = createElements();

        const { controller } = createController({
            elements,
            api: {
                async get(path) {
                    if (path === '/admin/submissions/courses') {
                        return {
                            success: true,
                            courses: [{
                                courseId: 1,
                                courseGraphId: COURSE_ID,
                                title: 'Database Concepts'
                            }]
                        };
                    }

                    return { success: true, submission: submission() };
                },

                async patch() {
                    const error = new Error(
                        'One or more selected courses do not exist.'
                    );
                    error.status = 422;
                    throw error;
                }
            }
        });

        await controller.openDetail(17);

        elements.notes.value = 'Keep this note';

        elements.courses.selectedOptions = [elements.courses.children[0]];
        elements.courses.listeners.change();

        elements.difficulty.value = 'Beginner';
        elements.difficulty.listeners.change();

        await elements.approve.listeners.click();

        assert.equal(elements.notes.value, 'Keep this note');

        assert.deepEqual(
            elements.courses.selectedOptions.map(option => option.value),
            [COURSE_ID]
        );

        assert.equal(
            elements.actionMessage.textContent,
            'One or more selected courses do not exist.'
        );
    });

    await t.test('network failure', async () => {
        const elements = createElements();

        const { controller } = createController({
            elements,
            api: {
                async get() {
                    return {
                        success: true,
                        submission: submission({
                            submissionType: 'RESOURCE'
                        })
                    };
                },

                async patch() {
                    throw new Error('internal details');
                }
            }
        });

        await controller.openDetail(17);

        elements.notes.value = 'Keep rejection note';

        await elements.reject.listeners.click();

        assert.equal(elements.notes.value, 'Keep rejection note');

        assert.match(
            elements.actionMessage.textContent,
            /could not be completed/i
        );

        assert.doesNotMatch(
            elements.actionMessage.textContent,
            /internal details/i
        );
    });
});

test('401 and 403 receive safe, distinct queue and detail messages', async t => {
    for (const [status, expected] of [
        [401, /session expired/i],
        [403, /not allowed/i]
    ]) {
        await t.test(String(status), async () => {
            const elements = createElements();

            const { controller } = createController({
                elements,
                api: {
                    async get() {
                        const error = new Error('private detail');
                        error.status = status;
                        throw error;
                    }
                }
            });

            await controller.loadQueue(1);

            assert.match(elements.queueError.textContent, expected);

            assert.doesNotMatch(
                elements.queueError.textContent,
                /private detail/
            );

            await controller.openDetail(17);

            assert.match(elements.detailError.textContent, expected);

            assert.doesNotMatch(
                elements.detailError.textContent,
                /private detail/
            );
        });
    }
});

test('course dropdown uses distinct existing canonical course IDs', () => {
    const select = new FakeElement();

    const count = populateCourseSelect(
        select,
        [
            { course_id: 'COURSE-001', name: 'Biology' },
            { course_id: 'COURSE-001', name: 'Duplicate' },
            { course_id: 2, name: 'Invalid numeric ID' },
            { course_id: 'COURSE-002', name: 'Biology' }
        ],
        createDocument()
    );

    assert.equal(count, 2);

    assert.deepEqual(
        select.children.map(option => option.value),
        ['COURSE-001', 'COURSE-002']
    );

    assert.deepEqual(
        select.children.map(option => option.textContent),
        [
            'Biology (COURSE-001)',
            'Biology (COURSE-002)'
        ]
    );
});