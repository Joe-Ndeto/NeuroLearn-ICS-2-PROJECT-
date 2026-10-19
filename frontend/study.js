const API_BASE_URL = 'http://localhost:5000/api';

const storedLearner = sessionStorage.getItem('neurolearnLearner');

let learner = null;
let documents = [];
let selectedDocumentId = null;

let isUploading = false;
let isGeneratingSummary = false;
let isSendingMessage = false;
let isGeneratingQuiz = false;

// Authentication
if (!storedLearner) {
    window.location.replace('login_signup.html');
} else {
    try {
        learner = JSON.parse(storedLearner);

        if (!learner) {
            throw new Error('Learner information is missing.');
        }
    } catch (error) {
        console.error('Could not load learner information:', error);
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    }
}

// Learner and navigation
const learnerName = document.getElementById('learner-name');
const logoutButton = document.getElementById('logout-button');

// Document upload and list
const fileInput = document.getElementById('document-file');
const uploadButton = document.getElementById('upload-document');
const refreshButton = document.getElementById('refresh-documents');
const searchInput = document.getElementById('document-search');
const documentList = document.getElementById('document-list');
const documentStatus = document.getElementById('document-status');

// Selected document information
const selectedDocumentName = document.getElementById(
    'selected-document-name'
);
const selectedDocumentStatus = document.getElementById(
    'selected-document-status'
);

// Summary controls
const summaryButton = document.getElementById('summary-button');
const panelSummaryButton = document.getElementById(
    'panel-summary-button'
);
const summaryResult = document.getElementById('summary-result');

// Chat controls
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');
const sendButton = document.getElementById('send-button');
const openQuizButton = document.getElementById('open-quiz-button');

// Quiz controls
const generateQuizButton = document.getElementById('generate-quiz-button');
const questionCountInput = document.getElementById('question-count');
const quizResult = document.getElementById('quiz-result');

// Display learner name
if (learnerName && learner) {
    learnerName.textContent =
        learner.username || learner.name || 'Learner';
}

// Logout
if (logoutButton) {
    logoutButton.addEventListener('click', () => {
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    });
}

// Display document status messages
function setDocumentStatus(message) {
    if (documentStatus) {
        documentStatus.textContent = message;
    }
}

// Parse API responses and handle server errors
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
            data.message ||
            data.error ||
            `Request failed with status ${response.status}.`
        );
    }

    return data;
}

// Standardize document objects received from the API
function normalizeDocument(item) {
    return {
        ...item,
        document_id: item.document_id ?? item.documentId,
        filename: item.filename || item.originalName || 'Untitled document',
        file_type: String(
            item.file_type || item.type || 'file'
        ).toUpperCase(),
        processing_status: String(
            item.processing_status ||
            item.processingStatus ||
            'unknown'
        ).toLowerCase()
    };
}

// Get the currently selected document
function getSelectedDocument() {
    return documents.find(
        item =>
            String(item.document_id) === String(selectedDocumentId)
    );
}

// Ensure a processed document has been selected
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

// Render uploaded documents
function renderDocuments() {
    if (!documentList) return;

    const searchTerm =
        searchInput?.value.trim().toLowerCase() || '';

    const filteredDocuments = documents.filter(item =>
        item.filename.toLowerCase().includes(searchTerm)
    );

    documentList.replaceChildren();

    if (filteredDocuments.length === 0) {
        const emptyMessage = document.createElement('p');

        emptyMessage.className = 'empty-message';
        emptyMessage.textContent = searchTerm
            ? 'No matching documents found.'
            : 'No uploaded documents found. Upload your first document.';

        documentList.appendChild(emptyMessage);
        return;
    }

    filteredDocuments.forEach(item => {
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

        button.addEventListener('click', () => {
            selectDocument(item);
        });

        documentList.appendChild(button);
    });
}

// Select a document and update the interface
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

    if (item.processing_status !== 'processed') {
        setDocumentStatus(
            'This document is not processed yet. Please select a processed document.'
        );
    } else {
        setDocumentStatus(`Selected: ${item.filename}`);
    }

    if (summaryResult) {
        summaryResult.textContent =
            'Click Generate Summary to summarize this document.';
    }

    if (quizResult) {
        quizResult.replaceChildren();

        const message = document.createElement('p');
        message.textContent =
            'Generate a quiz to test your understanding of this document.';

        quizResult.appendChild(message);
    }
}

// Load uploaded documents from the backend
async function loadDocuments(options = {}) {
    const { selectDocumentId: requestedDocumentId = null } = options;

    setDocumentStatus('Loading your documents...');

    try {
        const response = await fetch(`${API_BASE_URL}/upload`);
        const data = await readResponse(response);

        const receivedDocuments = Array.isArray(data)
            ? data
            : data.documents || [];

        documents = receivedDocuments
            .map(normalizeDocument)
            .filter(item => item.document_id != null);

        if (requestedDocumentId != null) {
            selectedDocumentId = requestedDocumentId;
        }

        let selected = documents.find(
            item =>
                String(item.document_id) === String(selectedDocumentId)
        );

        if (!selected && documents.length > 0) {
            selected = documents.find(
                item => item.processing_status === 'processed'
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

        setDocumentStatus(
            `Could not load documents: ${error.message}`
        );
    }
}

// Upload and process a lecture document
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

        // Must match upload.single('document') in the backend.
        formData.append('document', file);

        isUploading = true;
        uploadButton.disabled = true;
        uploadButton.textContent = 'Uploading...';

        setDocumentStatus(
            'Uploading and processing your document. Please wait...'
        );

        try {
            const response = await fetch(`${API_BASE_URL}/upload`, {
                method: 'POST',
                body: formData
            });

            const data = await readResponse(response);
            const newDocumentId = data.file?.documentId;

            await loadDocuments({
                selectDocumentId: newDocumentId ?? null
            });

            if (newDocumentId != null) {
                const uploadedDocument = documents.find(
                    item =>
                        String(item.document_id) ===
                        String(newDocumentId)
                );

                if (uploadedDocument) {
                    selectDocument(uploadedDocument);
                }
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

// Refresh document list
if (refreshButton) {
    refreshButton.addEventListener('click', () => loadDocuments());
}

// Search documents
if (searchInput) {
    searchInput.addEventListener('input', renderDocuments);
}

// Escape text before formatting generated Markdown
function escapeHTML(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Format Markdown summaries into HTML headings, paragraphs and lists
function formatSummary(markdown) {
    let text = escapeHTML(markdown || '')
        .replace(/\r\n?/g, '\n');

    // Put headings on their own lines when necessary.
    text = text.replace(/[ \t]+(#{1,4}\s+)/g, '\n$1');

    // Separate headings that follow text without a line break.
    text = text.replace(/([.!?])\s+(#{1,4}\s+)/g, '$1\n$2');

    // Remove horizontal Markdown separators.
    text = text.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '');

    const lines = text.split('\n');
    const output = [];

    let paragraph = [];
    let listOpen = false;

    function inlineFormatting(value) {
        return value
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.+?)__/g, '<strong>$1</strong>')
            .replace(/\*(.+?)\*/g, '<em>$1</em>')
            .replace(/`(.+?)`/g, '<code>$1</code>');
    }

    function flushParagraph() {
        if (paragraph.length) {
            output.push(
                `<p>${inlineFormatting(paragraph.join(' '))}</p>`
            );

            paragraph = [];
        }
    }

    function closeList() {
        if (listOpen) {
            output.push('</ul>');
            listOpen = false;
        }
    }

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) {
            flushParagraph();
            closeList();
            continue;
        }

        // Remove Markdown separators.
        if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line)) {
            flushParagraph();
            closeList();
            continue;
        }

        // Convert Markdown headings.
        const heading = line.match(/^(#{1,4})\s+(.+)$/);

        if (heading) {
            flushParagraph();
            closeList();

            const level = heading[1].length;
            const content = heading[2];

            output.push(
                `<h${level}>${inlineFormatting(content)}</h${level}>`
            );

            continue;
        }

        // Convert bullet points.
        const bullet = line.match(/^[-*+]\s+(.+)$/);

        if (bullet) {
            flushParagraph();

            if (!listOpen) {
                output.push('<ul>');
                listOpen = true;
            }

            output.push(
                `<li>${inlineFormatting(bullet[1])}</li>`
            );

            continue;
        }

        closeList();
        paragraph.push(line);
    }

    flushParagraph();
    closeList();

    return output.join('\n');
}

// Generate a summary of the selected document
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
        const response = await fetch(
            `${API_BASE_URL}/ai/summarize`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    documentId: Number(selectedDocumentId)
                })
            }
        );

        const data = await readResponse(response);

        if (
            typeof data.summary !== 'string' ||
            !data.summary.trim()
        ) {
            throw new Error(
                data.error ||
                data.message ||
                'The server returned an empty summary.'
            );
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

        setDocumentStatus(
            `Summary failed: ${error.message}`
        );
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

// Summary button events
if (summaryButton) {
    summaryButton.addEventListener(
        'click',
        generateDocumentSummary
    );
}

if (panelSummaryButton) {
    panelSummaryButton.addEventListener(
        'click',
        generateDocumentSummary
    );
}

// Display chat messages safely
function appendChatMessage(message, sender) {
    if (!chatMessages) return null;

    const messageElement = document.createElement('div');

    messageElement.className =
        `chat-message ${sender === 'user' ? 'user-message' : 'ai-message'}`;

    const paragraph = document.createElement('p');
    paragraph.textContent = message;

    messageElement.appendChild(paragraph);
    chatMessages.appendChild(messageElement);

    chatMessages.scrollTop = chatMessages.scrollHeight;

    return messageElement;
}

// Send a question about the selected document
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
        sendButton.disabled = true;
        sendButton.textContent = 'Sending...';
    }

    appendChatMessage(question, 'user');

    if (chatInput) {
        chatInput.value = '';
    }

    const loadingMessage = appendChatMessage(
        'Reading your notes and preparing an answer...',
        'ai'
    );

    setDocumentStatus('NeuroLearn is answering your question...');

    try {
        const response = await fetch(`${API_BASE_URL}/ai/chat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: Number(selectedDocumentId),
                message: question
            })
        });

        const data = await readResponse(response);

        if (
            typeof data.answer !== 'string' ||
            !data.answer.trim()
        ) {
            throw new Error(
                data.error ||
                data.message ||
                'The server returned an empty answer.'
            );
        }

        if (loadingMessage) {
            loadingMessage.querySelector('p').textContent =
                data.answer;
        }

        setDocumentStatus('Answer received.');
    } catch (error) {
        console.error('Chat request failed:', error);

        if (loadingMessage) {
            loadingMessage.querySelector('p').textContent =
                `Sorry, I could not answer that: ${error.message}`;
        }

        setDocumentStatus(`Chat failed: ${error.message}`);
    } finally {
        isSendingMessage = false;

        if (sendButton) {
            sendButton.disabled = false;
            sendButton.textContent = 'Send';
        }

        if (chatMessages) {
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        chatInput?.focus();
    }
}

// Connect the chat form
if (chatForm) {
    chatForm.addEventListener('submit', async event => {
        event.preventDefault();

        if (!chatInput) return;

        await sendChatMessage(chatInput.value);
    });
}

// Connect suggested question prompts
document.querySelectorAll('.suggested-prompts [data-prompt]')
    .forEach(button => {
        button.addEventListener('click', async () => {
            const prompt = button.dataset.prompt;

            if (prompt) {
                await sendChatMessage(prompt);
            }
        });
    });

// Render the generated quiz with selectable answers
function renderQuiz(questions) {
    if (!quizResult) return;

    quizResult.replaceChildren();

    if (!Array.isArray(questions) || questions.length === 0) {
        const message = document.createElement('p');
        message.textContent = 'No quiz questions were returned.';

        quizResult.appendChild(message);
        return;
    }

    const form = document.createElement('form');
    form.id = 'generated-quiz-form';

    const heading = document.createElement('h3');
    heading.textContent = 'Test Your Understanding';

    const instruction = document.createElement('p');
    instruction.textContent =
        'Choose one answer for each question, then submit your answers to see your score and explanations.';

    form.append(heading, instruction);

    questions.forEach((question, questionIndex) => {
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'quiz-question';

        const legend = document.createElement('legend');
        legend.textContent =
            `${questionIndex + 1}. ${question.question}`;

        fieldset.appendChild(legend);

        question.options.forEach(option => {
            const label = document.createElement('label');
            label.className = 'quiz-option';

            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `question-${questionIndex}`;
            input.value = option;
            input.required = true;

            const optionText = document.createElement('span');
            optionText.textContent = option;

            label.append(input, optionText);
            fieldset.appendChild(label);
        });

        form.appendChild(fieldset);
    });

    const submitButton = document.createElement('button');
    submitButton.type = 'submit';
    submitButton.className = 'quiz-submit-button';
    submitButton.textContent = 'Submit Answers';

    form.appendChild(submitButton);
    quizResult.appendChild(form);

    form.addEventListener('submit', event => {
        event.preventDefault();

        const formData = new FormData(form);
        let score = 0;

        const reviewContainer = document.createElement('div');
        reviewContainer.className = 'quiz-review-container';

        questions.forEach((question, questionIndex) => {
            const selectedAnswer = formData.get(
                `question-${questionIndex}`
            );

            const isCorrect =
                selectedAnswer === question.correctAnswer;

            if (isCorrect) {
                score++;
            }

            const review = document.createElement('div');
            review.className = 'quiz-review';

            const title = document.createElement('h4');
            title.textContent =
                `${questionIndex + 1}. ${isCorrect ? 'Correct' : 'Review your answer'}`;

            const yourAnswer = document.createElement('p');
            yourAnswer.textContent =
                `Your answer: ${selectedAnswer || 'No answer'}`;

            const correctAnswer = document.createElement('p');
            correctAnswer.textContent =
                `Correct answer: ${question.correctAnswer}`;

            const explanation = document.createElement('p');
            explanation.textContent =
                `Explanation: ${question.explanation}`;

            review.append(
                title,
                yourAnswer,
                correctAnswer,
                explanation
            );

            reviewContainer.appendChild(review);
        });

        const resultHeading = document.createElement('h3');
        resultHeading.textContent =
            `Your score: ${score} / ${questions.length}`;

        const percentage = Math.round(
            (score / questions.length) * 100
        );

        const resultText = document.createElement('p');
        resultText.textContent = `You scored ${percentage}%.`;

        form.replaceChildren(
            resultHeading,
            resultText,
            reviewContainer
        );

        setDocumentStatus(
            `Quiz completed. Score: ${score}/${questions.length}.`
        );
    });
}

// Generate a quiz from the selected document
async function generateDocumentQuiz() {
    if (isGeneratingQuiz) return;

    const selected = requireSelectedDocument();

    if (!selected) return;

    const questionCount = Number(
        questionCountInput?.value || 5
    );

    if (
        !Number.isInteger(questionCount) ||
        questionCount < 1 ||
        questionCount > 10
    ) {
        setDocumentStatus(
            'Choose between 1 and 10 quiz questions.'
        );
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

        const message = document.createElement('p');
        message.textContent =
            `Generating ${questionCount} questions from "${selected.filename}". Please wait...`;

        quizResult.appendChild(message);
    }

    setDocumentStatus('NeuroLearn is generating your quiz...');

    try {
        const response = await fetch(`${API_BASE_URL}/ai/quiz`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: Number(selectedDocumentId),
                questionCount
            })
        });

        const data = await readResponse(response);

        if (
            !Array.isArray(data.questions) ||
            data.questions.length !== questionCount
        ) {
            throw new Error(
                data.error ||
                'The server returned an invalid quiz.'
            );
        }

        renderQuiz(data.questions);

        setDocumentStatus('Quiz generated successfully.');
    } catch (error) {
        console.error('Quiz generation failed:', error);

        if (quizResult) {
            quizResult.replaceChildren();

            const message = document.createElement('p');
            message.textContent =
                `Could not generate quiz: ${error.message}`;

            quizResult.appendChild(message);
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

// Quiz button events
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

// Switch between Summary, Quiz and Notes tabs
document.querySelectorAll('.study-tab').forEach(button => {
    button.addEventListener('click', () => {
        const selectedTab = button.dataset.tab;

        document.querySelectorAll('.study-tab').forEach(tab => {
            tab.classList.toggle('active', tab === button);
        });

        document.querySelectorAll('.tab-content').forEach(panel => {
            const isSelected =
                panel.id === `${selectedTab}-tab`;

            panel.hidden = !isSelected;
            panel.classList.toggle('active', isSelected);
        });
    });
});

// Initialize the workspace
if (learner) {
    loadDocuments();
}