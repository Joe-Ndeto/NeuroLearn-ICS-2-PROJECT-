'use strict';

(function initializeKnowledgeSyncOperationsModule(root) {
    const PAGE_SIZE = 20;
    const STAT_FIELDS = Object.freeze([
        ['pending', 'pending'],
        ['processing', 'processing'],
        ['completed', 'completed'],
        ['failed', 'failed'],
        ['expiredProcessing', 'expired'],
        ['totalOutstanding', 'outstanding']
    ]);

    function formatTimestamp(value, emptyLabel = 'Not available') {
        if (value === undefined || value === null || value === '') return emptyLabel;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return 'Date unavailable';
        return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
    }

    function safeSubmissionTitle(submission) {
        const data = submission?.submissionData && typeof submission.submissionData === 'object'
            ? submission.submissionData
            : {};
        if (submission.submissionType === 'CONCEPT') return data.name || 'Concept submission';
        if (submission.submissionType === 'RESOURCE') return data.title || 'Learning resource submission';
        if (submission.submissionType === 'PREREQUISITE') {
            return `${data.prerequisiteId || 'Unknown concept'} must be learned before ${data.targetId || 'Unknown concept'}`;
        }
        return 'Knowledge submission';
    }

    function validOutboxId(value) {
        if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
        return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : null;
    }

    function setTextState(element, message, state = '') {
        if (root.NeuroLearnLoading?.showMessage) root.NeuroLearnLoading.showMessage(element, message);
        else element.textContent = message;
        element.dataset.state = state;
        element.hidden = !message;
    }

    function renderFailedTasks(container, submissions, document, onRetry) {
        const cards = [];
        for (const submission of submissions) {
            if (submission?.sync?.status !== 'failed') continue;
            const card = document.createElement('article');
            card.className = 'admin-failed-task';
            const title = document.createElement('h3');
            title.textContent = `Submission #${submission.submissionId}: ${safeSubmissionTitle(submission)}`;
            const type = document.createElement('p');
            type.textContent = `Type: ${submission.submissionType || 'Knowledge submission'}`;
            const review = document.createElement('p');
            review.textContent = `Review status: ${submission.status || 'Unknown'}`;
            const attempts = document.createElement('p');
            attempts.textContent = `Synchronization attempts: ${Number.isFinite(Number(submission.sync.attemptCount)) ? Number(submission.sync.attemptCount) : 0}`;
            card.append(title, type, review, attempts);

            const outboxId = validOutboxId(submission.sync.outboxId);
            if (outboxId) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn-primary admin-failed-retry';
                button.textContent = 'Retry synchronization';
                button.addEventListener('click', () => onRetry(outboxId, button));
                card.append(button);
            } else {
                const unavailable = document.createElement('p');
                unavailable.className = 'admin-sync-message';
                unavailable.textContent = 'Retry is unavailable because the task identifier was not provided.';
                card.append(unavailable);
            }
            cards.push(card);
        }
        container.replaceChildren(...cards);
        return cards.length;
    }

    function createKnowledgeSyncOperations({ api, document, elements, confirmFn = () => false }) {
        let statsRefreshPromise = null;
        let failedPage = 1;
        let failedTotalPages = 0;
        let failedRequestVersion = 0;
        const retrying = new Set();

        function showApiError(element, error, genericMessage) {
            const message = error.status === 401
                ? 'Your session expired. Please sign in again.'
                : error.status === 403
                    ? 'Your account is not allowed to manage synchronization.'
                    : error.code === 'retry_outcome_uncertain'
                        ? 'The retry outcome could not be confirmed. Refresh task status before retrying again.'
                        : error.code === 'retry_not_committed'
                            ? 'The retry was not committed. Refresh task status and try again.'
                    : error.status >= 400 && error.status < 500 && error.message
                        ? error.message
                        : genericMessage;
            setTextState(element, message, 'error');
        }

        async function loadStatistics() {
            elements.statsError.hidden = true;
            try {
                const result = await api.get('/admin/submissions/outbox/stats');
                if (result?.success !== true || !result.stats || typeof result.stats !== 'object') {
                    throw new Error('invalid_response');
                }
                for (const [field, elementKey] of STAT_FIELDS) {
                    const value = result.stats[field];
                    elements.statValues[elementKey].textContent = Number.isFinite(Number(value)) && value !== null
                        ? String(Number(value))
                        : '—';
                }
                elements.statValues.oldest.textContent = result.stats.oldestPendingAt
                    ? formatTimestamp(result.stats.oldestPendingAt)
                    : 'No pending tasks';
            } catch (error) {
                for (const [field, elementKey] of STAT_FIELDS) {
                    elements.statValues[elementKey].textContent = '—';
                }
                elements.statValues.oldest.textContent = '—';
                showApiError(elements.statsError, error, 'Synchronization statistics could not be loaded. Please try again.');
            }
        }

        async function checkWorkerHealth() {
            const checkedAt = new Date().toISOString();
            elements.healthChecked.textContent = formatTimestamp(checkedAt);
            elements.statValues.lastSync.textContent = 'Not available';
            elements.workerLastPoll.textContent = '—';

            root.NeuroLearnLoading?.showIndicator(elements.workerState, 'Checking worker health');

            function showHealthResult(result) {
                const health = result?.health;
                if (health && health.lastSuccessfulSyncAt) {
                    elements.statValues.lastSync.textContent = formatTimestamp(health.lastSuccessfulSyncAt);
                }
                elements.workerLastPoll.textContent = formatTimestamp(health?.lastSuccessfulPollAt, 'No successful poll recorded');
                if (result?.success === true && health?.started === true && health?.processAlive === true && health?.state === 'running') {
                    if (root.NeuroLearnLoading?.showMessage) root.NeuroLearnLoading.showMessage(elements.workerState, 'Healthy');
                    else elements.workerState.textContent = 'Healthy';
                    elements.workerState.dataset.state = 'healthy';
                    setTextState(elements.workerMessage, 'State: running. Process: alive.', 'success');
                } else {
                    if (root.NeuroLearnLoading?.showMessage) root.NeuroLearnLoading.showMessage(elements.workerState, 'Unavailable');
                    else elements.workerState.textContent = 'Unavailable';
                    elements.workerState.dataset.state = 'unavailable';
                    const message = health?.state === 'stopping'
                        ? 'State: stopping. The worker process is shutting down.'
                        : health?.started === false || health?.state === 'not_started'
                            ? 'State: not started. The worker process is not running.'
                            : `State: ${health?.state || 'unknown'}. Process: ${health?.processAlive ? 'alive' : 'not running'}. The worker is unavailable.`;
                    setTextState(elements.workerMessage, message, 'error');
                }
            }

            try {
                const result = await api.get('/admin/submissions/worker-health', { cache: 'no-store' });
                showHealthResult(result);
            } catch (error) {
                if (error?.payload?.health) {
                    showHealthResult(error.payload);
                } else {
                    if (root.NeuroLearnLoading?.showMessage) root.NeuroLearnLoading.showMessage(elements.workerState, 'Unavailable');
                    else elements.workerState.textContent = 'Unavailable';
                    elements.workerState.dataset.state = 'unavailable';
                    const message = error?.status === 401
                        ? 'Your session expired. Sign in again to check worker health.'
                        : error?.status === 403
                            ? 'Your account is not allowed to view worker health.'
                            : error?.payload?.message || (error?.status === 504
                                ? 'The worker health check timed out.'
                                : 'The worker is unavailable or returned an invalid health response.');
                    setTextState(elements.workerMessage, message, 'error');
                }
            }
        }

        async function loadFailedTasks(page = failedPage) {
            const safePage = Number.isSafeInteger(page) && page > 0 ? page : 1;
            failedPage = safePage;
            const version = ++failedRequestVersion;
            elements.failedLoading.hidden = false;
            elements.failedLoading.setAttribute?.('aria-busy', 'true');
            elements.failedError.hidden = true;
            elements.failedEmpty.hidden = true;
            elements.failedPrevious.disabled = true;
            elements.failedNext.disabled = true;
            try {
                const result = await api.get(`/admin/submissions?syncStatus=failed&page=${safePage}&limit=${PAGE_SIZE}`);
                if (version !== failedRequestVersion) return;
                if (!Array.isArray(result?.submissions) || !result.pagination) throw new Error('invalid_response');
                const pageCount = Number(result.pagination.totalPages) || 0;
                const responsePage = Number(result.pagination.page);
                if (!Number.isSafeInteger(responsePage) || responsePage < 1) throw new Error('invalid_response');
                if (pageCount > 0 && responsePage > pageCount) return loadFailedTasks(pageCount);
                if (pageCount === 0 && responsePage !== 1) return loadFailedTasks(1);
                failedPage = responsePage;
                failedTotalPages = pageCount;
                const count = renderFailedTasks(elements.failedList, result.submissions, document, retryTask);
                elements.failedEmpty.hidden = count > 0;
                elements.failedPagination.textContent = Number(result.pagination.total) === 0
                    ? 'No failed tasks'
                    : `Page ${failedPage} of ${failedTotalPages} · ${Number(result.pagination.total)} failed task${Number(result.pagination.total) === 1 ? '' : 's'}`;
                elements.failedPrevious.disabled = failedPage <= 1;
                elements.failedNext.disabled = failedTotalPages === 0 || failedPage >= failedTotalPages;
            } catch (error) {
                if (version !== failedRequestVersion) return;
                showApiError(elements.failedError, error, 'Failed synchronization tasks could not be loaded. Please try again.');
            } finally {
                if (version === failedRequestVersion) {
                    elements.failedLoading.hidden = true;
                    elements.failedLoading.setAttribute?.('aria-busy', 'false');
                }
            }
        }

        async function refreshAll({ afterMutation = false } = {}) {
            if (statsRefreshPromise) {
                if (!afterMutation) return statsRefreshPromise;
                await statsRefreshPromise;
            }
            root.NeuroLearnLoading?.setButtonLoading(elements.refresh, true, 'Refreshing synchronization information');
            if (!root.NeuroLearnLoading) elements.refresh.disabled = true;
            elements.refreshing.hidden = false;
            elements.refreshing.setAttribute?.('aria-busy', 'true');
            statsRefreshPromise = Promise.allSettled([
                loadStatistics(),
                checkWorkerHealth(),
                loadFailedTasks(failedPage)
            ]).then(() => undefined).finally(() => {
                root.NeuroLearnLoading?.setButtonLoading(elements.refresh, false);
                if (!root.NeuroLearnLoading) elements.refresh.disabled = false;
                elements.refreshing.hidden = true;
                elements.refreshing.setAttribute?.('aria-busy', 'false');
                statsRefreshPromise = null;
            });
            return statsRefreshPromise;
        }

        async function retryTask(outboxId, button) {
            const id = validOutboxId(outboxId);
            if (!id || retrying.has(id)) return;
            retrying.add(id);
            if (!root.NeuroLearnLoading) button.disabled = true;
            const approved = confirmFn(
                `Retry synchronization task ${id}? This requests synchronization again and does not change the submission's review decision.`
            );
            if (!approved) {
                retrying.delete(id);
                root.NeuroLearnLoading?.setButtonLoading(button, false);
                if (!root.NeuroLearnLoading) button.disabled = false;
                return;
            }

            root.NeuroLearnLoading?.setButtonLoading(button, true, 'Retrying synchronization');
            if (root.NeuroLearnLoading?.showIndicator) root.NeuroLearnLoading.showIndicator(elements.retryMessage, 'Requesting synchronization retry');
            try {
                const result = await api.post(`/admin/submissions/outbox/${encodeURIComponent(id)}/retry`);
                if (result?.success !== true || validOutboxId(result.outboxId) !== id || result.sync?.status !== 'pending') {
                    throw new Error('The server did not confirm that the retry was queued.');
                }
                setTextState(elements.retryMessage, 'Synchronization retry queued. The submission review decision is unchanged.', 'success');
                await refreshAll({ afterMutation: true });
            } catch (error) {
                showApiError(elements.retryMessage, error, 'The synchronization retry could not be queued. Please try again.');
                root.NeuroLearnLoading?.setButtonLoading(button, false);
                if (!root.NeuroLearnLoading) button.disabled = false;
            } finally {
                root.NeuroLearnLoading?.setButtonLoading(button, false);
                if (!root.NeuroLearnLoading) button.disabled = false;
                retrying.delete(id);
            }
        }

        elements.refresh.addEventListener('click', () => refreshAll());
        elements.failedPrevious.addEventListener('click', () => {
            if (failedPage > 1) loadFailedTasks(failedPage - 1);
        });
        elements.failedNext.addEventListener('click', () => {
            if (failedPage < failedTotalPages) loadFailedTasks(failedPage + 1);
        });

        return { checkWorkerHealth, loadFailedTasks, loadStatistics, refreshAll, retryTask };
    }

    function initializeKnowledgeSyncOperations({ document, api, confirmFn = root.confirm?.bind(root) }) {
        const section = document.getElementById('admin-sync-operations');
        if (!section) return null;
        if (!api.isAdministrator()) {
            section.hidden = true;
            return null;
        }
        section.hidden = false;
        const element = id => document.getElementById(id);
        const statValues = {
            pending: element('sync-stat-pending'),
            processing: element('sync-stat-processing'),
            completed: element('sync-stat-completed'),
            failed: element('sync-stat-failed'),
            expired: element('sync-stat-expired'),
            outstanding: element('sync-stat-outstanding'),
            oldest: element('sync-stat-oldest'),
            lastSync: element('sync-stat-last-sync')
        };
        const controller = createKnowledgeSyncOperations({
            api,
            document,
            confirmFn: typeof confirmFn === 'function' ? confirmFn : () => false,
            elements: {
                refresh: element('admin-sync-refresh'),
                refreshing: element('admin-sync-refreshing'),
                statsError: element('admin-sync-stats-error'),
                statValues,
                healthChecked: element('admin-worker-last-checked'),
                workerState: element('admin-worker-state'),
                workerMessage: element('admin-worker-message'),
                workerLastPoll: element('admin-worker-last-poll'),
                failedLoading: element('admin-failed-loading'),
                failedError: element('admin-failed-error'),
                failedEmpty: element('admin-failed-empty'),
                failedList: element('admin-failed-task-list'),
                failedPagination: element('admin-failed-pagination'),
                failedPrevious: element('admin-failed-previous'),
                failedNext: element('admin-failed-next'),
                retryMessage: element('admin-retry-message')
            }
        });
        controller.refreshAll();
        return controller;
    }

    const api = {
        createKnowledgeSyncOperations,
        formatTimestamp,
        initializeKnowledgeSyncOperations,
        renderFailedTasks,
        validOutboxId
    };
    root.NeuroLearnSyncOperations = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
