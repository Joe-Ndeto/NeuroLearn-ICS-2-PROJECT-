
const API_BASE_URL = 'http://localhost:5000/api';

const storedLearner = sessionStorage.getItem('neurolearnLearner');
let learner = null;

if (!storedLearner) {
    window.location.replace('login_signup.html');
} else {
    try {
        learner = JSON.parse(storedLearner);

        const learnerName = window.document.getElementById('learner-name');

        if (learnerName && learner.username) {
            learnerName.textContent = learner.username;
        }
    } catch (error) {
        console.error('Could not load learner information:', error);
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    }
}

// Logout
const logoutButton = window.document.getElementById('logout-button');

if (logoutButton) {
    logoutButton.addEventListener('click', function () {
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    });
}

// Dashboard elements
const fileInput = window.document.getElementById('document-file');
const uploadButton = window.document.getElementById('upload-document');
const documentStatus = window.document.getElementById('document-status');
const documentSelect = window.document.getElementById('document-select');
const summaryButton = window.document.getElementById('generate-summary');
const quizButton = window.document.getElementById('generate-quiz');
const aiResults = window.document.getElementById('ai-results');

function showStatus(message) {
    if (documentStatus) {
        documentStatus.textContent = message;
    }
}

function showResult(title, content) {
    if (!aiResults) return;

    aiResults.replaceChildren();

    const heading = window.document.createElement('h3');
    heading.textContent = title;

    const resultText = window.document.createElement('pre');
    resultText.style.whiteSpace = 'pre-wrap';
    resultText.style.overflowWrap = 'anywhere';

    resultText.textContent = typeof content === 'string'
        ? content
        : JSON.stringify(content, null, 2);

    aiResults.append(heading, resultText);
}

async function readResponse(response) {
    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error('The server returned an invalid response.');
    }

    if (!response.ok) {
        throw new Error(
            data.message || data.error || `Request failed (${response.status}).`
        );
    }

    return data;
}

// Upload a document
if (uploadButton && fileInput) {
    uploadButton.addEventListener('click', async function () {
        const file = fileInput.files[0];

        if (!file) {
            showStatus('Please select a PDF, Word, or PowerPoint file first.');
            return;
        }

        const formData = new FormData();

        // Must match upload.single('document') in the backend.
        formData.append('document', file);

        uploadButton.disabled = true;
        showStatus('Uploading and processing your document...');

        try {
            const response = await fetch(`${API_BASE_URL}/upload`, {
                method: 'POST',
                body: formData
            });

            const data = await readResponse(response);

            showStatus(data.message || 'Document uploaded successfully.');

            // Refresh the dropdown and select the newly uploaded document.
            const newDocumentId = data.file?.documentId;

            await loadDocuments(newDocumentId);

            fileInput.value = '';
        } catch (error) {
            console.error('Document upload failed:', error);
            showStatus(`Upload failed: ${error.message}`);
        } finally {
            uploadButton.disabled = false;
        }
    });
}

// Load documents from MySQL through the backend.
async function loadDocuments(selectDocumentId = null) {
    if (!documentSelect) return;

    // Keep the previous selection if no new document ID was supplied.
    const previousSelection = documentSelect.value;

    try {
        const response = await fetch(`${API_BASE_URL}/upload`);
        const data = await readResponse(response);

        const documents = Array.isArray(data)
            ? data
            : data.documents || [];

        documentSelect.replaceChildren();

        const defaultOption = window.document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = documents.length
            ? 'Choose a document'
            : 'No documents found';

        documentSelect.appendChild(defaultOption);

        documents.forEach(function (item) {
            // Use "item", not "document", to avoid shadowing
            // the browser's built-in document object.
            const option = window.document.createElement('option');

            const id = item.document_id ?? item.documentId;
            const filename = item.filename || item.originalName || 'Untitled document';
            const status = item.processing_status
                || item.processingStatus
                || 'unknown';

            option.value = String(id);
            option.textContent = `${filename} (${status})`;
            option.dataset.status = status;

            documentSelect.appendChild(option);
        });

        const desiredSelection = selectDocumentId != null
            ? String(selectDocumentId)
            : previousSelection;

        if (
            desiredSelection &&
            Array.from(documentSelect.options).some(
                option => option.value === desiredSelection
            )
        ) {
            documentSelect.value = desiredSelection;
        }
    } catch (error) {
        console.error('Could not load documents:', error);
        showStatus(`Could not load documents: ${error.message}`);
    }
}

// Generate a summary or quiz using the selected processed document.
async function requestAI(endpoint, body, title) {
    const documentId = documentSelect?.value;

    if (!documentId) {
        showStatus('Please select a document first.');
        return;
    }

    const selectedOption = documentSelect.selectedOptions[0];
    const status = selectedOption?.dataset.status;

    if (status !== 'processed') {
        showStatus('This document is not processed yet. Please select a processed document.');
        return;
    }

    const button = endpoint === 'summarize' ? summaryButton : quizButton;

    if (button) button.disabled = true;

    showStatus(`${title} is being generated...`);

    try {
        const response = await fetch(`${API_BASE_URL}/ai/${endpoint}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: Number(documentId),
                ...body
            })
        });

        const data = await readResponse(response);

        const result = data.summary
            ?? data.quiz
            ?? data.questions
            ?? data;

        showResult(title, result);
        showStatus(`${title} generated successfully.`);
    } catch (error) {
        console.error(`${title} failed:`, error);
        showStatus(`${title} failed: ${error.message}`);
    } finally {
        if (button) button.disabled = false;
    }
}

// Summary button
if (summaryButton) {
    summaryButton.addEventListener('click', function () {
        requestAI('summarize', {}, 'Document Summary');
    });
}

// Quiz button
if (quizButton) {
    quizButton.addEventListener('click', function () {
        requestAI('quiz', { questionCount: 5 }, 'Practice Quiz');
    });
}

// Initial load
if (learner) {
    loadDocuments();
}
