
const API_BASE_URL = 'http://localhost:5000/api';

const storedLearner = sessionStorage.getItem('neurolearnLearner');

let learner = null;

if (!storedLearner) {
    window.location.replace('login_signup.html');
} else {
    try {
        learner = JSON.parse(storedLearner);

        const learnerName = document.getElementById('learner-name');

        if (learnerName && learner.username) {
            learnerName.textContent = learner.username;
        }
    } catch (error) {
        console.error('Could not load learner information:', error);

        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    }
}

const logoutButton = document.getElementById('logout-button');

if (logoutButton) {
    logoutButton.addEventListener('click', function () {
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    });
}

const fileInput = document.getElementById('document-file');
const uploadButton = document.getElementById('upload-document');
const documentStatus = document.getElementById('document-status');
const documentSelect = document.getElementById('document-select');
const summaryButton = document.getElementById('generate-summary');
const quizButton = document.getElementById('generate-quiz');
const aiResults = document.getElementById('ai-results');

function showStatus(message) {
    if (documentStatus) {
        documentStatus.textContent = message;
    }
}

function showResult(title, content) {
    if (!aiResults) return;

    aiResults.replaceChildren();

    const heading = document.createElement('h3');
    heading.textContent = title;

    const resultText = document.createElement('pre');
    resultText.style.whiteSpace = 'pre-wrap';
    resultText.textContent =
        typeof content === 'string'
            ? content
            : JSON.stringify(content, null, 2);

    aiResults.append(heading, resultText);
}

async function readResponse(response) {
    const data = await response.json();

    if (!response.ok) {
        throw new Error(data.message || data.error || 'The request failed.');
    }

    return data;
}

if (uploadButton && fileInput) {
    uploadButton.addEventListener('click', async function () {
        const file = fileInput.files[0];

        if (!file) {
            showStatus('Please select a PDF, Word, or PowerPoint file first.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        uploadButton.disabled = true;
        showStatus('Uploading and processing your document...');

        try {
            const response = await fetch(`${API_BASE_URL}/upload`, {
                method: 'POST',
                body: formData
            });

            const data = await readResponse(response);

            showStatus(
                data.message || 'Document uploaded successfully.'
            );

            await loadDocuments();
        } catch (error) {
            console.error('Document upload failed:', error);
            showStatus(`Upload failed: ${error.message}`);
        } finally {
            uploadButton.disabled = false;
        }
    });
}

async function loadDocuments() {
    if (!documentSelect) return;

    try {
        const response = await fetch(`${API_BASE_URL}/upload`);
        const data = await readResponse(response);

        const documents = Array.isArray(data)
            ? data
            : data.documents || [];

        documentSelect.replaceChildren();

        const defaultOption = document.createElement('option');
        defaultOption.value = '';
        defaultOption.textContent = documents.length
            ? 'Choose a document'
            : 'No documents found';

        documentSelect.appendChild(defaultOption);

        documents.forEach(function (document) {
            const option = document.createElement('option');
            option.value = document.document_id ?? document.documentId;

            const filename = document.filename || 'Untitled document';
            const status = document.processing_status || 'unknown';

            option.textContent = `${filename} (${status})`;
            option.dataset.status = status;

            documentSelect.appendChild(option);
        });
    } catch (error) {
        console.error('Could not load documents:', error);
    }
}

async function requestAI(endpoint, body, title) {
    const documentId = documentSelect?.value;

    if (!documentId) {
        showStatus('Please select a document first.');
        return;
    }

    const selectedOption = documentSelect.selectedOptions[0];

    if (
        selectedOption?.dataset.status &&
        selectedOption.dataset.status !== 'processed'
    ) {
        showStatus('This document is not processed yet. Please wait.');
        return;
    }

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

        showResult(
            title,
            data.summary ?? data.quiz ?? data.questions ?? data
        );

        showStatus(`${title} generated successfully.`);
    } catch (error) {
        console.error(`${title} failed:`, error);
        showStatus(`${title} failed: ${error.message}`);
    }
}

if (summaryButton) {
    summaryButton.addEventListener('click', function () {
        requestAI('summarize', {}, 'Document Summary');
    });
}

if (quizButton) {
    quizButton.addEventListener('click', function () {
        requestAI('quiz', { questionCount: 5 }, 'Practice Quiz');
    });
}

if (learner) {
    loadDocuments();
}
