
const API_BASE_URL = 'http://localhost:5000/api';

const storedLearner = sessionStorage.getItem('neurolearnLearner');

if (!storedLearner) {
    window.location.replace('login_signup.html');
}

let learner = null;

try {
    learner = JSON.parse(storedLearner || 'null');

    if (!learner) {
        window.location.replace('login_signup.html');
    }
} catch (error) {
    sessionStorage.removeItem('neurolearnLearner');
    window.location.replace('login_signup.html');
}

const learnerName = document.getElementById('learner-name');
const logoutButton = document.getElementById('logout-button');
const fileInput = document.getElementById('document-file');
const uploadButton = document.getElementById('upload-document');
const refreshButton = document.getElementById('refresh-documents');
const searchInput = document.getElementById('document-search');
const documentList = document.getElementById('document-list');
const documentStatus = document.getElementById('document-status');
const selectedDocumentName = document.getElementById('selected-document-name');
const selectedDocumentStatus = document.getElementById('selected-document-status');

let documents = [];
let selectedDocumentId = null;

if (learnerName && learner?.username) {
    learnerName.textContent = learner.username;
}

if (logoutButton) {
    logoutButton.addEventListener('click', () => {
        sessionStorage.removeItem('neurolearnLearner');
        window.location.replace('login_signup.html');
    });
}

function setDocumentStatus(message) {
    documentStatus.textContent = message;
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

function renderDocuments() {
    const searchTerm = searchInput.value.trim().toLowerCase();

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

        if (String(item.document_id) === String(selectedDocumentId)) {
            button.classList.add('selected');
        }

        const icon = document.createElement('span');
        icon.className = 'file-icon';
        icon.textContent = item.file_type.toUpperCase();

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

function selectDocument(item) {
    selectedDocumentId = item.document_id;

    selectedDocumentName.textContent = item.filename;
    selectedDocumentStatus.textContent =
        `Document ID: ${item.document_id} · Status: ${item.processing_status}`;

    renderDocuments();

    if (item.processing_status !== 'processed') {
        setDocumentStatus(
            'This document is not processed yet. Select a processed document to use AI features.'
        );
    } else {
        setDocumentStatus(`Selected: ${item.filename}`);
    }
}

async function loadDocuments() {
    setDocumentStatus('Loading your documents...');

    try {
        const response = await fetch(`${API_BASE_URL}/upload`);
        const data = await readResponse(response);

        documents = (Array.isArray(data) ? data : data.documents || [])
            .map(item => ({
                ...item,
                document_id: item.document_id ?? item.documentId,
                filename: item.filename || item.originalName || 'Untitled document',
                file_type: item.file_type || item.type || 'file',
                processing_status:
                    item.processing_status || item.processingStatus || 'unknown'
            }));

        if (
            selectedDocumentId &&
            !documents.some(
                item => String(item.document_id) === String(selectedDocumentId)
            )
        ) {
            selectedDocumentId = null;
        }

        if (selectedDocumentId) {
            const selected = documents.find(
                item => String(item.document_id) === String(selectedDocumentId)
            );

            if (selected) {
                selectedDocumentName.textContent = selected.filename;
                selectedDocumentStatus.textContent =
                    `Document ID: ${selected.document_id} · Status: ${selected.processing_status}`;
            }
        }

        renderDocuments();
        setDocumentStatus(`${documents.length} document(s) loaded.`);
    } catch (error) {
        console.error('Document loading failed:', error);
        setDocumentStatus(`Could not load documents: ${error.message}`);
    }
}

uploadButton.addEventListener('click', async () => {
    const file = fileInput.files[0];

    if (!file) {
        setDocumentStatus('Choose a PDF, DOCX, or PPTX file first.');
        return;
    }

    const formData = new FormData();
    formData.append('document', file);

    uploadButton.disabled = true;
    setDocumentStatus('Uploading and processing your document...');

    try {
        const response = await fetch(`${API_BASE_URL}/upload`, {
            method: 'POST',
            body: formData
        });

        const data = await readResponse(response);

        await loadDocuments();

        const newId = data.file?.documentId;

        if (newId) {
            const uploadedDocument = documents.find(
                item => String(item.document_id) === String(newId)
            );

            if (uploadedDocument) {
                selectDocument(uploadedDocument);
            }
        }

        fileInput.value = '';
        setDocumentStatus(data.message || 'Upload completed.');
    } catch (error) {
        console.error('Document upload failed:', error);
        setDocumentStatus(`Upload failed: ${error.message}`);
    } finally {
        uploadButton.disabled = false;
    }
});

refreshButton.addEventListener('click', loadDocuments);
searchInput.addEventListener('input', renderDocuments);

// Switch between Summary, Quiz, and Notes tabs.
document.querySelectorAll('.study-tab').forEach(button => {
    button.addEventListener('click', () => {
        document.querySelectorAll('.study-tab').forEach(tab => {
            tab.classList.toggle('active', tab === button);
        });

        document.querySelectorAll('.tab-content').forEach(panel => {
            const isSelected = panel.id === `${button.dataset.tab}-tab`;
            panel.hidden = !isSelected;
            panel.classList.toggle('active', isSelected);
        });
    });
});

loadDocuments();
