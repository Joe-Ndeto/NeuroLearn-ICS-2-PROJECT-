
'use strict';

const API_BASE_URL = 'http://localhost:5000/api';

const storedLearner = sessionStorage.getItem('neurolearnLearner');
const storedToken = sessionStorage.getItem('neurolearnToken');

let learner = null;
let documents = [];
let selectedDocumentId = null;
let isUploading = false;
let isGeneratingSummary = false;
let isSendingMessage = false;
let isGeneratingQuiz = false;

// Send the JWT with every protected API request.
async function authenticatedFetch(url, options = {}) {
    const token = sessionStorage.getItem('neurolearnToken');

    if (!token) {
        sessionStorage.removeItem('neurolearnLearner');
        sessionStorage.removeItem('neurolearnToken');
        window.location.replace('login_signup.html');
        throw new Error('Your session has expired. Please sign in again.');
    }

    const headers = new Headers(options.headers || {});
    headers.set('Authorization', `Bearer ${token}`);

    const response = await fetch(url, {
        ...options,
        headers
    });

    if (response.status === 401) {
        sessionStorage.removeItem('neurolearnLearner');
        sessionStorage.removeItem('neurolearnToken');
        window.location.replace('login_signup.html');
    }

    return response;
}

if (!storedLearner || !storedToken) {
    window.location.replace('login_signup.html');
} else {
    try {
        learner = JSON.parse(storedLearner);

        if (
            !learner ||
            !Number.isInteger(Number(learner.learner_id))
        ) {
            throw new Error('Learner information is missing or invalid.');
        }
    } catch (error) {
        console.error('Could not load learner information:', error);
        sessionStorage.removeItem('neurolearnLearner');
        sessionStorage.removeItem('neurolearnToken');
        window.location.replace('login_signup.html');
    }
}

const $ = id => document.getElementById(id);

const learnerName = $('learner-name');
const logoutButton = $('logout-button');
const fileInput = $('document-file');
const uploadButton = $('upload-document');
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
const questionCountInput = $('question-count');
const quizResult = $('quiz-result');

if (learnerName && learner) {
    learnerName.textContent =
        learner.username || learner.name || 'Learner';
}

if (logoutButton) {
    logoutButton.addEventListener('click', () => {
        sessionStorage.removeItem('neurolearnLearner');
        sessionStorage.removeItem('neurolearnToken');
        window.location.replace('login_signup.html');
    });
}

function setDocumentStatus(message) {
    if (documentStatus) {
        documentStatus.textContent = message;
    }
}

async function readResponse(response) {
    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error(
            `The server returned an invalid response (${response.status}).`
        );
    }

    if (!response.ok) {
        throw new Error(
            data.error ||
            data.message ||
            `Request failed with status ${response.status}.`
        );
    }

    return data;
}

function normalizeDocument(item) {
    return {
        ...item,
        document_id: item.document_id ?? item.documentId,
        filename: item.filename || item.originalName || 'Untitled document',
        file_type: String(
            item.file_type || item.type || 'file'
        ).toUpperCase(),
        processing_status: String(
            item.processing_status || item.processingStatus || 'unknown'
        ).toLowerCase()
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
        item.filename.toLowerCase().includes(term)
    );

    documentList.replaceChildren();

    if (!filtered.length) {
        const p = document.createElement('p');
        p.className = 'empty-message';
        p.textContent = term
            ? 'No matching documents found.'
            : 'No uploaded documents found. Upload your first document.';

        documentList.appendChild(p);
        return;
    }

    filtered.forEach(item => {
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
        name.textContent = item.filename;

        const status = document.createElement('small');
        status.textContent = item.processing_status;

        details.append(name, status);
        button.append(icon, details);

        button.addEventListener('click', () => selectDocument(item));

        documentList.appendChild(button);
    });
}

function selectDocument(item) {
    selectedDocumentId = item.document_id;

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
    setDocumentStatus('Loading your documents...');

    try {
        const response = await authenticatedFetch(`${API_BASE_URL}/upload`);
        const data = await readResponse(response);

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
            selected =
                documents.find(
                    document => document.processing_status === 'processed'
                ) || documents[0];

            selectedDocumentId = selected.document_id;
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
                    'Upload or select a document to begin.';
            }
        }

        renderDocuments();
        setDocumentStatus(`${documents.length} document(s) loaded.`);
    } catch (error) {
        console.error('Document loading failed:', error);
        setDocumentStatus(`Could not load documents: ${error.message}`);
    }
}

if (uploadButton && fileInput) {
    uploadButton.addEventListener('click', async () => {
        if (isUploading) return;

        const file = fileInput.files?.[0];

        if (!file) {
            setDocumentStatus(
                'Please choose a PDF, DOCX, or PPTX file first.'
            );
            return;
        }

        const extension = file.name
            .substring(file.name.lastIndexOf('.'))
            .toLowerCase();

        if (!['.pdf', '.docx', '.pptx'].includes(extension)) {
            setDocumentStatus(
                'Only PDF, DOCX, and PPTX files are supported.'
            );
            return;
        }

        if (file.size > 10 * 1024 * 1024) {
            setDocumentStatus('The file must not exceed 10 MB.');
            return;
        }

        const formData = new FormData();
        formData.append('document', file);

        isUploading = true;
        uploadButton.disabled = true;
        uploadButton.textContent = 'Uploading...';

        setDocumentStatus(
            'Uploading and processing your document. Please wait...'
        );

        try {
            const response = await authenticatedFetch(`${API_BASE_URL}/upload`, {
                method: 'POST',
                body: formData
            });

            const data = await readResponse(response);

            const newId =
                data.file?.documentId ??
                data.document?.document_id;

            await loadDocuments({
                selectDocumentId: newId ?? null
            });

            const uploaded = documents.find(
                document => String(document.document_id) === String(newId)
            );

            if (uploaded) {
                selectDocument(uploaded);
            }

            fileInput.value = '';

            setDocumentStatus(
                data.message || 'Document uploaded successfully.'
            );
        } catch (error) {
            console.error('Document upload failed:', error);
            setDocumentStatus(`Upload failed: ${error.message}`);
        } finally {
            isUploading = false;
            uploadButton.disabled = false;
            uploadButton.textContent = 'Upload Selected File';
        }
    });
}

if (refreshButton) {
    refreshButton.addEventListener('click', () => loadDocuments());
}

if (searchInput) {
    searchInput.addEventListener('input', renderDocuments);
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
        button.disabled = true;
        button.textContent = 'Generating...';
    });

    if (summaryResult) {
        summaryResult.textContent =
            `Generating a summary of "${selected.filename}". Please wait...`;
    }

    setDocumentStatus(
        'NeuroLearn is generating your summary with Gemini...'
    );

    try {
        const response = await authenticatedFetch(`${API_BASE_URL}/ai/summarize`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: Number(selectedDocumentId)
            })
        });

        const data = await readResponse(response);

        if (typeof data.summary !== 'string' || !data.summary.trim()) {
            throw new Error('The server returned an empty summary.');
        }

        if (summaryResult) {
            summaryResult.innerHTML = formatSummary(data.summary);
        }

        setDocumentStatus('Summary generated successfully.');
    } catch (error) {
        console.error('Summary generation failed:', error);

        if (summaryResult) {
            summaryResult.textContent =
                `Could not generate summary: ${error.message}`;
        }

        setDocumentStatus(`Summary failed: ${error.message}`);
    } finally {
        isGeneratingSummary = false;

        if (summaryButton) {
            summaryButton.disabled = false;
            summaryButton.textContent = 'Summarize';
        }

        if (panelSummaryButton) {
            panelSummaryButton.disabled = false;
            panelSummaryButton.textContent = 'Generate Summary';
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
        // Keep the send icon visible while preventing duplicate submissions.
        sendButton.disabled = true;
    }

    appendChatMessage(question, 'user');

    if (chatInput) {
        chatInput.value = '';
    }

    const loading = appendChatMessage(
        'Reading your notes and preparing an answer...',
        'ai'
    );

    setDocumentStatus('NeuroLearn is answering your question...');

    try {
        const response = await authenticatedFetch(`${API_BASE_URL}/ai/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: Number(selectedDocumentId),
                message: question
            })
        });

        const data = await readResponse(response);

        if (typeof data.answer !== 'string' || !data.answer.trim()) {
            throw new Error('The server returned an empty answer.');
        }

        if (loading) {
            loading.querySelector('p').textContent = data.answer;
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
            loading.querySelector('p').textContent =
                `Sorry, I could not answer that: ${error.message}`;
        }

        setDocumentStatus(`Chat failed: ${error.message}`);
    } finally {
        isSendingMessage = false;

        if (sendButton) {
            // Re-enable the button without changing its send icon.
            sendButton.disabled = false;
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

        submit.disabled = true;
        submit.textContent = 'Saving results...';

        setDocumentStatus(
            'Saving your quiz results and updating concept mastery...'
        );

        try {
            const response = await authenticatedFetch(
                `${API_BASE_URL}/ai/quiz/submit`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        quizId,
                        answers
                    })
                }
            );

            const result = await readResponse(response);

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
            submit.disabled = false;
            submit.textContent = 'Retry Saving Answers';

            setDocumentStatus(`Quiz save failed: ${error.message}`);
        }
    });
}

// Generate a quiz for the selected document.
async function generateDocumentQuiz() {
    if (isGeneratingQuiz) return;

    const selected = requireSelectedDocument();
    if (!selected) return;

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
        button.disabled = true;
        button.textContent = 'Generating quiz...';
    });

    if (quizResult) {
        quizResult.replaceChildren();

        const paragraph = document.createElement('p');
        paragraph.textContent =
            `Generating ${questionCount} questions from "${selected.filename}". Please wait...`;

        quizResult.appendChild(paragraph);
    }

    setDocumentStatus('NeuroLearn is generating your quiz...');

    try {
        const response = await authenticatedFetch(`${API_BASE_URL}/ai/quiz`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                documentId: Number(selectedDocumentId),
                questionCount
            })
        });

        const data = await readResponse(response);

        if (
            typeof data.quizId !== 'string' ||
            !Array.isArray(data.questions) ||
            data.questions.length !== questionCount
        ) {
            throw new Error('The server returned an invalid quiz.');
        }

        renderQuiz(data.quizId, data.questions);

        setDocumentStatus(
            'Quiz generated. Complete all questions and submit to save your results.'
        );
    } catch (error) {
        console.error('Quiz generation failed:', error);

        if (quizResult) {
            quizResult.replaceChildren();

            const paragraph = document.createElement('p');
            paragraph.textContent =
                `Could not generate quiz: ${error.message}`;

            quizResult.appendChild(paragraph);
        }

        setDocumentStatus(`Quiz failed: ${error.message}`);
    } finally {
        isGeneratingQuiz = false;

        if (generateQuizButton) {
            generateQuizButton.disabled = false;
            generateQuizButton.textContent = 'Generate Quiz';
        }

        if (openQuizButton) {
            openQuizButton.disabled = false;
            openQuizButton.textContent = 'Generate Quiz';
        }
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
        const response = await authenticatedFetch(
            `${API_BASE_URL}/auth/me`
        );

        const data = await readResponse(response);

        if (!data.learner || !data.learner.learner_id) {
            throw new Error('The server did not return a valid learner account.');
        }

        learner = data.learner;
        sessionStorage.setItem(
            'neurolearnLearner',
            JSON.stringify(learner)
        );

        if (learnerName) {
            learnerName.textContent =
                learner.username || learner.name || 'Learner';
        }

        await loadDocuments();
    } catch (error) {
        console.error('Study workspace initialization failed:', error);

        if (sessionStorage.getItem('neurolearnToken')) {
            setDocumentStatus(
                `Could not initialize your study workspace: ${error.message}`
            );
        }
    }
}

if (learner && storedToken) {
    initializeStudyWorkspace();
}
