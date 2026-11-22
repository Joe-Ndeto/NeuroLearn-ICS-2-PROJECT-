'use strict';

(function initializeKnowledgeContributionsModule(root) {
    class SubmissionValidationError extends Error {
        constructor(message) {
            super(message);
            this.name = 'SubmissionValidationError';
        }
    }

    function requiredText(value, label, maxLength) {
        if (typeof value !== 'string' || !value.trim()) {
            throw new SubmissionValidationError(`${label} is required.`);
        }
        const trimmed = value.trim();
        if (trimmed.length > maxLength) {
            throw new SubmissionValidationError(`${label} must not exceed ${maxLength} characters.`);
        }
        return trimmed;
    }

    function optionalText(value, label, maxLength) {
        if (value === undefined || value === null || value === '') return '';
        if (typeof value !== 'string') {
            throw new SubmissionValidationError(`${label} must be text.`);
        }
        const trimmed = value.trim();
        if (trimmed.length > maxLength) {
            throw new SubmissionValidationError(`${label} must not exceed ${maxLength} characters.`);
        }
        return trimmed;
    }

    function validateConceptPayload(fields) {
        const payload = {
            name: requiredText(fields.name, 'Concept name', 150)
        };
        const description = optionalText(fields.description, 'Description', 5000);
        if (description) payload.description = description;
        return payload;
    }

    function validateCoursePayload(fields) {
        const title = requiredText(fields.title, 'Course title', 200);
        const description = optionalText(fields.description, 'Description', 5000);
        return { title, description };
    }

    function validateResourcePayload(fields) {
        const title = requiredText(fields.title, 'Resource title', 255);
        const courseId = requiredText(fields.courseId, 'Approved course', 100);
        const conceptId = requiredText(fields.conceptId, 'Approved concept', 100);
        if (!fields.file || !fields.file.name) throw new SubmissionValidationError('Choose a PDF, PowerPoint or Word document.');
        if (!isResourceSubmissionReady(title, fields.file)) {
            throw new SubmissionValidationError('Choose a PDF, PowerPoint or Word document.');
        }
        return { title, courseId, conceptId, type: 'document', file: fields.file };
    }

    const RESOURCE_FILE_EXTENSIONS = new Set(['.pdf', '.ppt', '.pptx', '.doc', '.docx']);

    function isResourceSubmissionReady(title, file) {
        if (typeof title !== 'string' || !title.trim() || title.trim().length > 255 || !file || typeof file.name !== 'string') {
            return false;
        }
        const filename = file.name.trim().toLowerCase();
        const separator = filename.lastIndexOf('.');
        return separator >= 0 && RESOURCE_FILE_EXTENSIONS.has(filename.slice(separator));
    }

    const RESOURCE_RETRY_STORAGE_KEY = 'neurolearnResourceSubmissionRetry';

    function resourceSubmissionSignature({ title, courseId, conceptId, file }) {
        return JSON.stringify([
            String(title || '').trim(),
            String(courseId || ''),
            String(conceptId || ''),
            String(file?.name || ''),
            Number(file?.size || 0),
            Number(file?.lastModified || 0)
        ]);
    }

    function createResourceIdempotencyKey({ title, courseId, conceptId, file, storage, cryptoProvider }) {
        const signature = resourceSubmissionSignature({ title, courseId, conceptId, file });
        try {
            const stored = JSON.parse(storage?.getItem(RESOURCE_RETRY_STORAGE_KEY) || 'null');
            if (stored?.signature === signature &&
                typeof stored.key === 'string' &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored.key)) {
                return stored.key;
            }
        } catch {
            // Invalid browser retry state is replaced with a fresh key.
        }

        const key = cryptoProvider?.randomUUID?.();
        if (typeof key !== 'string') {
            throw new SubmissionValidationError('Secure retry protection is unavailable. Refresh the page and try again.');
        }
        storage?.setItem(RESOURCE_RETRY_STORAGE_KEY, JSON.stringify({ key, signature }));
        return key;
    }

    function clearResourceIdempotencyKey(storage) {
        try {
            storage?.removeItem(RESOURCE_RETRY_STORAGE_KEY);
        } catch {
            // A confirmed submission remains successful even if browser storage is unavailable.
        }
    }

    function validatePrerequisitePayload(fields) {
        const prerequisiteId = requiredText(fields.prerequisiteId, 'Prerequisite concept', 100);
        const targetId = requiredText(fields.targetId, 'Target concept', 100);
        if (prerequisiteId === targetId) {
            throw new SubmissionValidationError('Choose two different concepts for this relationship.');
        }
        return { prerequisiteId, targetId };
    }

    function conceptOptionLabel(concept) {
        const conceptId = String(concept.concept_id);
        const name = typeof concept.name === 'string' && concept.name.trim()
            ? concept.name.trim()
            : typeof concept.concept_name === 'string' && concept.concept_name.trim()
                ? concept.concept_name.trim()
                : 'Concept';
        return `${name} (${conceptId})`;
    }

    function populateConceptSelect(select, concepts, document) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a concept';
        placeholder.disabled = true;
        placeholder.selected = true;

        const seenIds = new Set();
        const options = concepts
            .filter(concept => concept &&
                (typeof concept.concept_id === 'string' || typeof concept.concept_id === 'number') &&
                String(concept.concept_id).trim())
            .filter(concept => {
                const id = String(concept.concept_id);
                if (seenIds.has(id)) return false;
                seenIds.add(id);
                return true;
            })
            .map(concept => {
                const option = document.createElement('option');
                option.value = String(concept.concept_id);
                option.textContent = conceptOptionLabel(concept);
                return option;
            });

        select.replaceChildren(placeholder, ...options);
        select.value = '';
        return options.length;
    }

    function showMessage(element, message, kind = 'info') {
        if (!element) return;
        if (root.NeuroLearnLoading?.showMessage) root.NeuroLearnLoading.showMessage(element, message);
        else element.textContent = message;
        element.dataset.state = kind;
    }

    function createSubmissionHandler({
        api,
        form,
        submitButton,
        feedback,
        endpoint,
            buildPayload,
        send = payload => api.post(endpoint, payload),
        successMessage,
        isAvailable = () => true,
        onPendingChange = () => {},
        afterReset = () => {},
        afterSuccess = () => {}
    }) {
        let pending = false;
        return async function handleSubmit(event) {
            event.preventDefault();
            if (pending || !isAvailable()) return;

            let payload;
            try {
                payload = buildPayload();
            } catch (error) {
                showMessage(feedback, error.message, 'error');
                return;
            }

            pending = true;
            root.NeuroLearnLoading?.setButtonLoading(submitButton, true, 'Submitting');
            if (!root.NeuroLearnLoading) submitButton.disabled = true;
            onPendingChange(true);
            if (root.NeuroLearnLoading?.showIndicator) root.NeuroLearnLoading.showIndicator(feedback, 'Submitting learning contribution');
            else showMessage(feedback, '', 'info');

            try {
                const result = await send(payload);
                if (result?.success !== true) {
                    throw new Error('The server did not confirm the submission.');
                }
                form.reset();
                try {
                    afterReset();
                } catch {
                    // A UI reset callback cannot undo server-confirmed success.
                }
                showMessage(feedback,
                    typeof result.message === 'string' && result.message.trim()
                        ? result.message
                        : successMessage,
                    'success');
                try {
                    await afterSuccess();
                } catch {
                    // The server already confirmed success; a history refresh must not relabel it as a failed submission.
                }
            } catch (error) {
                if (error.status === 401) {
                    showMessage(feedback, 'Your session expired. Please sign in again.', 'error');
                } else if (error.status === 403) {
                    showMessage(feedback, 'Only student accounts can create knowledge submissions.', 'error');
                } else if (error.status >= 500 || !error.status) {
                    showMessage(feedback, 'We could not send this submission right now. Please try again.', 'error');
                } else {
                    showMessage(feedback, error.message || 'Please check the submission and try again.', 'error');
                }
            } finally {
                pending = false;
                root.NeuroLearnLoading?.setButtonLoading(submitButton, false);
                onPendingChange(false);
                submitButton.disabled = !isAvailable();
            }
        };
    }

    async function loadConceptOptions(api, selects, document) {
        const result = await api.get('/kg/concepts');
        if (!Array.isArray(result?.concepts)) {
            throw new Error('The concepts list was not available.');
        }
        const totalOptions = selects.reduce(
            (total, select) => total + populateConceptSelect(select, result.concepts, document),
            0
        );
        if (totalOptions === 0) {
            throw new Error('No existing concepts are available yet.');
        }
        return result.concepts;
    }

    const SUBMISSION_TYPE_LABELS = Object.freeze({
        CONCEPT: 'Concept',
        RESOURCE: 'Learning resource',
        PREREQUISITE: 'Prerequisite',
        COURSE: 'Course proposal',
        COURSE_PREREQUISITE: 'Course prerequisite update'
    });

    const REVIEW_STATUS_LABELS = Object.freeze({
        pending: 'Pending review',
        approved: 'Approved',
        rejected: 'Rejected'
    });

    function submissionSummary(submission) {
        const data = submission.submissionData && typeof submission.submissionData === 'object'
            ? submission.submissionData
            : {};
        switch (submission.submissionType) {
            case 'CONCEPT':
                return typeof data.name === 'string' && data.name.trim()
                    ? data.name.trim()
                    : 'Concept submission';
            case 'COURSE':
                return typeof data.title === 'string' && data.title.trim()
                    ? data.title.trim()
                    : 'Course proposal';
            case 'RESOURCE':
                return typeof data.title === 'string' && data.title.trim()
                    ? data.title.trim()
                    : 'Learning resource submission';
            case 'PREREQUISITE': {
                const prerequisite = data.prerequisiteId ?? 'Unknown concept';
                const target = data.targetId ?? 'Unknown concept';
                return `${prerequisite} must be learned before ${target}`;
            }
            default:
                return 'Knowledge submission';
        }
    }

    function formatSubmissionDate(value) {
        if (!value) return 'Date unavailable';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short'
        }).format(date);
    }

    function renderSubmissionHistory(container, submissions, document) {
        const cards = submissions.map(submission => {
            const card = document.createElement('article');
            card.className = 'submission-history-card';

            const heading = document.createElement('h3');
            heading.textContent = submissionSummary(submission);

            const type = document.createElement('p');
            type.className = 'submission-history-type';
            type.textContent = SUBMISSION_TYPE_LABELS[submission.submissionType] || 'Knowledge submission';

            const status = document.createElement('span');
            const normalizedStatus = String(submission.status || '').toLowerCase();
            status.className = `submission-status submission-status-${REVIEW_STATUS_LABELS[normalizedStatus] ? normalizedStatus : 'unknown'}`;
            status.textContent = REVIEW_STATUS_LABELS[normalizedStatus] || 'Status unavailable';
            status.setAttribute('aria-label', `Review status: ${status.textContent}`);

            const date = document.createElement('p');
            date.className = 'submission-history-date';
            date.textContent = `Submitted ${formatSubmissionDate(submission.submittedAt)}`;

            card.append(heading, type, status, date);
            if (typeof submission.reviewNotes === 'string' && submission.reviewNotes.trim()) {
                const feedback = document.createElement('p');
                feedback.className = 'submission-history-feedback';
                const label = document.createElement('strong');
                label.textContent = 'Administrator feedback: ';
                feedback.append(label, document.createTextNode(submission.reviewNotes.trim()));
                card.append(feedback);
            }
            return card;
        });
        container.replaceChildren(...cards);
    }

    function createSubmissionHistory({ api, document, elements, pageSize = 10 }) {
        let currentPage = 1;
        let requestVersion = 0;

        function updatePagination(pagination) {
            const total = Number(pagination.total) || 0;
            const totalPages = Number(pagination.totalPages) || 0;
            elements.pagination.textContent = total === 0
                ? 'No submissions yet.'
                : `Page ${pagination.page} of ${totalPages} · ${total} submission${total === 1 ? '' : 's'}`;
            elements.previous.disabled = pagination.page <= 1;
            elements.next.disabled = totalPages === 0 || pagination.page >= totalPages;
            elements.pagination.dataset.totalPages = String(totalPages);
            elements.pagination.dataset.total = String(total);
        }

        async function load(page = currentPage) {
            const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
            currentPage = safePage;
            const version = ++requestVersion;
            elements.loading.hidden = false;
            elements.loading.setAttribute?.('aria-busy', 'true');
            elements.error.hidden = true;
            elements.empty.hidden = true;
            elements.previous.disabled = true;
            elements.next.disabled = true;
            root.NeuroLearnLoading?.setButtonLoading(elements.refresh, true, 'Refreshing submission history');
            if (!root.NeuroLearnLoading) elements.refresh.disabled = true;
            elements.pagination.textContent = '';

            try {
                const result = await api.get(`/submissions?page=${safePage}&limit=${pageSize}`);
                if (version !== requestVersion) return;
                if (!Array.isArray(result?.submissions) || !result.pagination ||
                    !Number.isSafeInteger(Number(result.pagination.page)) ||
                    !Number.isSafeInteger(Number(result.pagination.totalPages)) ||
                    !Number.isSafeInteger(Number(result.pagination.total))) {
                    throw new Error('invalid_response');
                }

                currentPage = Number(result.pagination.page);
                renderSubmissionHistory(elements.list, result.submissions, document);
                elements.empty.hidden = result.submissions.length !== 0;
                updatePagination({
                    ...result.pagination,
                    page: currentPage,
                    totalPages: Number(result.pagination.totalPages),
                    total: Number(result.pagination.total)
                });
            } catch (error) {
                if (version !== requestVersion) return;
                elements.error.textContent = error.status === 401
                    ? 'Your session expired. Please sign in again.'
                    : error.status === 403
                        ? 'Your account is not allowed to view submission history.'
                        : 'Submission history could not be loaded. Please try again.';
                elements.error.hidden = false;
            } finally {
                if (version === requestVersion) {
                    elements.loading.hidden = true;
                    elements.loading.setAttribute?.('aria-busy', 'false');
                    root.NeuroLearnLoading?.setButtonLoading(elements.refresh, false);
                    if (!root.NeuroLearnLoading) elements.refresh.disabled = false;
                    if (elements.error.hidden) {
                        const pageCount = Number(elements.pagination.dataset.totalPages || 0);
                        const total = Number(elements.pagination.dataset.total || 0);
                        elements.previous.disabled = currentPage <= 1;
                        elements.next.disabled = pageCount === 0 || currentPage >= pageCount || total === 0;
                    }
                }
            }
        }

        elements.previous.addEventListener('click', () => {
            if (currentPage > 1) load(currentPage - 1);
        });
        elements.next.addEventListener('click', () => load(currentPage + 1));
        elements.refresh.addEventListener('click', () => load(1));

        return { load, refresh: () => load(1), getCurrentPage: () => currentPage };
    }

    function initializeKnowledgeContributions({ document, api }) {
        const section = document.getElementById('knowledge-contributions');
        const historySection = document.getElementById('submission-history');
        if (!section) return false;
        if (!api.isStudent()) {
            section.hidden = true;
            if (historySection) historySection.hidden = true;
            return false;
        }

        section.hidden = false;
        if (historySection) historySection.hidden = false;
        const history = historySection ? createSubmissionHistory({
            api,
            document,
            pageSize: 10,
            elements: {
                list: document.getElementById('submission-history-list'),
                loading: document.getElementById('submission-history-loading'),
                empty: document.getElementById('submission-history-empty'),
                error: document.getElementById('submission-history-error'),
                pagination: document.getElementById('submission-history-pagination'),
                previous: document.getElementById('submission-history-previous'),
                next: document.getElementById('submission-history-next'),
                refresh: document.getElementById('submission-history-refresh')
            }
        }) : null;
        const conceptForm = document.getElementById('concept-submission-form');
        const courseForm = document.getElementById('course-submission-form');
        const resourceForm = document.getElementById('resource-submission-form');
        const resourceButton = resourceForm.querySelector('[type="submit"]');
        const resourceFeedback = document.getElementById('resource-submission-feedback');
        const resourceFile = document.getElementById('resource-file');
        const resourceTitle = document.getElementById('resource-title');
        const resourceCourse = document.getElementById('resource-course');
        const resourceConcept = document.getElementById('resource-concept');
        const resourceConceptHelp = document.getElementById('resource-concept-help');
        const resourceFileName = document.getElementById('resource-file-name');
        const resourceFileRemove = document.getElementById('resource-file-remove');
        let resourceSubmissionPending = false;
        const resourceReady = () => isResourceSubmissionReady(resourceTitle.value, resourceFile.files?.[0]) &&
            Boolean(resourceCourse.value) && Boolean(resourceConcept.value);
        const updateResourceSubmitButton = () => {
            resourceButton.disabled = resourceSubmissionPending || !resourceReady();
        };
        const updateResourceFile = () => {
            const file = resourceFile.files?.[0];
            resourceFileName.textContent = file ? `${file.name} (${Math.ceil(file.size / 1024)} KB)` : 'No document selected.';
            resourceFileRemove.hidden = !file;
            updateResourceSubmitButton();
        };
        resourceTitle.addEventListener('input', updateResourceSubmitButton);
        const resourceCourseOptions = [];
        const setResourceConceptOptions = () => {
            const course = resourceCourseOptions.find(item => String(item.courseId) === resourceCourse.value);
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = course ? 'Select a concept' : 'Select a course first';
            placeholder.disabled = true;
            placeholder.selected = true;
            const options = (course?.concepts || []).map(item => {
                const option = document.createElement('option');
                option.value = String(item.conceptId);
                option.textContent = `${item.name} (${item.conceptId})`;
                return option;
            });
            resourceConcept.replaceChildren(placeholder, ...options);
            resourceConcept.value = '';
            resourceConcept.disabled = options.length === 0;
            if (resourceConceptHelp) resourceConceptHelp.textContent = options.length
                ? 'Select the approved concept this document teaches.'
                : course ? 'No approved concepts are associated with this course yet.'
                    : 'Choose the concept this document teaches.';
            updateResourceSubmitButton();
        };
        resourceCourse.addEventListener('change', setResourceConceptOptions);
        resourceConcept.addEventListener('change', updateResourceSubmitButton);
        api.get('/submissions/resource-options').then(result => {
            if (!Array.isArray(result?.courses)) throw new Error('Invalid approved resource options.');
            resourceCourseOptions.push(...result.courses.filter(course =>
                typeof course?.courseId === 'string' && Array.isArray(course.concepts) && course.concepts.length
            ));
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = resourceCourseOptions.length ? 'Select an approved course' : 'No approved courses with concepts';
            placeholder.disabled = true;
            placeholder.selected = true;
            const options = resourceCourseOptions.map(course => {
                const option = document.createElement('option');
                option.value = course.courseId;
                option.textContent = course.name;
                return option;
            });
            resourceCourse.replaceChildren(placeholder, ...options);
            resourceCourse.disabled = options.length === 0;
            setResourceConceptOptions();
        }).catch(() => {
            resourceCourse.disabled = true;
            resourceCourse.replaceChildren();
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'Approved courses could not be loaded';
            resourceCourse.appendChild(option);
            if (resourceConceptHelp) resourceConceptHelp.textContent = 'Refresh the page to retry loading approved courses and concepts.';
        });
        resourceFile.addEventListener('change', updateResourceFile);
        resourceFileRemove.addEventListener('click', () => {
            resourceFile.value = '';
            updateResourceFile();
        });
        updateResourceSubmitButton();
        const conceptFeedback = document.getElementById('concept-submission-feedback');

        if (courseForm) {
            courseForm.addEventListener('submit', createSubmissionHandler({
                api,
                form: courseForm,
                submitButton: courseForm.querySelector('[type="submit"]'),
                feedback: document.getElementById('course-submission-feedback'),
                endpoint: '/submissions/courses',
                buildPayload: () => validateCoursePayload({
                    title: document.getElementById('course-title').value,
                    description: document.getElementById('course-description').value
                }),
                successMessage: 'Course proposal submitted for administrator review.',
                afterSuccess: () => history?.refresh()
            }));
        }

        conceptForm.addEventListener('submit', createSubmissionHandler({
            api,
            form: conceptForm,
            submitButton: conceptForm.querySelector('[type="submit"]'),
            feedback: conceptFeedback,
            endpoint: '/submissions/concepts',
            buildPayload: () => validateConceptPayload({
                name: document.getElementById('concept-name').value,
                description: document.getElementById('concept-description').value
            }),
            successMessage: 'Concept submitted for administrator review.',
            afterSuccess: () => history?.refresh()
        }));

        resourceForm.addEventListener('submit', createSubmissionHandler({
            api,
            form: resourceForm,
            submitButton: resourceButton,
            feedback: resourceFeedback,
            endpoint: '/submissions/resources',
            isAvailable: resourceReady,
            onPendingChange(isPending) {
                resourceSubmissionPending = isPending;
                updateResourceSubmitButton();
            },
            buildPayload: () => validateResourcePayload({
                title: document.getElementById('resource-title').value,
                courseId: resourceCourse.value,
                conceptId: resourceConcept.value,
                file: resourceFile.files?.[0]
            }),
            send: payload => {
                const formData = new FormData();
                formData.append('title', payload.title);
                formData.append('courseId', payload.courseId);
                formData.append('conceptId', payload.conceptId);
                formData.append('document', payload.file);
                const idempotencyKey = createResourceIdempotencyKey({
                    title: payload.title,
                    courseId: payload.courseId,
                    conceptId: payload.conceptId,
                    file: payload.file,
                    storage: root.sessionStorage,
                    cryptoProvider: root.crypto
                });
                return api.post('/submissions/resources', formData, {
                    headers: { 'Idempotency-Key': idempotencyKey }
                }).catch(error => {
                    if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
                        clearResourceIdempotencyKey(root.sessionStorage);
                    }
                    throw error;
                });
            },
            successMessage: 'Learning resource submitted for administrator review.',
            afterReset() {
                clearResourceIdempotencyKey(root.sessionStorage);
                updateResourceFile();
            },
            afterSuccess: () => history?.refresh()
        }));

        history?.load(1);

        return true;
    }

    const api = {
        SubmissionValidationError,
        createSubmissionHandler,
        createResourceIdempotencyKey,
        clearResourceIdempotencyKey,
        conceptOptionLabel,
        createSubmissionHistory,
        formatSubmissionDate,
        initializeKnowledgeContributions,
        loadConceptOptions,
        populateConceptSelect,
        renderSubmissionHistory,
        submissionSummary,
        validateConceptPayload,
        validateCoursePayload,
        validatePrerequisitePayload,
        validateResourcePayload,
        isResourceSubmissionReady
    };
    root.NeuroLearnContributions = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
