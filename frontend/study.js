
'use strict';

const api = window.NeuroLearnApi;

let learner = api.getCachedLearner();
let documents = [];
let selectedDocumentId = null;
let isLoadingDocuments = false;
let isGeneratingSummary = false;
let isSendingMessage = false;
let isGeneratingQuiz = false;

const $ = id => document.getElementById(id);

const learnerName = $('learner-name');
const logoutButton = $('logout-button');
const refreshButton = $('refresh-documents');
const searchInput = $('document-search');
const documentList = $('document-list');
const documentStatus = $('document-status');
const selectedDocumentName = $('selected-document-name');
const selectedDocumentStatus = $('selected-document-status');
const summaryButton = $('summary-button');
const panelSummaryButton = $('panel-summary-button');
const summaryResult = $('summary-result');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const chatMessages = $('chat-messages');
const sendButton = $('send-button');
const openQuizButton = $('open-quiz-button');
const generateQuizButton = $('generate-quiz-button');
const quizCourseInput = $('quiz-course');
const libraryCourseInput = $('library-course');
const questionCountInput = $('question-count');
const quizResult = $('quiz-result');

if (learnerName && learner) {
    learnerName.textContent =
        learner.username || learner.name || 'Learner';
}

if (logoutButton) {
    logoutButton.addEventListener('click', () => {
        api.clearSession();
    });
}

function setDocumentStatus(message, loading = false) {
    if (documentStatus) {
        if (loading && window.NeuroLearnLoading?.showIndicator) {
            window.NeuroLearnLoading.showIndicator(documentStatus, 'Loading study workspace');
        } else if (window.NeuroLearnLoading?.showMessage) {
            window.NeuroLearnLoading.showMessage(documentStatus, message);
        } else {
            documentStatus.textContent = message;
        }
    }
}

function normalizeDocument(item) {
    return {
        ...item,
        document_id: item.document_id ?? item.documentId,
        filename: item.filename || item.title || item.originalName || 'Untitled document',
        title: item.title || item.filename || item.originalName || 'Untitled document',
        file_type: String(
            item.file_type || item.type || 'file'
        ).toUpperCase(),
        processing_status: String(
            item.processing_status || item.processingStatus || 'unknown'
        ).toLowerCase(),
        scope: item.scope || 'personal',
        review_status: item.reviewStatus || item.review_status || null,
        course_id: item.courseId || item.course_id || null,
        concept_id: item.conceptId ?? item.concept_id ?? null,
        concept_name: item.conceptName || item.concept_name || null
    };
}

function getSelectedDocument() {
    return documents.find(
        item => String(item.document_id) === String(selectedDocumentId)
    );
}

function requireSelectedDocument() {
    if (!selectedDocumentId) {
        setDocumentStatus('Please select a document first.');
        return null;
    }

    const selected = getSelectedDocument();

    if (!selected) {
        setDocumentStatus(
            'The selected document could not be found. Refresh the document list.'
        );
        return null;
    }

    if (selected.processing_status !== 'processed') {
        setDocumentStatus(
            'Please select a document that has been processed.'
        );
        return null;
    }

    return selected;
}

function renderDocuments() {
    if (!documentList) return;

    const term = searchInput?.value.trim().toLowerCase() || '';

    const filtered = documents.filter(item =>
        `${item.title} ${item.filename} ${item.concept_name || ''}`.toLowerCase().includes(term)
    );

    documentList.replaceChildren();

    if (!filtered.length) {
        const p = document.createElement('p');
        p.className = 'empty-message';
        p.textContent = term
            ? 'No matching documents found.'
            : 'No materials are available for this course yet. Submit a document from your Dashboard or check back after resources are approved.';

        documentList.appendChild(p);
        return;
    }

    const renderCard = item => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'document-card';

        if (
            String(item.document_id) === String(selectedDocumentId)
        ) {
            button.classList.add('selected');
        }

        const icon = document.createElement('span');
        icon.className = 'file-icon';
        icon.textContent = item.file_type;

        const details = document.createElement('span');
        details.className = 'document-details';

        const name = document.createElement('strong');
        name.textContent = item.title;

        const status = document.createElement('small');
        const labels = [item.processing_status];
        if (item.scope === 'shared') labels.push('approved shared resource');
        else if (item.review_status) labels.push(`${item.review_status} submission`);
        status.textContent = labels.join(' · ');

        details.append(name, status);
        button.append(icon, details);

        button.addEventListener('click', () => selectDocument(item));

        return button;
    };

    const shared = filtered.filter(item => item.scope === 'shared');
    const personal = filtered.filter(item => item.scope !== 'shared');
    const makeGroup = (title, items, expanded = true) => {
        if (!items.length) return;
        const details = document.createElement('details');
        details.className = 'library-group';
        details.open = expanded;
        const summary = document.createElement('summary');
        summary.textContent = title;
        details.appendChild(summary);
        items.forEach(item => details.appendChild(renderCard(item)));
        documentList.appendChild(details);
    };

    if (shared.length) {
        const courseName = libraryCourseInput?.selectedOptions?.[0]?.textContent || 'Selected course';
        const courseGroup = document.createElement('details');
        courseGroup.className = 'library-course-group';
        courseGroup.open = true;
        const courseSummary = document.createElement('summary');
        courseSummary.textContent = courseName;
        courseGroup.appendChild(courseSummary);
        const byConcept = new Map();
        shared.forEach(item => {
            const conceptKey = item.concept_id == null ? 'uncategorised' : String(item.concept_id);
            if (!byConcept.has(conceptKey)) byConcept.set(conceptKey, []);
            byConcept.get(conceptKey).push(item);
        });
        for (const [conceptId, conceptItems] of byConcept) {
            const conceptGroup = document.createElement('details');
            conceptGroup.className = 'library-concept-group';
            conceptGroup.open = true;
            const conceptSummary = document.createElement('summary');
            conceptSummary.textContent = conceptId === 'uncategorised'
                ? 'Uncategorised'
                : conceptItems[0].concept_name || 'Concept';
            conceptGroup.appendChild(conceptSummary);
            conceptItems.forEach(item => conceptGroup.appendChild(renderCard(item)));
            courseGroup.appendChild(conceptGroup);
        }
        documentList.appendChild(courseGroup);
    }
    makeGroup('Uncategorised — my personal uploads', personal.filter(item => !item.review_status));
    makeGroup('My resource submissions', personal.filter(item => ['pending', 'rejected'].includes(item.review_status)));
    makeGroup('Approved submissions not ready for study', personal.filter(item => item.review_status === 'approved' && item.processing_status !== 'processed'));
}

function selectDocument(item) {
    selectedDocumentId = item.document_id;

    if (item.scope === 'shared' && item.course_id) {
        for (const selector of [libraryCourseInput, quizCourseInput].filter(Boolean)) {
            if ([...selector.options].some(option => option.value === item.course_id)) {
                selector.value = item.course_id;
            }
        }
    }

    if (selectedDocumentName) {
        selectedDocumentName.textContent = item.filename;
    }

    if (selectedDocumentStatus) {
        selectedDocumentStatus.textContent =
            `Document ID: ${item.document_id} · Status: ${item.processing_status}`;
    }

    renderDocuments();

    setDocumentStatus(
        item.processing_status === 'processed'
            ? `Selected: ${item.filename}`
            : 'This document is not processed yet. Please select a processed document.'
    );

    if (summaryResult) {
        summaryResult.textContent =
            'Click Generate Summary to summarize this document.';
    }

    if (quizResult) {
        quizResult.replaceChildren();

        const p = document.createElement('p');
        p.textContent =
            'Generate a quiz to test your understanding of this document.';

        quizResult.appendChild(p);
    }
}

async function loadDocuments(options = {}) {
    if (isLoadingDocuments) return;
    isLoadingDocuments = true;
    window.NeuroLearnLoading?.setButtonLoading(refreshButton, true, 'Refreshing documents');
    setDocumentStatus('', true);

    try {
        const selectedCourseId = libraryCourseInput?.value || '';
        const query = selectedCourseId ? `?courseId=${encodeURIComponent(selectedCourseId)}` : '';
        const data = await api.get(`/upload/library${query}`);

        documents = (
            Array.isArray(data) ? data : data.documents || []
        )
            .map(normalizeDocument)
            .filter(document => document.document_id != null);

        if (options.selectDocumentId != null) {
            selectedDocumentId = options.selectDocumentId;
        }

        let selected = documents.find(
            document =>
                String(document.document_id) ===
                String(selectedDocumentId)
        );

        if (!selected && documents.length) {
            selected = documents.find(document => document.processing_status === 'processed') || null;
            selectedDocumentId = selected?.document_id ?? null;
        }

        if (selected) {
            if (selectedDocumentName) {
                selectedDocumentName.textContent = selected.filename;
            }

            if (selectedDocumentStatus) {
                selectedDocumentStatus.textContent =
                    `Document ID: ${selected.document_id} · Status: ${selected.processing_status}`;
            }
        } else {
            selectedDocumentId = null;

            if (selectedDocumentName) {
                selectedDocumentName.textContent = 'No document selected';
            }

            if (selectedDocumentStatus) {
                selectedDocumentStatus.textContent =
                    'Choose a processed document from your library to begin.';
            }
        }

        renderDocuments();
        setDocumentStatus(`${documents.length} learning material(s) loaded.`);
    } catch (error) {
        console.error('Document loading failed:', error);
        documentList?.replaceChildren();
        setDocumentStatus(`Could not load documents: ${error.message}`);
    } finally {
        isLoadingDocuments = false;
        window.NeuroLearnLoading?.setButtonLoading(refreshButton, false);
    }
}

if (refreshButton) {
    refreshButton.addEventListener('click', async () => {
        await loadQuizCourses();
        await loadDocuments();
    });
}

if (searchInput) {
    searchInput.addEventListener('input', renderDocuments);
}

function synchronizeCourseSelection(source) {
    const target = source === libraryCourseInput ? quizCourseInput : libraryCourseInput;
    if (target && target.value !== source.value) target.value = source.value;
}

if (libraryCourseInput) {
    libraryCourseInput.addEventListener('change', () => {
        synchronizeCourseSelection(libraryCourseInput);
        loadDocuments();
    });
}
if (quizCourseInput) {
    quizCourseInput.addEventListener('change', () => {
        synchronizeCourseSelection(quizCourseInput);
        loadDocuments();
    });
}

// Escape text before inserting formatted Markdown into HTML.
function escapeHTML(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatSummary(markdown) {
    const escaped = escapeHTML(markdown || '');

    return escaped
        .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^### (.+)$/gm, '<h3>$1</h3>')
        .replace(/^## (.+)$/gm, '<h2>$1</h2>')
        .replace(/^# (.+)$/gm, '<h1>$1</h1>')
        .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .split(/\n{2,}/)
        .map(part =>
            /^(<h[1-4]>|<ul>)/.test(part.trim())
                ? part
                : `<p>${part.replace(/\n/g, '<br>')}</p>`
        )
        .join('\n');
}

// Generate a summary for the selected document.
async function generateDocumentSummary() {
    if (isGeneratingSummary) return;

    const selected = requireSelectedDocument();
    if (!selected) return;

    isGeneratingSummary = true;

    const buttons = [
        summaryButton,
        panelSummaryButton
    ].filter(Boolean);

    buttons.forEach(button => {
        window.NeuroLearnLoading?.setButtonLoading(button, true, 'Generating summary');
    });

    if (summaryResult) {
        if (window.NeuroLearnLoading?.showIndicator) window.NeuroLearnLoading.showIndicator(summaryResult, 'Generating document summary');
    }

    setDocumentStatus('', true);

    try {
        const data = await api.post('/ai/summarize', {
            documentId: Number(selectedDocumentId),
            courseId: selected.scope === 'shared' ? selected.course_id : null,
            conceptId: selected.scope === 'shared' ? Number(selected.concept_id) : null
        });

        if (typeof data.summary !== 'string' || !data.summary.trim()) {
            throw new Error('The server returned an empty summary.');
        }

        if (summaryResult) {
            window.NeuroLearnLoading?.showMessage(summaryResult, '');
            summaryResult.innerHTML = formatSummary(data.summary);
        }

        setDocumentStatus('Summary generated successfully.');
    } catch (error) {
        console.error('Summary generation failed:', error);

        if (summaryResult) {
            const message = `Could not generate summary: ${error.message}`;
            if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(summaryResult, message);
            else summaryResult.textContent = message;
        }

        setDocumentStatus(`Summary failed: ${error.message}`);
    } finally {
        isGeneratingSummary = false;

        if (summaryButton) {
            window.NeuroLearnLoading?.setButtonLoading(summaryButton, false);
        }

        if (panelSummaryButton) {
            window.NeuroLearnLoading?.setButtonLoading(panelSummaryButton, false);
        }
    }
}

if (summaryButton) {
    summaryButton.addEventListener('click', generateDocumentSummary);
}

if (panelSummaryButton) {
    panelSummaryButton.addEventListener(
        'click',
        generateDocumentSummary
    );
}

// Add a chat message to the interface.
function appendChatMessage(message, sender) {
    if (!chatMessages) return null;

    const element = document.createElement('div');

    element.className =
        `chat-message ${sender === 'user' ? 'user-message' : 'ai-message'}`;

    const paragraph = document.createElement('p');
    paragraph.textContent = message;

    element.appendChild(paragraph);
    chatMessages.appendChild(element);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    return element;
}

// Ask NeuroLearn a question about the selected document.
async function sendChatMessage(message) {
    if (isSendingMessage) return;

    const selected = requireSelectedDocument();
    if (!selected) return;

    const question = String(message || '').trim();

    if (!question) return;

    if (question.length > 2000) {
        setDocumentStatus(
            'Your question must not exceed 2,000 characters.'
        );
        return;
    }

    isSendingMessage = true;

    if (sendButton) {
        window.NeuroLearnLoading?.setButtonLoading(sendButton, true, 'Sending message');
        if (!window.NeuroLearnLoading) sendButton.disabled = true;
    }

    appendChatMessage(question, 'user');

    if (chatInput) {
        chatInput.value = '';
    }

    const loading = appendChatMessage('', 'ai');
    const loadingParagraph = loading?.querySelector('p');
    if (loadingParagraph && window.NeuroLearnLoading?.showIndicator) window.NeuroLearnLoading.showIndicator(loadingParagraph, 'Preparing an AI answer');

    setDocumentStatus('', true);

    try {
        const data = await api.post('/ai/chat', {
            documentId: Number(selectedDocumentId),
            message: question,
            courseId: selected.scope === 'shared' ? selected.course_id : null,
            conceptId: selected.scope === 'shared' ? Number(selected.concept_id) : null
        });

        if (typeof data.answer !== 'string' || !data.answer.trim()) {
            throw new Error('The server returned an empty answer.');
        }

        if (loading) {
            if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(loadingParagraph, data.answer);
            else loadingParagraph.textContent = data.answer;
        }

        if (
            Array.isArray(data.sources) &&
            data.sources.length &&
            loading
        ) {
            const list = document.createElement('ul');

            data.sources.forEach(source => {
                try {
                    const url = new URL(source.url);

                    if (!['http:', 'https:'].includes(url.protocol)) {
                        return;
                    }

                    const li = document.createElement('li');
                    const link = document.createElement('a');

                    link.href = url.href;
                    link.textContent = source.title || url.hostname;
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';

                    li.appendChild(link);
                    list.appendChild(li);
                } catch {
                    // Skip malformed URLs.
                }
            });

            if (list.childNodes.length) {
                const label = document.createElement('p');
                label.textContent = 'Sources:';
                loading.append(label, list);
            }
        }

        setDocumentStatus(
            data.searchPerformed
                ? 'Answer received with online research.'
                : 'Answer received.'
        );
    } catch (error) {
        console.error('Chat request failed:', error);

        if (loading) {
            const message = `Sorry, I could not answer that: ${error.message}`;
            if (window.NeuroLearnLoading?.showMessage) window.NeuroLearnLoading.showMessage(loadingParagraph, message);
            else loadingParagraph.textContent = message;
        }

        setDocumentStatus(`Chat failed: ${error.message}`);
    } finally {
        isSendingMessage = false;

        if (sendButton) {
            window.NeuroLearnLoading?.setButtonLoading(sendButton, false);
            if (!window.NeuroLearnLoading) sendButton.disabled = false;
        }

        if (chatMessages) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        chatInput?.focus();
    }
}

if (chatForm) {
    chatForm.addEventListener('submit', async event => {
        event.preventDefault();

        if (chatInput) {
            await sendChatMessage(chatInput.value);
        }
    });
}

// Enter sends the message; Shift + Enter inserts a new line.
if (chatInput && chatForm) {
    chatInput.addEventListener('keydown', event => {
        if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.isComposing
        ) {
            event.preventDefault();

            if (!isSendingMessage && chatInput.value.trim()) {
                chatForm.requestSubmit();
            }
        }
    });
}

document
    .querySelectorAll('.suggested-prompts [data-prompt]')
    .forEach(button => {
        button.addEventListener('click', async () => {
            if (button.dataset.prompt) {
                await sendChatMessage(button.dataset.prompt);
            }
        });
    });

// Display quiz questions and submit answers for server-side scoring.
function renderQuiz(quizId, questions) {
    if (!quizResult) return;

    quizResult.replaceChildren();

    if (!Array.isArray(questions) || !questions.length) {
        const paragraph = document.createElement('p');
        paragraph.textContent = 'No quiz questions were returned.';
        quizResult.appendChild(paragraph);
        return;
    }

    const form = document.createElement('form');
    form.id = 'generated-quiz-form';

    const heading = document.createElement('h3');
    heading.textContent = 'Test Your Understanding';

    const instruction = document.createElement('p');
    instruction.textContent =
        'Choose one answer for each question, then submit to save your score and review explanations.';

    form.append(heading, instruction);

    questions.forEach((question, index) => {
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'quiz-question';

        const legend = document.createElement('legend');
        legend.textContent = `${index + 1}. ${question.question}`;

        fieldset.appendChild(legend);

        if (question.conceptName) {
            const concept = document.createElement('small');
            concept.className = 'quiz-concept';
            concept.textContent = `Concept: ${question.conceptName}`;
            fieldset.appendChild(concept);
        }

        question.options.forEach(option => {
            const label = document.createElement('label');
            label.className = 'quiz-option';

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `question-${index}`;
            input.value = option;
            input.required = true;

            const span = document.createElement('span');
            span.textContent = option;

            label.append(input, span);
            fieldset.appendChild(label);
        });

        form.appendChild(fieldset);
    });

    const submit = document.createElement('button');
    submit.type = 'submit';
    submit.className = 'quiz-submit-button';
    submit.textContent = 'Submit Answers';

    form.appendChild(submit);
    quizResult.appendChild(form);

    form.addEventListener('submit', async event => {
        event.preventDefault();

        if (submit.disabled) return;

        const formData = new FormData(form);

        const answers = questions.map(
            (question, questionIndex) => ({
                questionIndex,
                selectedAnswer: String(
                    formData.get(`question-${questionIndex}`) ?? ''
                )
            })
        );

        window.NeuroLearnLoading?.setButtonLoading(submit, true, 'Saving quiz results');
        if (!window.NeuroLearnLoading) submit.disabled = true;
        setDocumentStatus('', true);

        try {
            const result = await api.post('/ai/quiz/submit', {
                quizId,
                answers
            });

            const reviewContainer = document.createElement('div');
            reviewContainer.className = 'quiz-review-container';

            (result.review || []).forEach((item, index) => {
                const review = document.createElement('div');
                review.className = 'quiz-review';

                const title = document.createElement('h4');
                title.textContent =
                    `${index + 1}. ${item.isCorrect ? 'Correct' : 'Review your answer'}`;

                const concept = document.createElement('p');
                concept.textContent =
                    `Concept: ${item.conceptName || 'Unspecified'}`;

                const yourAnswer = document.createElement('p');
                yourAnswer.textContent =
                    `Your answer: ${item.selectedAnswer || 'No answer'}`;

                const correctAnswer = document.createElement('p');
                correctAnswer.textContent =
                    `Correct answer: ${item.correctAnswer}`;

                const explanation = document.createElement('p');
                explanation.textContent =
                    `Explanation: ${item.explanation}`;

                review.append(
                    title,
                    concept,
                    yourAnswer,
                    correctAnswer,
                    explanation
                );

                reviewContainer.appendChild(review);
            });

            const resultHeading = document.createElement('h3');
            resultHeading.textContent =
                `Your score: ${result.correctCount} / ${result.totalQuestions}`;

            const resultText = document.createElement('p');
            resultText.textContent =
                `Overall score: ${Number(result.overallScore).toFixed(2)}%. Your result has been saved.`;

            const conceptHeading = document.createElement('h3');
            conceptHeading.textContent = 'Concept mastery';

            const conceptList = document.createElement('ul');

            (result.conceptResults || []).forEach(item => {
                const li = document.createElement('li');

                li.textContent =
                    `${item.conceptName}: ${Number(item.masteryLevel).toFixed(2)}%` +
                    (item.needsRevision
                        ? ' — recommended for revision'
                        : '');

                conceptList.appendChild(li);
            });

            form.replaceChildren(
                resultHeading,
                resultText,
                conceptHeading,
                conceptList,
                reviewContainer
            );

            setDocumentStatus(
                `Quiz saved. Score: ${result.correctCount}/${result.totalQuestions} (${Number(result.overallScore).toFixed(2)}%).`
            );
        } catch (error) {
            console.error('Quiz submission failed:', error);

            const message = document.createElement('p');
            message.className = 'error-message';
            message.textContent =
                `Your results could not be saved: ${error.message}. Your quiz answers may still be available; try submitting again only if the quiz has not expired.`;

            form.prepend(message);
            window.NeuroLearnLoading?.setButtonLoading(submit, false);
            submit.textContent = 'Retry Saving Answers';
            if (!window.NeuroLearnLoading) {
                submit.disabled = false;
            }

            setDocumentStatus(`Quiz save failed: ${error.message}`);
        }
    });
}

// Generate a quiz for the selected document.
async function generateDocumentQuiz() {
    if (isGeneratingQuiz) return;

    const selected = requireSelectedDocument();
    if (!selected) return;

    if (selected.scope !== 'shared' || !selected.concept_id || !selected.course_id) {
        setDocumentStatus('Quizzes are available for approved shared documents selected under a course concept.');
        return;
    }

    const courseId = typeof selected.course_id === 'string' ? selected.course_id.trim() : '';
    if (!courseId) {
        setDocumentStatus('Choose a course before generating a quiz.');
        quizCourseInput?.focus();
        return;
    }

    const questionCount = Number(questionCountInput?.value || 5);

    if (
        !Number.isInteger(questionCount) ||
        questionCount < 1 ||
        questionCount > 10
    ) {
        setDocumentStatus('Choose between 1 and 10 quiz questions.');
        return;
    }

    isGeneratingQuiz = true;

    const buttons = [
        generateQuizButton,
        openQuizButton
    ].filter(Boolean);

    buttons.forEach(button => {
        window.NeuroLearnLoading?.setButtonLoading(button, true, 'Generating quiz');
    });

    if (quizResult) {
        if (window.NeuroLearnLoading?.showIndicator) window.NeuroLearnLoading.showIndicator(quizResult, 'Generating quiz questions');
    }

    setDocumentStatus('', true);

    try {
        const data = await api.post('/ai/quiz', {
            documentId: Number(selectedDocumentId),
            questionCount,
            courseId,
            conceptId: Number(selected.concept_id)
        });

        if (
            typeof data.quizId !== 'string' ||
            !Array.isArray(data.questions) ||
            data.questions.length !== questionCount
        ) {
            throw new Error('The server returned an invalid quiz.');
        }

        window.NeuroLearnLoading?.showMessage(quizResult, '');
        renderQuiz(data.quizId, data.questions);

        setDocumentStatus(
            'Quiz generated. Complete all questions and submit to save your results.'
        );
    } catch (error) {
        console.error('Quiz generation failed:', error);

        if (quizResult) {
            quizResult.replaceChildren();
            quizResult.classList?.remove('nl-loading-indicator', 'nl-loading-indicator--section');
            quizResult.setAttribute('aria-busy', 'false');

            const paragraph = document.createElement('p');
            paragraph.textContent =
                `Could not generate quiz: ${error.message}`;

            quizResult.appendChild(paragraph);
        }

        setDocumentStatus(`Quiz failed: ${error.message}`);
    } finally {
        isGeneratingQuiz = false;

        if (generateQuizButton) {
            window.NeuroLearnLoading?.setButtonLoading(generateQuizButton, false);
        }

        if (openQuizButton) {
            window.NeuroLearnLoading?.setButtonLoading(openQuizButton, false);
        }
    }
}

async function loadQuizCourses() {
    const selectors = [libraryCourseInput, quizCourseInput].filter(Boolean);
    if (!selectors.length) return;
    const previous = new Map(selectors.map(selector => [selector, selector.value]));
    selectors.forEach(selector => {
        selector.disabled = false;
        selector.replaceChildren();
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = selector === libraryCourseInput
            ? 'Select a course to browse shared materials'
            : 'Select a course';
        selector.appendChild(placeholder);
    });

    try {
        const result = await api.get('/submissions/resource-options');
        if (result?.success !== true || !Array.isArray(result.courses)) {
            throw new Error('Course list is unavailable.');
        }
        for (const course of result.courses) {
            const courseId = course?.courseId ?? course?.course_id;
            const courseName = course?.name;
            if (typeof courseId !== 'string' || !courseId.trim() ||
                typeof courseName !== 'string' || !courseName.trim()) continue;
            selectors.forEach(selector => {
                const option = document.createElement('option');
                option.value = courseId;
                option.textContent = courseName.trim();
                selector.appendChild(option);
            });
        }
        if (selectors[0].options.length === 1) {
            selectors.forEach(selector => { selector.options[0].textContent = 'No courses available'; });
            setDocumentStatus('No courses are available for quiz generation. Try again later.');
        }
        selectors.forEach(selector => {
            const value = previous.get(selector);
            if (value && [...selector.options].some(option => option.value === value)) selector.value = value;
        });
    } catch {
        selectors.forEach(selector => {
            selector.options[0].textContent = 'Courses could not be loaded';
            selector.disabled = true;
        });
        setDocumentStatus('Courses could not be loaded. Refresh the study workspace and try again.');
    }
}

if (generateQuizButton) {
    generateQuizButton.addEventListener(
        'click',
        generateDocumentQuiz
    );
}

if (openQuizButton) {
    openQuizButton.addEventListener(
        'click',
        generateDocumentQuiz
    );
}

// Switch between study tabs.
document.querySelectorAll('.study-tab').forEach(button => {
    button.addEventListener('click', () => {
        const selectedTab = button.dataset.tab;

        document.querySelectorAll('.study-tab').forEach(tab => {
            tab.classList.toggle('active', tab === button);
        });

        document.querySelectorAll('.tab-content').forEach(panel => {
            const active = panel.id === `${selectedTab}-tab`;

            panel.hidden = !active;
            panel.classList.toggle('active', active);
        });
    });
});

// Confirm the learner identity with the backend before loading private data.
async function initializeStudyWorkspace() {
    try {
        learner = await api.validateSession();

        if (!learner.learner_id) {
            throw new Error('The server did not return a valid learner account.');
        }

        if (learnerName) {
            learnerName.textContent =
                learner.username || learner.name || 'Learner';
        }

        await loadQuizCourses();
        await loadDocuments();
    } catch (error) {
        console.error('Study workspace initialization failed:', error);

        setDocumentStatus(api.hasToken()
            ? 'Could not verify your session. Check your connection and try again.'
            : 'Sign in to open your study workspace.');
    }
}

initializeStudyWorkspace();
