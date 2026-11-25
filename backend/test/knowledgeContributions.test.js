'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {
    createSubmissionHandler,
    createResourceIdempotencyKey,
    clearResourceIdempotencyKey,
    createSubmissionHistory,
    initializeKnowledgeContributions,
    loadConceptOptions,
    populateConceptSelect,
    renderSubmissionHistory,
    isResourceSubmissionReady,
    validateConceptPayload,
    validatePrerequisitePayload,
    validateResourcePayload
} = require('../../frontend/knowledge-contributions');

function createOptionDocument() {
    return {
        createElement(tagName) {
            assert.equal(tagName, 'option');
            return { value: '', textContent: '', disabled: false, selected: false };
        }
    };
}

function createSelect() {
    return {
        options: [],
        value: '',
        replaceChildren(...options) { this.options = options; }
    };
}

function createForm() {
    return { resetCount: 0, reset() { this.resetCount += 1; } };
}

function createButton() {
    return { disabled: false, textContent: 'Submit' };
}

function createFeedback() {
    return { textContent: '', dataset: {} };
}

function expectFileDisplay(file) {
    return `${file.name} (${Math.ceil(file.size / 1024)} KB)`;
}

function createHistoryElement() {
    return {
        textContent: '',
        className: '',
        hidden: false,
        disabled: false,
        dataset: {},
        children: [],
        listeners: {},
        append(...children) { this.children.push(...children); },
        replaceChildren(...children) { this.children = children; },
        addEventListener(type, callback) { this.listeners[type] = callback; },
        setAttribute(name, value) { this[name] = value; }
    };
}

function createHistoryDocument() {
    return {
        createElement() { return createHistoryElement(); },
        createTextNode(text) { return { textContent: text }; }
    };
}

function createHistoryElements() {
    return {
        list: createHistoryElement(),
        loading: createHistoryElement(),
        empty: createHistoryElement(),
        error: createHistoryElement(),
        pagination: createHistoryElement(),
        previous: createHistoryElement(),
        next: createHistoryElement(),
        refresh: createHistoryElement()
    };
}

test('concept validation sends name and description only; student difficulty is ignored', () => {
    assert.deepEqual(validateConceptPayload({
        name: '  Algebra  ', description: ' Foundations ', difficultyLevel: 'Introductory '
    }), {
        name: 'Algebra', description: 'Foundations'
    });
    assert.deepEqual(validateConceptPayload({ name: 'Algebra', description: '', difficultyLevel: '' }), {
        name: 'Algebra'
    });
    assert.throws(() => validateConceptPayload({ name: '  ' }), /Concept name is required/);
    assert.throws(() => validateConceptPayload({ name: 'x'.repeat(151) }), /150 characters/);
    assert.throws(() => validateConceptPayload({ name: 'A', description: 'x'.repeat(5001) }), /5000 characters/);
});

test('resource validation requires title, approved course, approved concept, and a selected document', () => {
    const file = { name: 'notes.pdf', size: 1200 };
    const payload = validateResourcePayload({ title: 'Notes', courseId: 'COURSE-1', conceptId: '11', file });
    assert.deepEqual(payload, { title: 'Notes', courseId: 'COURSE-1', conceptId: '11', type: 'document', file });
    assert.throws(() => validateResourcePayload({ title: 'Notes', conceptId: '11', file }), /Approved course is required/);
    assert.throws(() => validateResourcePayload({ title: 'Notes', courseId: 'COURSE-1', file }), /Approved concept is required/);
    assert.throws(() => validateResourcePayload({ title: 'Notes', courseId: 'COURSE-1', conceptId: '11', file: { name: 'notes.exe' } }), /Choose a PDF/);
    assert.throws(() => validateResourcePayload({ courseId: 'COURSE-1', conceptId: '11', title: 'x'.repeat(256), file }), /255 characters/);
});

test('resource readiness requires a valid title and a processor-supported document extension', () => {
    for (const name of ['resource.pdf', 'slides.pptx', 'notes.docx']) {
        assert.equal(isResourceSubmissionReady(' Resource ', { name }), true, name);
    }
    for (const name of ['slides.PPT', 'notes.DOC', 'resource.exe']) {
        assert.equal(isResourceSubmissionReady('Resource', { name }), false, name);
    }
    assert.equal(isResourceSubmissionReady('', { name: 'notes.pdf' }), false);
    assert.equal(isResourceSubmissionReady('x'.repeat(256), { name: 'notes.pdf' }), false);
    assert.equal(isResourceSubmissionReady('Resource', null), false);
    assert.equal(isResourceSubmissionReady('Resource', { name: 'resource.exe' }), false);
    assert.equal(isResourceSubmissionReady('Resource', { name: 'notes.pdf.exe' }), false);
});

test('resource button follows title and file changes, locks during upload, preserves failures, and resets on success', async () => {
    const listeners = new Map();
    const title = { value: '', addEventListener(type, callback) { listeners.set(`title:${type}`, callback); } };
    const fileInput = {
        value: '', files: [],
        addEventListener(type, callback) { listeners.set(`file:${type}`, callback); }
    };
    const fileName = { textContent: '', hidden: false };
    const course = createSelect();
    course.disabled = false;
    course.addEventListener = (type, callback) => listeners.set(`course:${type}`, callback);
    const concept = createSelect();
    concept.disabled = true;
    concept.addEventListener = (type, callback) => listeners.set(`concept:${type}`, callback);
    const conceptHelp = { textContent: '' };
    const removeButton = { hidden: true, addEventListener(type, callback) { listeners.set(`remove:${type}`, callback); } };
    const submitButton = { disabled: true, textContent: 'Submit resource' };
    const feedback = createFeedback();
    const conceptForm = {
        listeners: {}, querySelector: () => createButton(),
        addEventListener(type, callback) { this.listeners[type] = callback; }
    };
    const resourceForm = {
        listeners: {}, querySelector: () => submitButton,
        addEventListener(type, callback) { this.listeners[type] = callback; },
        reset() { title.value = ''; fileInput.value = ''; fileInput.files = []; course.value = ''; concept.value = ''; this.resetCount = (this.resetCount || 0) + 1; }
    };
    const elements = {
        'knowledge-contributions': { hidden: true },
        'concept-submission-form': conceptForm,
        'resource-submission-form': resourceForm,
        'resource-title': title,
        'resource-course': course,
        'resource-concept': concept,
        'resource-concept-help': conceptHelp,
        'resource-file': fileInput,
        'resource-file-name': fileName,
        'resource-file-remove': removeButton,
        'resource-submission-feedback': feedback,
        'concept-submission-feedback': createFeedback(),
        'concept-name': { value: '' },
        'concept-description': { value: '' },
        'concept-difficulty': { value: '' }
    };
    const document = {
        getElementById: id => elements[id] || null,
        createElement(tagName) { assert.equal(tagName, 'option'); return { value: '', textContent: '', disabled: false, selected: false }; }
    };
    let rejectFirstUpload;
    let calls = 0;
    const requests = [];
    const api = {
        isStudent: () => true,
        async get(path) {
            assert.equal(path, '/submissions/resource-options');
            return { courses: [{ courseId: 'COURSE-1', name: 'Database Concepts', concepts: [{ conceptId: 11, name: 'Normalization' }] }] };
        },
        post(path, body) {
            calls += 1;
            requests.push({ path, body });
            if (calls === 1) return new Promise((_resolve, reject) => { rejectFirstUpload = reject; });
            return Promise.resolve({ success: true });
        }
    };

    initializeKnowledgeContributions({ document, api });
    await new Promise(resolve => setImmediate(resolve));
    course.value = 'COURSE-1';
    listeners.get('course:change')();
    concept.value = '11';
    listeners.get('concept:change')();
    assert.equal(submitButton.disabled, true);
    title.value = '   ';
    listeners.get('title:input')();
    assert.equal(submitButton.disabled, true);
    title.value = 'Normalization notes';
    listeners.get('title:input')();
    assert.equal(submitButton.disabled, true, 'title alone is not enough');

    fileInput.files = [new File(['not inspected by the UI'], 'notes.exe')];
    listeners.get('file:change')();
    assert.equal(fileName.textContent, expectFileDisplay(fileInput.files[0]));
    assert.equal(submitButton.disabled, true, 'unsupported extensions stay disabled');

    fileInput.files = [new File(['%PDF-1.7'], 'Normalization.PDF', { type: 'application/pdf' })];
    listeners.get('file:change')();
    assert.equal(submitButton.disabled, false, 'valid title, selected course/concept, and supported extension enable submission');
    assert.equal(removeButton.hidden, false);

    const submit = resourceForm.listeners.submit;
    const first = submit({ preventDefault() {} });
    assert.equal(submitButton.disabled, true);
    assert.equal(submitButton.textContent, 'Submit resource', 'the spinner replaces transient button loading text');
    listeners.get('title:input')();
    listeners.get('file:change')();
    assert.equal(submitButton.disabled, true, 'input changes cannot re-enable while the request is pending');
    const duplicate = submit({ preventDefault() {} });
    assert.equal(calls, 1, 'a second submit while pending is ignored');
    const requestBody = requests[0].body;
    assert.equal(requests[0].path, '/submissions/resources');
    assert.ok(requestBody instanceof FormData);
    assert.deepEqual(Array.from(requestBody.keys()), ['title', 'courseId', 'conceptId', 'document']);
    assert.equal(requestBody.get('title'), 'Normalization notes');
    assert.equal(requestBody.get('courseId'), 'COURSE-1');
    assert.equal(requestBody.get('conceptId'), '11');
    assert.equal(requestBody.get('document').name, 'Normalization.PDF');

    rejectFirstUpload(Object.assign(new Error('Rejected'), { status: 400, message: 'Upload rejected.' }));
    await Promise.all([first, duplicate]);
    assert.equal(title.value, 'Normalization notes');
    assert.equal(fileInput.files[0].name, 'Normalization.PDF');
    assert.equal(submitButton.disabled, false, 'valid retained inputs can be retried');
    assert.equal(feedback.textContent, 'Upload rejected.');

    await submit({ preventDefault() {} });
    assert.equal(calls, 2);
    assert.equal(resourceForm.resetCount, 1);
    assert.equal(title.value, '');
    assert.equal(fileInput.files.length, 0);
    assert.equal(fileName.textContent, 'No document selected.');
    assert.equal(submitButton.disabled, true);
    assert.equal(feedback.textContent, 'Learning resource submitted for administrator review.');
    assert.equal(feedback.dataset.state, 'success');
});

test('student contribution form keeps course proposals, selected resource course/concept and no student prerequisite controls', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../frontend/dashboard.html'), 'utf8');
    const script = fs.readFileSync(path.join(__dirname, '../../frontend/knowledge-contributions.js'), 'utf8');
    assert.match(html, /Suggest a Course Concept/);
    assert.match(html, /administrator approval is required/i);
    assert.match(html, /id="resource-course"/);
    assert.match(html, /id="resource-concept"/);
    assert.doesNotMatch(html, /prerequisite-submission-form|admin-review-courses/);
    assert.doesNotMatch(html, /concept-difficulty|Difficulty level/);
    assert.doesNotMatch(script, /difficultyLevel|concept-difficulty/);
    assert.doesNotMatch(script, /endpoint:\s*'\/submissions\/prerequisites'/);
});

test('prerequisite validation requires two distinct concept identifiers', () => {
    assert.deepEqual(validatePrerequisitePayload({ prerequisiteId: 'C001', targetId: 'C002' }), {
        prerequisiteId: 'C001', targetId: 'C002'
    });
    assert.throws(() => validatePrerequisitePayload({ prerequisiteId: '', targetId: 'C002' }), /Prerequisite concept is required/);
    assert.throws(() => validatePrerequisitePayload({ prerequisiteId: 'C001', targetId: 'C001' }), /two different concepts/);
    assert.throws(() => validatePrerequisitePayload({ prerequisiteId: 'x'.repeat(101), targetId: 'C002' }), /100 characters/);
});

test('concept options use returned graph IDs and unambiguous labels, never names as values', async () => {
    const resourceSelect = createSelect();
    const prerequisiteSelect = createSelect();
    const targetSelect = createSelect();
    const document = createOptionDocument();
    let requestedPath;
    const concepts = [
        { concept_id: 'C001', name: 'Linear Algebra' },
        { concept_id: 'CONCEPT-uuid', name: 'Linear Algebra' },
        { concept_id: 'C001', name: 'Duplicate row' }
    ];
    const loaded = await loadConceptOptions({
        async get(path) { requestedPath = path; return { success: true, concepts }; }
    }, [resourceSelect, prerequisiteSelect, targetSelect], document);

    assert.equal(requestedPath, '/kg/concepts');
    assert.equal(loaded, concepts);
    assert.deepEqual(resourceSelect.options.map(option => option.value), ['', 'C001', 'CONCEPT-uuid']);
    assert.deepEqual(resourceSelect.options.map(option => option.textContent), [
        'Select a concept', 'Linear Algebra (C001)', 'Linear Algebra (CONCEPT-uuid)'
    ]);
    assert.equal(prerequisiteSelect.options[1].value, 'C001');
    assert.equal(targetSelect.options[2].value, 'CONCEPT-uuid');

    const fallbackSelect = createSelect();
    populateConceptSelect(fallbackSelect, [{ concept_id: 'C003' }], document);
    assert.equal(fallbackSelect.options[1].textContent, 'Concept (C003)');
});

test('concept loading reports an empty list as unavailable', async () => {
    await assert.rejects(
        loadConceptOptions({ async get() { return { success: true, concepts: [] }; } }, [createSelect()], createOptionDocument()),
        /No existing concepts/
    );
});

test('contribution controls remain hidden for non-student roles', () => {
    const section = { hidden: true };
    let apiCalls = 0;
    const result = initializeKnowledgeContributions({
        document: { getElementById: id => id === 'knowledge-contributions' ? section : null },
        api: { isStudent: () => false, async get() { apiCalls += 1; } }
    });
    assert.equal(result, false);
    assert.equal(section.hidden, true);
    assert.equal(apiCalls, 0);
});

test('successful submission sends the payload and clears the form only after confirmation', async () => {
    const form = createForm();
    const submitButton = createButton();
    const feedback = createFeedback();
    const calls = [];
    const handler = createSubmissionHandler({
        api: { async post(path, payload) { calls.push({ path, payload }); return { success: true }; } },
        form,
        submitButton,
        feedback,
        endpoint: '/submissions/concepts',
        buildPayload: () => validateConceptPayload({ name: 'Sets' }),
        successMessage: 'Concept sent.'
    });

    await handler({ preventDefault() {} });
    assert.deepEqual(calls, [{ path: '/submissions/concepts', payload: { name: 'Sets' } }]);
    assert.equal(form.resetCount, 1);
    assert.equal(feedback.textContent, 'Concept sent.');
    assert.equal(feedback.dataset.state, 'success');
    assert.equal(submitButton.disabled, false);
});

test('backend validation and network errors preserve entered form data', async t => {
    await t.test('backend validation', async () => {
        const form = createForm();
        const feedback = createFeedback();
        const handler = createSubmissionHandler({
            api: { async post() { const error = new Error('A concept with this name already exists.'); error.status = 409; throw error; } },
            form, submitButton: createButton(), feedback, endpoint: '/submissions/concepts',
            buildPayload: () => ({ name: 'Sets' }), successMessage: 'done'
        });
        await handler({ preventDefault() {} });
        assert.equal(form.resetCount, 0);
        assert.equal(feedback.textContent, 'A concept with this name already exists.');
    });

    await t.test('network failure', async () => {
        const form = createForm();
        const feedback = createFeedback();
        const handler = createSubmissionHandler({
            api: { async post() { throw new Error('Network connection detail'); } },
            form, submitButton: createButton(), feedback, endpoint: '/submissions/resources',
            buildPayload: () => ({ title: 'Notes' }), successMessage: 'done'
        });
        await handler({ preventDefault() {} });
        assert.equal(form.resetCount, 0);
        assert.match(feedback.textContent, /could not send/i);
        assert.doesNotMatch(feedback.textContent, /Network connection detail/);
    });
});

test('submission authorization errors are presented without exposing internals', async t => {
    for (const [status, expected] of [
        [401, /session expired/i],
        [403, /only student accounts/i]
    ]) {
        await t.test(String(status), async () => {
            const form = createForm();
            const feedback = createFeedback();
            const handler = createSubmissionHandler({
                api: { async post() { const error = new Error('Internal detail'); error.status = status; throw error; } },
                form, submitButton: createButton(), feedback, endpoint: '/submissions/concepts',
                buildPayload: () => ({ name: 'Sets' }), successMessage: 'done'
            });
            await handler({ preventDefault() {} });
            assert.match(feedback.textContent, expected);
            assert.doesNotMatch(feedback.textContent, /Internal detail/);
            assert.equal(form.resetCount, 0);
        });
    }
});

test('duplicate submissions are prevented while a request is pending', async () => {
    let finishRequest;
    let calls = 0;
    const form = createForm();
    const submitButton = createButton();
    const handler = createSubmissionHandler({
        api: { post() { calls += 1; return new Promise(resolve => { finishRequest = resolve; }); } },
        form,
        submitButton,
        feedback: createFeedback(),
        endpoint: '/submissions/prerequisites',
        buildPayload: () => ({ prerequisiteId: 'C001', targetId: 'C002' }),
        successMessage: 'Prerequisite sent.'
    });

    const first = handler({ preventDefault() {} });
    const second = handler({ preventDefault() {} });
    assert.equal(calls, 1);
    assert.equal(submitButton.disabled, true);
    finishRequest({ success: true });
    await Promise.all([first, second]);
    assert.equal(form.resetCount, 1);
    assert.equal(submitButton.disabled, false);
});

test('failed multipart resource submission keeps its form and selected file', async () => {
    const form = createForm();
    const file = { name: 'notes.pdf' };
    let sent;
    const handler = createSubmissionHandler({
        api: { async post() { throw Object.assign(new Error('upload rejected'), { status: 400 }); } },
        form, submitButton: createButton(), feedback: createFeedback(), endpoint: '/submissions/resources',
        buildPayload: () => validateResourcePayload({ courseId: 'COURSE-1', conceptId: '11', title: 'Notes', file }),
        send: async payload => { sent = payload; throw Object.assign(new Error('upload rejected'), { status: 400 }); },
        successMessage: 'done'
    });
    await handler({ preventDefault() {} });
    assert.equal(sent.file, file);
    assert.equal(form.resetCount, 0);
});

test('resource retry keys persist for unchanged submissions and rotate when the payload changes', () => {
    const values = new Map();
    const storage = {
        getItem(key) { return values.get(key) || null; },
        setItem(key, value) { values.set(key, value); },
        removeItem(key) { values.delete(key); }
    };
    let generated = 0;
    const cryptoProvider = { randomUUID() { generated += 1; return `33333333-3333-4333-8333-33333333333${generated}`; } };
    const file = { name: 'notes.pdf', size: 120, lastModified: 10 };
    const first = createResourceIdempotencyKey({ title: 'Notes', courseId: 'COURSE-1', conceptId: 11, file, storage, cryptoProvider });
    const retry = createResourceIdempotencyKey({ title: 'Notes', courseId: 'COURSE-1', conceptId: 11, file: { ...file }, storage, cryptoProvider });
    const changed = createResourceIdempotencyKey({ title: 'Notes', courseId: 'COURSE-1', conceptId: 12, file, storage, cryptoProvider });
    assert.equal(retry, first);
    assert.notEqual(changed, first);
    assert.equal(generated, 2);
    clearResourceIdempotencyKey(storage);
    assert.equal(values.size, 0);
});

test('history refresh failure does not reverse a confirmed resource submission success', async () => {
    const form = createForm();
    const feedback = createFeedback();
    const handler = createSubmissionHandler({
        api: { async post() { return { success: true }; } },
        form, submitButton: createButton(), feedback, endpoint: '/submissions/resources',
        buildPayload: () => ({ title: 'Notes', file: { name: 'notes.pdf' } }),
        successMessage: 'Learning resource submitted.',
        async afterSuccess() { throw new Error('history lookup unavailable'); }
    });
    await handler({ preventDefault() {} });
    assert.equal(form.resetCount, 1);
    assert.equal(feedback.textContent, 'Learning resource submitted.');
    assert.equal(feedback.dataset.state, 'success');
});

test('history renders each supported submission type, review status, and feedback as text', () => {
    const document = createHistoryDocument();
    const container = createHistoryElement();
    renderSubmissionHistory(container, [
        {
            submissionType: 'CONCEPT', submissionData: { name: '<Graph Theory>' },
            status: 'pending', submittedAt: '2026-02-03T10:00:00Z'
        },
        {
            submissionType: 'RESOURCE', submissionData: { title: 'Graph notes' },
            status: 'approved', submittedAt: '2026-02-04T10:00:00Z'
        },
        {
            submissionType: 'PREREQUISITE', submissionData: { prerequisiteId: 'C001', targetId: 'C002' },
            status: 'rejected', submittedAt: '2026-02-05T10:00:00Z', reviewNotes: 'Please clarify the relationship.'
        }
    ], document);

    assert.equal(container.children.length, 3);
    assert.equal(container.children[0].children[0].textContent, '<Graph Theory>');
    assert.equal(container.children[0].children[1].textContent, 'Concept');
    assert.equal(container.children[0].children[2].textContent, 'Pending review');
    assert.equal(container.children[1].children[0].textContent, 'Graph notes');
    assert.equal(container.children[1].children[1].textContent, 'Learning resource');
    assert.equal(container.children[1].children[2].textContent, 'Approved');
    assert.equal(container.children[2].children[0].textContent, 'C001 must be learned before C002');
    assert.equal(container.children[2].children[2].textContent, 'Rejected');
    assert.match(container.children[2].children[4].children[1].textContent, /Please clarify/);
    assert.match(container.children[0].children[3].textContent, /Submitted/);
});

test('history handles an empty result and disables pagination at its boundaries', async () => {
    const elements = createHistoryElements();
    const calls = [];
    const history = createSubmissionHistory({
        api: { async get(path) {
            calls.push(path);
            return { success: true, submissions: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } };
        } },
        document: createHistoryDocument(),
        elements
    });

    await history.load(1);
    assert.deepEqual(calls, ['/submissions?page=1&limit=10']);
    assert.equal(elements.empty.hidden, false);
    assert.equal(elements.pagination.textContent, 'No submissions yet.');
    assert.equal(elements.previous.disabled, true);
    assert.equal(elements.next.disabled, true);
    assert.equal(elements.loading.hidden, true);
});

test('history pagination follows server metadata and enforces previous/next boundaries', async () => {
    const elements = createHistoryElements();
    const calls = [];
    const history = createSubmissionHistory({
        api: { async get(path) {
            calls.push(path);
            const page = Number(new URL(`https://local.test${path}`).searchParams.get('page'));
            return {
                success: true,
                submissions: [{ submissionType: 'CONCEPT', submissionData: { name: `Page ${page}` }, status: 'pending' }],
                pagination: { page, limit: 10, total: 11, totalPages: 2 }
            };
        } },
        document: createHistoryDocument(),
        elements
    });

    await history.load(1);
    assert.equal(elements.previous.disabled, true);
    assert.equal(elements.next.disabled, false);
    await elements.next.listeners.click();
    assert.equal(history.getCurrentPage(), 2);
    assert.equal(elements.previous.disabled, false);
    assert.equal(elements.next.disabled, true);
    await elements.previous.listeners.click();
    assert.equal(history.getCurrentPage(), 1);
    assert.deepEqual(calls, [
        '/submissions?page=1&limit=10',
        '/submissions?page=2&limit=10',
        '/submissions?page=1&limit=10'
    ]);
});

test('history shows loading and safe network, unauthorized, and forbidden messages', async t => {
    await t.test('network error', async () => {
        const elements = createHistoryElements();
        let finish;
        const history = createSubmissionHistory({
            api: { get() { return new Promise((resolve, reject) => { finish = reject; }); } },
            document: createHistoryDocument(), elements
        });
        const pending = history.load();
        assert.equal(elements.loading.hidden, false);
        finish(new Error('private database detail'));
        await pending;
        assert.equal(elements.loading.hidden, true);
        assert.match(elements.error.textContent, /could not be loaded/i);
        assert.doesNotMatch(elements.error.textContent, /private database detail/i);
    });

    for (const [status, expected] of [[401, /session expired/i], [403, /not allowed/i]]) {
        await t.test(String(status), async () => {
            const elements = createHistoryElements();
            const history = createSubmissionHistory({
                api: { async get() { const error = new Error('internal details'); error.status = status; throw error; } },
                document: createHistoryDocument(), elements
            });
            await history.load();
            assert.match(elements.error.textContent, expected);
            assert.doesNotMatch(elements.error.textContent, /internal details/i);
        });
    }
});

test('successful contribution refreshes history from page one without supplying another learner identity', async () => {
    const elements = createHistoryElements();
    const requestedPaths = [];
    const history = createSubmissionHistory({
        api: { async get(path) {
            requestedPaths.push(path);
            return { success: true, submissions: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } };
        } },
        document: createHistoryDocument(), elements
    });
    await history.load(3);
    await createSubmissionHandler({
        api: { async post() { return { success: true }; } },
        form: createForm(), submitButton: createButton(), feedback: createFeedback(),
        endpoint: '/submissions/concepts', buildPayload: () => ({ name: 'Sets' }),
        successMessage: 'Submitted.', afterSuccess: () => history.refresh()
    })({ preventDefault() {} });

    assert.deepEqual(requestedPaths, ['/submissions?page=3&limit=10', '/submissions?page=1&limit=10']);
    assert.equal(history.getCurrentPage(), 1);
});
