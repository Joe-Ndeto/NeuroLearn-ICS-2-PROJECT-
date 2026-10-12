
const API_BASE_URL = 'http://localhost:5000/api';

const storedLearner = sessionStorage.getItem('neurolearnLearner');
let learner = null;

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

const summaryButton = document.getElementById('summary-button');
const panelSummaryButton = document.getElementById('panel-summary-button');
const summaryResult = document.getElementById('summary-result');

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
    if (documentStatus) {
        documentStatus.textContent = message;
    }
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
            data.message ||
            data.error ||
            `Request failed (${response.status}).`
        );
    }

    return data;
}

// Display uploaded documents.
function renderDocuments() {
    if (!documentList) return;

    const searchTerm = searchInput?.value.trim().toLowerCase() || '';

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

    if (item.processing_status !== 'processed') {
        setDocumentStatus(
            'This document is not processed yet. Please select a processed document.'
        );
    } else {
        setDocumentStatus(`Selected: ${item.filename}`);
    }
}

// Load document records from MySQL through the backend.
async function loadDocuments(options = {}) {
    const { selectDocumentId = null } = options;

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

        if (selectDocumentId != null) {
            selectedDocumentId = selectDocumentId;
        }

        let selected = documents.find(
            item => String(item.document_id) === String(selectedDocumentId)
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
        setDocumentStatus(`Could not load documents: ${error.message}`);
    }
}

// Upload a new document and select it after processing.
if (uploadButton && fileInput) {
    uploadButton.addEventListener('click', async () => {
        const file = fileInput.files[0];

        if (!file) {
            setDocumentStatus('Please choose a PDF, DOCX, or PPTX file first.');
            return;
        }

        const extension = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();

        if (!['.pdf', '.docx', '.pptx'].includes(extension)) {
            setDocumentStatus('Only PDF, DOCX and PPTX files are supported.');
            return;
        }

        if (file.size > 10 * 1024 * 1024) {
            setDocumentStatus('The file must not exceed 10 MB.');
            return;
        }

        const formData = new FormData();

        // Matches upload.single('document') in the Express backend.
        formData.append('document', file);

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

            if (newDocumentId) {
                const uploadedDocument = documents.find(
                    item => String(item.document_id) === String(newDocumentId)
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

// Generate a summary from the currently selected document.
async function generateDocumentSummary() {
    if (!selectedDocumentId) {
        setDocumentStatus('Please select a document first.');
        return;
    }

    const selected = documents.find(
        item => String(item.document_id) === String(selectedDocumentId)
    );

    if (!selected || selected.processing_status !== 'processed') {
        setDocumentStatus('Please select a processed document.');
        return;
    }

    const buttons = [summaryButton, panelSummaryButton].filter(Boolean);

    buttons.forEach(button => {
        button.disabled = true;
        button.textContent = 'Generating...';
    });

    if (summaryResult) {
        summaryResult.textContent =
            'NeuroLearn is reading your notes and generating a summary...';
    }

    setDocumentStatus('Generating summary with Gemini...');

    try {
        const response = await fetch(`${API_BASE_URL}/ai/summarize`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                documentId: Number(selectedDocumentId)
            })
        });

        const data = await readResponse(response);

        if (!data.summary) {
            throw new Error('The server did not return a summary.');
        }

        if (summaryResult) {
            summaryResult.textContent = data.summary;
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
    panelSummaryButton.addEventListener('click', generateDocumentSummary);
}

// Switch between Summary, Quiz and Notes tabs.
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

// Initial load.
if (learner) {
    loadDocuments();
}
