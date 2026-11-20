'use strict';

(function initializeAdminSubmissionReviewModule(root) {
    const TYPE_LABELS = Object.freeze({
        CONCEPT: 'Concept',
        RESOURCE: 'Learning resource',
        PREREQUISITE: 'Prerequisite'
    });
    const STATUS_LABELS = Object.freeze({
        pending: 'Pending review',
        approved: 'Approved',
        rejected: 'Rejected'
    });
    const CONCEPT_DIFFICULTY_LEVELS = Object.freeze(['Beginner', 'Intermediate', 'Advanced']);

    function safeText(value, fallback = 'Not provided') {
        if (value === undefined || value === null || value === '') return fallback;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return String(value);
        }
        return fallback;
    }

    function submissionSummary(submission) {
        const data = submission?.submissionData && typeof submission.submissionData === 'object'
            ? submission.submissionData
            : {};
        switch (submission?.submissionType) {
            case 'CONCEPT':
                return safeText(data.name, 'Concept submission');
            case 'RESOURCE':
                return safeText(data.title, 'Learning resource submission');
            case 'PREREQUISITE':
                return `${safeText(data.prerequisiteId, 'Unknown concept')} must be learned before ${safeText(data.targetId, 'Unknown concept')}`;
            default:
                return 'Knowledge submission';
        }
    }

    function formatDate(value) {
        if (!value) return 'Date unavailable';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }

    function routeState(location) {
        if (!location?.href) return { page: 1, status: null, type: null, submissionId: null };
        const params = new URL(location.href).searchParams;
        const page = Number(params.get('page'));
        return {
            page: Number.isSafeInteger(page) && page > 0 ? page : 1,
            status: params.has('status') ? params.get('status') : null,
            type: params.has('type') ? params.get('type') : null,
            submissionId: params.get('submission') || null
        };
    }

    function setMessage(element, message, state = 'info') {
        if (root.NeuroLearnLoading?.showMessage) root.NeuroLearnLoading.showMessage(element, message);
        else element.textContent = message;
        element.dataset.state = state;
        element.hidden = !message;
    }

    function setLoadingVisible(element, visible) {
        element.hidden = !visible;
        element.setAttribute?.('aria-busy', String(visible));
    }

    function addDetailRow(container, document, labelText, value) {
        const row = document.createElement('div');
        row.className = 'admin-review-detail-row';
        const label = document.createElement('dt');
        label.textContent = labelText;
        const detail = document.createElement('dd');
        detail.textContent = safeText(value);
        row.append(label, detail);
        container.append(row);
    }

    function renderSubmissionDetails(container, submission, document) {
        const data = submission.submissionData && typeof submission.submissionData === 'object'
            ? submission.submissionData
            : {};
        const rows = document.createElement('dl');
        rows.className = 'admin-review-detail-list';
        addDetailRow(rows, document, 'Submission ID', submission.submissionId);
        addDetailRow(rows, document, 'Submission type', TYPE_LABELS[submission.submissionType] || 'Knowledge submission');
        addDetailRow(rows, document, 'Review status', STATUS_LABELS[submission.status] || 'Status unavailable');
        addDetailRow(rows, document, 'Submitted', formatDate(submission.submittedAt));
        if (submission.reviewedAt) addDetailRow(rows, document, 'Reviewed', formatDate(submission.reviewedAt));

        const submitter = submission.submitter;
        if (submitter) {
            const identity = [submitter.username, submitter.email].filter(Boolean).join(' · ');
            addDetailRow(rows, document, 'Submitted by', identity || submitter.learnerId);
        }
        if (submission.reviewer) {
            const reviewer = [submission.reviewer.username, submission.reviewer.email].filter(Boolean).join(' · ');
            addDetailRow(rows, document, 'Reviewed by', reviewer || submission.reviewer.learnerId);
        }

        if (submission.submissionType === 'CONCEPT') {
            addDetailRow(rows, document, 'Concept name', data.name);
            addDetailRow(rows, document, 'Description', data.description || 'No description provided');
            if (data.difficultyLevel) {
                addDetailRow(rows, document, 'Previously submitted difficulty suggestion', data.difficultyLevel);
            }
        } else if (submission.submissionType === 'RESOURCE') {
            addDetailRow(rows, document, 'Resource title', data.title);
            addDetailRow(rows, document, 'Resource type', data.type);
            if (data.document?.originalName) {
                addDetailRow(rows, document, 'Submitted document', `${data.document.originalName} (${data.document.documentType || 'Document'})`);
            } else if (data.url) {
                addDetailRow(rows, document, 'Resource URL', data.url);
            }
            if (data.conceptId !== undefined && data.conceptId !== null) {
                addDetailRow(rows, document, 'Historical concept reference', data.conceptId);
            }
        } else if (submission.submissionType === 'PREREQUISITE') {
            addDetailRow(rows, document, 'Prerequisite concept ID (learn first)', data.prerequisiteId);
            addDetailRow(rows, document, 'Target concept ID (learn after)', data.targetId);
        }

        if (submission.reviewNotes) addDetailRow(rows, document, 'Reviewer notes', submission.reviewNotes);
        if (submission.sync?.status) {
            addDetailRow(rows, document, 'Knowledge synchronization status', submission.sync.status);
        }

        container.replaceChildren(rows);
        return rows;
    }

    function renderQueue(container, submissions, document, onOpen) {
        const cards = submissions.map(submission => {
            const card = document.createElement('article');
            card.className = 'admin-review-card';
            const content = document.createElement('div');
            content.className = 'admin-review-card-content';
            const title = document.createElement('h3');
            title.textContent = `Submission #${safeText(submission.submissionId)} — ${submissionSummary(submission)}`;
            const type = document.createElement('p');
            type.textContent = TYPE_LABELS[submission.submissionType] || 'Knowledge submission';
            const meta = document.createElement('p');
            meta.textContent = `Submitted ${formatDate(submission.submittedAt)} · ${submission.submitter?.username || 'Student'}`;
            const reviewStatus = document.createElement('span');
            reviewStatus.className = `admin-review-status admin-review-status-${STATUS_LABELS[submission.status] ? submission.status : 'unknown'}`;
            reviewStatus.textContent = `Review: ${STATUS_LABELS[submission.status] || 'Status unavailable'}`;
            content.append(title, type, meta, reviewStatus);

            if (submission.sync?.status) {
                const syncStatus = document.createElement('span');
                syncStatus.className = 'admin-sync-status';
                syncStatus.textContent = `Knowledge sync: ${submission.sync.status}`;
                content.append(syncStatus);
            }
            if (submission.reviewer?.username) {
                const reviewer = document.createElement('p');
                reviewer.className = 'admin-review-reviewer';
                reviewer.textContent = `Reviewed by ${submission.reviewer.username}`;
                content.append(reviewer);
            }

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-outline admin-review-open';
            button.textContent = 'Open submission';
            button.addEventListener('click', () => onOpen(submission.submissionId));
            card.append(content, button);
            return card;
        });
        container.replaceChildren(...cards);
    }

    function populateCourseSelect(select, courses, document) {
        const options = [];
        const seen = new Set();
        for (const course of courses) {
            if (!course || typeof course.course_id !== 'string' || !course.course_id.trim() || seen.has(course.course_id)) continue;
            seen.add(course.course_id);
            const option = document.createElement('option');
            option.value = course.course_id;
            option.textContent = `${safeText(course.name, 'Course')} (${course.course_id})`;
            options.push(option);
        }
        select.replaceChildren(...options);
        return options.length;
    }

    function isDatabaseConceptsCourse(course) {
        return typeof course?.name === 'string' && course.name.trim().toLowerCase() === 'database concepts';
    }

    function hasValidCourseId(course) {
        return typeof course?.course_id === 'string' &&
            /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(course.course_id);
    }

    function createAdminReviewController({ api, document, elements, confirmFn, pageSize = 20, location = root.location, history = root.history, windowRef = root }) {
        let currentPage = routeState(location).page;
        let totalPages = 0;
        let queueVersion = 0;
        let detailVersion = 0;
        let selectedSubmission = null;
        let actionPending = false;

        function setView(showDetail) {
            if (elements.queueView) elements.queueView.hidden = showDetail;
            elements.detail.hidden = !showDetail;
            if (elements.pageHeading) elements.pageHeading.hidden = showDetail;
            if (elements.syncSection) elements.syncSection.hidden = showDetail;
        }

        function updateRoute(submissionId = null, method = 'replaceState') {
            if (!location?.href || typeof history?.[method] !== 'function') return;
            const url = new URL(location.href);
            url.searchParams.set('page', String(currentPage));
            if (elements.statusFilter.value) url.searchParams.set('status', elements.statusFilter.value);
            else url.searchParams.delete('status');
            if (elements.typeFilter.value) url.searchParams.set('type', elements.typeFilter.value);
            else url.searchParams.delete('type');
            if (submissionId !== null && submissionId !== undefined) url.searchParams.set('submission', String(submissionId));
            else url.searchParams.delete('submission');
            history[method](null, '', url.href);
        }

        function restoreRoute() {
            const state = routeState(location);
            if (state.status !== null && ['pending', 'approved', 'rejected', ''].includes(state.status)) elements.statusFilter.value = state.status;
            if (state.type !== null && ['CONCEPT', 'RESOURCE', 'PREREQUISITE', ''].includes(state.type)) elements.typeFilter.value = state.type;
            currentPage = state.page;
            if (state.submissionId) return openDetail(state.submissionId, { updateUrl: false });
            setView(false);
            return loadQueue(state.page, { updateUrl: false });
        }

        function backToQueue() {
            detailVersion += 1;
            selectedSubmission = null;
            setView(false);
            updateRoute();
            return loadQueue(currentPage, { updateUrl: false });
        }

        function errorMessage(error, context) {
            if (error.status === 401) return 'Your session expired. Please sign in again.';
            if (error.status === 403) return 'Your account is not allowed to review submissions.';
            if (error.status >= 400 && error.status < 500 && error.message) return error.message;
            return context;
        }

        function updateActionAvailability() {
            const isPending = selectedSubmission?.status === 'pending';
            elements.approve.disabled = actionPending || !isPending ||
                (selectedSubmission?.submissionType === 'CONCEPT' &&
                    (elements.courses.disabled || elements.courses.selectedOptions.length === 0));
            elements.reject.disabled = actionPending || !isPending;
            elements.notes.disabled = actionPending || !isPending;
            elements.courses.disabled = actionPending || !isPending || elements.courses.dataset.loaded !== 'true';
            if (elements.difficulty) elements.difficulty.disabled = actionPending || !isPending;
            if (selectedSubmission?.submissionType === 'CONCEPT' && elements.courses.dataset.loaded === 'true') {
                elements.approve.disabled = actionPending || !isPending ||
                    elements.courses.selectedOptions.length === 0 ||
                    !CONCEPT_DIFFICULTY_LEVELS.includes(elements.difficulty?.value);
            }
            if (selectedSubmission?.submissionType === 'RESOURCE' && elements.resourceConcept) {
                elements.approve.disabled = actionPending || !isPending || elements.resourceConcept.disabled || !elements.resourceConcept.value;
            } else if (selectedSubmission?.submissionType === 'RESOURCE') {
                elements.approve.disabled = true;
            }
        }

        async function loadQueue(page = currentPage, { updateUrl: shouldUpdateUrl = true } = {}) {
            const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
            currentPage = safePage;
            if (shouldUpdateUrl) updateRoute();
            const version = ++queueVersion;
            setLoadingVisible(elements.queueLoading, true);
            elements.queueError.hidden = true;
            elements.queueEmpty.hidden = true;
            elements.previous.disabled = true;
            elements.next.disabled = true;
            root.NeuroLearnLoading?.setButtonLoading(elements.refresh, true, 'Refreshing submissions');
            if (!root.NeuroLearnLoading) elements.refresh.disabled = true;

            const params = new URLSearchParams({ page: String(safePage), limit: String(pageSize) });
            if (elements.statusFilter.value) params.set('status', elements.statusFilter.value);
            if (elements.typeFilter.value) params.set('type', elements.typeFilter.value);
            try {
                const result = await api.get(`/admin/submissions?${params.toString()}`);
                if (version !== queueVersion) return;
                if (!Array.isArray(result?.submissions) || !result.pagination) throw new Error('invalid_response');
                const pageCount = Number(result.pagination.totalPages) || 0;
                const responsePage = Number(result.pagination.page);
                if (!Number.isSafeInteger(responsePage) || responsePage < 1) throw new Error('invalid_response');
                if (pageCount > 0 && responsePage > pageCount) return loadQueue(pageCount);
                if (pageCount === 0 && responsePage !== 1) return loadQueue(1);
                currentPage = responsePage;
                totalPages = pageCount;
                renderQueue(elements.queue, result.submissions, document, openDetail);
                elements.queueEmpty.hidden = result.submissions.length > 0;
                elements.pagination.textContent = Number(result.pagination.total) === 0
                    ? 'No submissions'
                    : `Page ${currentPage} of ${totalPages} · ${Number(result.pagination.total)} submission${Number(result.pagination.total) === 1 ? '' : 's'}`;
                elements.previous.disabled = currentPage <= 1;
                elements.next.disabled = totalPages === 0 || currentPage >= totalPages;
            } catch (error) {
                if (version !== queueVersion) return;
                setMessage(elements.queueError, errorMessage(error, 'The submission queue could not be loaded. Please try again.'), 'error');
            } finally {
                if (version === queueVersion) {
                    setLoadingVisible(elements.queueLoading, false);
                    root.NeuroLearnLoading?.setButtonLoading(elements.refresh, false);
                    if (!root.NeuroLearnLoading) elements.refresh.disabled = false;
                }
            }
        }

        async function loadCourses({ force = false, confirmedCourse = null } = {}) {
            if (!force && elements.courses.dataset.loaded === 'true') return;
            elements.courseField.hidden = false;
            elements.courses.disabled = true;
            elements.courses.dataset.loaded = 'false';
            if (root.NeuroLearnLoading?.showIndicator) root.NeuroLearnLoading.showIndicator(elements.courseMessage, 'Loading existing courses');
            else setMessage(elements.courseMessage, '', 'info');
            try {
                const result = await api.get('/kg/courses', { cache: 'no-store' });
                if (!Array.isArray(result?.courses)) throw new Error('invalid_response');
                const availableCourses = [...result.courses];
                if (isDatabaseConceptsCourse(confirmedCourse) && hasValidCourseId(confirmedCourse) &&
                    !availableCourses.some(course => course?.course_id === confirmedCourse.course_id)) {
                    availableCourses.push(confirmedCourse);
                }
                const namedDomainCourses = availableCourses.filter(isDatabaseConceptsCourse);
                const domainCourses = namedDomainCourses.filter(hasValidCourseId);
                const count = populateCourseSelect(elements.courses, domainCourses, document);
                if (!count) {
                    const message = namedDomainCourses.length > 0
                        ? 'Database Concepts course exists but its identifier is not valid for approval. Keep this course unchanged and contact the system administrator.'
                        : result.courses.length === 0
                        ? 'No courses are available. Use Manage Database Concepts course above to provision the required course.'
                        : 'Database Concepts course not found. Use Manage Database Concepts course above to create or select it.';
                    setMessage(elements.courseMessage, message, 'error');
                } else {
                    elements.courses.dataset.loaded = 'true';
                    setMessage(elements.courseMessage, 'Select the existing Database Concepts course for this concept.', 'info');
                }
            } catch (error) {
                setMessage(elements.courseMessage, `${errorMessage(error, 'Course lookup failed.')} Use Refresh queue or reopen this submission to retry the lookup.`, 'error');
            }
            updateActionAvailability();
        }

        let courseProvisionPending = false;
        async function provisionDatabaseConceptsCourse(event) {
            event.preventDefault();
            if (courseProvisionPending) return;
            const name = elements.provisionName?.value?.trim();
            if (!name) {
                setMessage(elements.provisionMessage, 'Enter the course name.', 'error');
                return;
            }
            courseProvisionPending = true;
            if (elements.provisionSubmit) {
                root.NeuroLearnLoading?.setButtonLoading(elements.provisionSubmit, true, 'Checking course');
                if (!root.NeuroLearnLoading) elements.provisionSubmit.disabled = true;
            }
            setMessage(elements.provisionMessage, 'Checking existing courses…', 'info');
            try {
                const listed = await api.get('/kg/courses', { cache: 'no-store' });
                if (!Array.isArray(listed?.courses)) throw new Error('Course lookup returned an invalid response.');
                let course = listed.courses.find(isDatabaseConceptsCourse);
                let created = false;
                if (!course) {
                    setMessage(elements.provisionMessage, 'Creating the required course…', 'info');
                    const result = await api.post('/kg/courses', { name });
                    if (result?.success !== true || !isDatabaseConceptsCourse(result.course) || !hasValidCourseId(result.course)) {
                        throw new Error('The server did not confirm that the Database Concepts course is available.');
                    }
                    course = result.course;
                    created = result.created === true;
                }
                await loadCourses({ force: true, confirmedCourse: course });
                if (elements.courses.dataset.loaded === 'true') {
                    setMessage(elements.provisionMessage, created
                        ? 'Database Concepts course created and added to the concept review selector. Select it when reviewing a concept.'
                        : 'Existing Database Concepts course found and refreshed in the concept review selector. Select it when reviewing a concept.', 'success');
                } else {
                    setMessage(elements.provisionMessage, 'A matching course exists, but it is not currently valid for approval. The course was preserved; contact the system administrator.', 'error');
                }
            } catch (error) {
                setMessage(elements.provisionMessage, errorMessage(error, 'Course provisioning failed. No course was confirmed; retry to check again.'), 'error');
            } finally {
                courseProvisionPending = false;
                if (elements.provisionSubmit) {
                    root.NeuroLearnLoading?.setButtonLoading(elements.provisionSubmit, false);
                    if (!root.NeuroLearnLoading) elements.provisionSubmit.disabled = false;
                }
            }
        }

        let domainConceptsLoaded = false;
        let domainConceptsLoading = null;
        let domainConceptCount = 0;
        let prerequisitePending = false;
        function updatePrerequisiteAvailability() {
            const hasEnoughConcepts = domainConceptCount >= 2;
            if (elements.prerequisiteFields) elements.prerequisiteFields.hidden = !hasEnoughConcepts;
            if (elements.prerequisiteBefore) elements.prerequisiteBefore.disabled = !hasEnoughConcepts || prerequisitePending;
            if (elements.prerequisiteAfter) elements.prerequisiteAfter.disabled = !hasEnoughConcepts || prerequisitePending;
            if (elements.prerequisiteSubmit) {
                const before = elements.prerequisiteBefore?.value;
                const after = elements.prerequisiteAfter?.value;
                elements.prerequisiteSubmit.disabled = !hasEnoughConcepts || prerequisitePending ||
                    !before || !after || before === after;
            }
        }
        async function loadDatabaseConcepts({ force = false } = {}) {
            if (domainConceptsLoaded && !force) {
                if (elements.resourceConcept) elements.resourceConcept.disabled = domainConceptCount === 0;
                updatePrerequisiteAvailability();
                return domainConceptCount > 0;
            }
            if (domainConceptsLoading) return domainConceptsLoading;
            const selects = [elements.resourceConcept, elements.prerequisiteBefore, elements.prerequisiteAfter].filter(Boolean);
            if (!selects.length) return false;
            if (root.NeuroLearnLoading?.showIndicator) {
                if (elements.resourceConceptMessage) root.NeuroLearnLoading.showIndicator(elements.resourceConceptMessage, 'Loading approved concepts');
                if (elements.prerequisiteMessage) root.NeuroLearnLoading.showIndicator(elements.prerequisiteMessage, 'Loading approved concepts');
            }
            domainConceptsLoading = (async () => {
                try {
                    const result = await api.get('/admin/submissions/database-concepts');
                    if (!Array.isArray(result?.concepts)) throw new Error('invalid_response');
                    for (const select of selects) {
                        const placeholder = document.createElement('option');
                        placeholder.value = '';
                        placeholder.textContent = 'Select a Database Concept';
                        placeholder.disabled = true;
                        placeholder.selected = true;
                        const options = result.concepts.map(concept => {
                            const option = document.createElement('option');
                            option.value = String(concept.concept_id);
                            option.textContent = `${safeText(concept.name, 'Concept')} (${concept.concept_id})`;
                            return option;
                        });
                        select.replaceChildren(placeholder, ...options);
                        select.value = '';
                        select.disabled = options.length === 0;
                    }
                    domainConceptCount = result.concepts.length;
                    domainConceptsLoaded = true;
                    updatePrerequisiteAvailability();
                    if (elements.prerequisiteMessage) setMessage(elements.prerequisiteMessage,
                        result.concepts.length < 2
                            ? 'At least two approved Database Concepts must exist before prerequisites can be created.'
                            : '', 'info');
                    if (elements.resourceConceptMessage) {
                        let emptyMessage = 'No approved Database Concepts are available yet. Approve a concept first.';
                        if (result.domainAvailable === false || result.emptyReason === 'course_missing') {
                            emptyMessage = 'The Database Concepts course is unavailable. Use Manage Database Concepts course above, then retry.';
                        } else if (result.emptyReason === 'missing_course_association') {
                            emptyMessage = 'Approved concepts exist, but none are associated with the Database Concepts course. Review the course association before approving resources.';
                        } else if (result.emptyReason === 'missing_graph_concept_id') {
                            emptyMessage = 'Database Concepts are associated with the course, but their graph concept IDs are missing. Resolve the concept mapping before approving resources.';
                        }
                        setMessage(elements.resourceConceptMessage,
                            result.concepts.length ? 'Select the approved Database Concept this document belongs to.' : emptyMessage,
                            result.concepts.length ? 'info' : 'error');
                    }
                    return result.concepts.length > 0;
                } catch (error) {
                    if (elements.resourceConceptMessage) setMessage(elements.resourceConceptMessage,
                        'Concept lookup failed. Check database and course availability, then reopen this submission to retry.', 'error');
                    domainConceptCount = 0;
                    if (elements.prerequisiteMessage) setMessage(elements.prerequisiteMessage, errorMessage(error, 'Database Concepts could not be loaded.'), 'error');
                    return false;
                } finally {
                    domainConceptsLoading = null;
                    updatePrerequisiteAvailability();
                    updateActionAvailability();
                }
            })();
            return domainConceptsLoading;
        }

        async function openDetail(submissionId, { updateUrl: shouldUpdateUrl = true } = {}) {
            selectedSubmission = null;
            if (shouldUpdateUrl) updateRoute(submissionId, 'pushState');
            setView(true);
            const version = ++detailVersion;
            elements.detail.hidden = false;
            setLoadingVisible(elements.detailLoading, true);
            elements.detailError.hidden = true;
            elements.detailContent.replaceChildren();
            elements.actions.hidden = true;
            elements.courseField.hidden = true;
            if (elements.difficultyField) elements.difficultyField.hidden = true;
            if (elements.difficulty) {
                elements.difficulty.value = '';
                elements.difficulty.disabled = true;
            }
            if (elements.resourceConceptField) elements.resourceConceptField.hidden = true;
            if (elements.resourceConcept) {
                elements.resourceConcept.value = '';
                elements.resourceConcept.disabled = true;
            }
            elements.courses.replaceChildren();
            elements.courses.dataset.loaded = 'false';
            elements.notes.value = '';
            setMessage(elements.actionMessage, '', 'info');
            try {
                const result = await api.get(`/admin/submissions/${encodeURIComponent(submissionId)}`);
                if (version !== detailVersion) return;
                if (!result?.submission) throw new Error('invalid_response');
                selectedSubmission = result.submission;
                renderSubmissionDetails(elements.detailContent, selectedSubmission, document);
                if (selectedSubmission.status === 'pending') {
                    elements.actions.hidden = false;
                    if (selectedSubmission.submissionType === 'CONCEPT') {
                        if (elements.difficultyField) elements.difficultyField.hidden = false;
                        if (elements.difficulty) elements.difficulty.disabled = false;
                        await loadCourses();
                    }
                    else if (selectedSubmission.submissionType === 'RESOURCE') {
                        if (elements.resourceConceptField) elements.resourceConceptField.hidden = false;
                        if (elements.resourceConcept) elements.resourceConcept.disabled = true;
                        await loadDatabaseConcepts({ force: true });
                    } else elements.courseField.hidden = true;
                    updateActionAvailability();
                }
            } catch (error) {
                if (version !== detailVersion) return;
                setMessage(elements.detailError, errorMessage(error, 'Submission details could not be loaded. Please try again.'), 'error');
            } finally {
                if (version === detailVersion) setLoadingVisible(elements.detailLoading, false);
            }
        }

        async function review(status) {
            if (actionPending || !selectedSubmission || selectedSubmission.status !== 'pending') return;
            const reviewNotes = elements.notes.value.trim();
            if (reviewNotes.length > 5000) {
                setMessage(elements.actionMessage, 'Reviewer notes must not exceed 5000 characters.', 'error');
                return;
            }
            const courseIds = selectedSubmission.submissionType === 'CONCEPT'
                ? Array.from(elements.courses.selectedOptions, option => option.value)
                : [];
            if (status === 'approved' && selectedSubmission.submissionType === 'CONCEPT' && courseIds.length === 0) {
                setMessage(elements.actionMessage, 'Select at least one existing course before approving this concept.', 'error');
                return;
            }
            const difficultyLevel = selectedSubmission.submissionType === 'CONCEPT'
                ? elements.difficulty?.value
                : undefined;
            if (status === 'approved' && selectedSubmission.submissionType === 'CONCEPT' &&
                !CONCEPT_DIFFICULTY_LEVELS.includes(difficultyLevel)) {
                setMessage(elements.actionMessage, 'Choose a valid difficulty level before approving this concept.', 'error');
                return;
            }
            const selectedResourceConcept = selectedSubmission.submissionType === 'RESOURCE'
                ? elements.resourceConcept?.value
                : undefined;
            if (status === 'approved' && selectedSubmission.submissionType === 'RESOURCE' && (!elements.resourceConcept || !selectedResourceConcept)) {
                setMessage(elements.actionMessage, 'Select an approved Database Concept before approving this resource.', 'error');
                return;
            }

            const confirmation = status === 'rejected'
                ? `Reject submission #${selectedSubmission.submissionId}? Rejection is final and cannot be undone.`
                : `Approve submission #${selectedSubmission.submissionId}? This will create the canonical knowledge record.`;
            actionPending = true;
            updateActionAvailability();
            if (!confirmFn(confirmation)) {
                actionPending = false;
                updateActionAvailability();
                return;
            }

            if (root.NeuroLearnLoading?.showIndicator) {
                root.NeuroLearnLoading.showIndicator(elements.actionMessage, status === 'approved' ? 'Approving submission' : 'Rejecting submission');
            } else setMessage(elements.actionMessage, '', 'info');
            const actionButton = status === 'approved' ? elements.approve : elements.reject;
            root.NeuroLearnLoading?.setButtonLoading(actionButton, true, status === 'approved' ? 'Approving' : 'Rejecting');
            const payload = { reviewNotes: reviewNotes || null };
            if (status === 'approved' && selectedSubmission.submissionType === 'CONCEPT') {
                payload.courseIds = courseIds;
                payload.difficultyLevel = difficultyLevel;
            }
            if (status === 'approved' && selectedSubmission.submissionType === 'RESOURCE') payload.conceptId = selectedResourceConcept;
            try {
                const result = await api.patch(
                    `/admin/submissions/${encodeURIComponent(selectedSubmission.submissionId)}/${status === 'approved' ? 'approve' : 'reject'}`,
                    payload
                );
                if (result?.success !== true) throw new Error('The server did not confirm the review action.');
                const successMessage = status === 'approved' ? 'Submission approved.' : 'Submission rejected.';
                setMessage(elements.queueNotice, successMessage, 'success');
                if (status === 'approved' && selectedSubmission.submissionType === 'CONCEPT') {
                    await loadDatabaseConcepts({ force: true });
                }
                await backToQueue();
            } catch (error) {
                setMessage(elements.actionMessage, errorMessage(error, 'The review action could not be completed. Please try again.'), 'error');
            } finally {
                root.NeuroLearnLoading?.setButtonLoading(actionButton, false);
                actionPending = false;
                updateActionAvailability();
            }
        }

        elements.previous.addEventListener('click', () => {
            if (currentPage > 1) loadQueue(currentPage - 1);
        });
        elements.next.addEventListener('click', () => {
            if (currentPage < totalPages) loadQueue(currentPage + 1);
        });
        elements.refresh.addEventListener('click', () => loadQueue(currentPage));
        elements.statusFilter.addEventListener('change', () => loadQueue(1));
        elements.typeFilter.addEventListener('change', () => loadQueue(1));
        elements.closeDetail.addEventListener('click', backToQueue);
        elements.courses.addEventListener('change', updateActionAvailability);
        elements.difficulty?.addEventListener('change', updateActionAvailability);
        elements.resourceConcept?.addEventListener('change', updateActionAvailability);
        elements.approve.addEventListener('click', () => review('approved'));
        elements.reject.addEventListener('click', () => review('rejected'));
        elements.provisionForm?.addEventListener('submit', provisionDatabaseConceptsCourse);

        if (elements.prerequisiteForm) {
            elements.prerequisiteBefore?.addEventListener('change', updatePrerequisiteAvailability);
            elements.prerequisiteAfter?.addEventListener('change', updatePrerequisiteAvailability);
            elements.prerequisiteForm.addEventListener('submit', async event => {
                event.preventDefault();
                if (elements.prerequisiteSubmit.disabled || !elements.prerequisiteBefore.value || !elements.prerequisiteAfter.value) {
                    setMessage(elements.prerequisiteMessage, 'Select two Database Concepts.', 'error');
                    return;
                }
                if (elements.prerequisiteBefore.value === elements.prerequisiteAfter.value) {
                    setMessage(elements.prerequisiteMessage, 'Choose two different concepts.', 'error');
                    return;
                }
                prerequisitePending = true;
                updatePrerequisiteAvailability();
                root.NeuroLearnLoading?.setButtonLoading(elements.prerequisiteSubmit, true, 'Sending prerequisite');
                if (root.NeuroLearnLoading?.showIndicator) root.NeuroLearnLoading.showIndicator(elements.prerequisiteMessage, 'Sending prerequisite for review');
                else setMessage(elements.prerequisiteMessage, '', 'info');
                try {
                    const result = await api.post('/admin/submissions/prerequisites', {
                        prerequisiteId: elements.prerequisiteBefore.value,
                        targetId: elements.prerequisiteAfter.value
                    });
                    if (result?.success !== true) throw new Error('The server did not confirm the prerequisite proposal.');
                    elements.prerequisiteForm.reset();
                    if (elements.prerequisiteBefore) elements.prerequisiteBefore.value = '';
                    if (elements.prerequisiteAfter) elements.prerequisiteAfter.value = '';
                    setMessage(elements.prerequisiteMessage, 'Prerequisite proposal added to the review queue.', 'success');
                    await loadQueue(1);
                } catch (error) {
                    setMessage(elements.prerequisiteMessage, errorMessage(error, 'The prerequisite proposal could not be added.'), 'error');
                } finally {
                    prerequisitePending = false;
                    root.NeuroLearnLoading?.setButtonLoading(elements.prerequisiteSubmit, false);
                    updatePrerequisiteAvailability();
                }
            });
            loadDatabaseConcepts();
        }

        if (windowRef?.addEventListener) windowRef.addEventListener('popstate', restoreRoute);

        return {
            loadQueue,
            openDetail,
            review,
            restoreRoute,
            backToQueue,
            getCurrentPage: () => currentPage
        };
    }

    function initializeAdminSubmissionReview({ document, api, confirmFn = root.confirm?.bind(root) }) {
        const section = document.getElementById('admin-submission-review');
        if (!section) return null;
        if (!api.isAdministrator()) {
            section.hidden = true;
            return null;
        }
        section.hidden = false;
        const get = id => document.getElementById(id);
        const controller = createAdminReviewController({
            api,
            document,
            confirmFn: typeof confirmFn === 'function' ? confirmFn : () => false,
            elements: {
                statusFilter: get('admin-review-status-filter'),
                typeFilter: get('admin-review-type-filter'),
                refresh: get('admin-review-refresh'),
                queueLoading: get('admin-review-loading'),
                queueError: get('admin-review-queue-error'),
                queueNotice: get('admin-review-queue-notice'),
                queueEmpty: get('admin-review-empty'),
                queue: get('admin-review-queue'),
                queueView: get('admin-review-queue-view'),
                pagination: get('admin-review-pagination'),
                previous: get('admin-review-previous'),
                next: get('admin-review-next'),
                detail: get('admin-review-detail'),
                detailLoading: get('admin-review-detail-loading'),
                detailError: get('admin-review-detail-error'),
                detailContent: get('admin-review-detail-content'),
                actions: get('admin-review-actions'),
                notes: get('admin-review-notes'),
                courseField: get('admin-review-course-field'),
                difficultyField: get('admin-review-difficulty-field'),
                difficulty: get('admin-review-difficulty'),
                courses: get('admin-review-courses'),
                courseMessage: get('admin-review-courses-message'),
                actionMessage: get('admin-review-action-message'),
                approve: get('admin-review-approve'),
                reject: get('admin-review-reject'),
                closeDetail: get('admin-review-close-detail'),
                pageHeading: get('admin-page-heading'),
                syncSection: get('admin-sync-operations'),
                resourceConceptField: get('admin-review-resource-concept-field'),
                resourceConcept: get('admin-review-resource-concept'),
                resourceConceptMessage: get('admin-review-resource-concept-message'),
                prerequisiteForm: get('admin-prerequisite-form'),
                prerequisiteFields: get('admin-prerequisite-fields'),
                prerequisiteBefore: get('admin-prerequisite-before'),
                prerequisiteAfter: get('admin-prerequisite-after'),
                prerequisiteSubmit: get('admin-prerequisite-submit'),
                prerequisiteMessage: get('admin-prerequisite-message'),
                provisionForm: get('admin-course-provision-form'),
                provisionName: get('admin-course-provision-name'),
                provisionSubmit: get('admin-course-provision-submit'),
                provisionMessage: get('admin-course-provision-message')
            }
        });
        controller.restoreRoute();
        return controller;
    }

    const api = {
        createAdminReviewController,
        formatDate,
        initializeAdminSubmissionReview,
        populateCourseSelect,
        isDatabaseConceptsCourse,
        renderQueue,
        renderSubmissionDetails,
        submissionSummary
    };
    root.NeuroLearnAdminSubmissions = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
