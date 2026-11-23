'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
require('../../frontend/loading-spinner');

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...values) { values.forEach(value => this.values.add(value)); }
    remove(...values) { values.forEach(value => this.values.delete(value)); }
    contains(value) { return this.values.has(value); }
}

class FakeElement {
    constructor(ownerDocument) {
        this.ownerDocument = ownerDocument;
        this.childNodes = [];
        this.attributes = new Map();
        this.classList = new FakeClassList();
        this.hidden = true;
        this.disabled = false;
        this._textContent = '';
    }
    append(...nodes) { this.childNodes.push(...nodes); }
    replaceChildren(...nodes) { this.childNodes = nodes; this._textContent = ''; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
    removeAttribute(name) { this.attributes.delete(name); }
    set textContent(value) { this._textContent = String(value); this.childNodes = []; }
    get textContent() { return this._textContent + this.childNodes.map(node => node.textContent || '').join(''); }
}

const fakeDocument = {
    createElement() { return new FakeElement(fakeDocument); }
};

test('shared section indicator shows an accessible spinner and clears it for success or failure messages', () => {
    for (const [state, message] of [['success', 'Upload complete.'], ['failure', 'Upload failed.']]) {
        const element = new FakeElement(fakeDocument);
        element.textContent = 'Old message';
        NeuroLearnLoading.showIndicator(element, 'Uploading document');
        assert.equal(element.hidden, false);
        assert.equal(element.getAttribute('role'), 'status');
        assert.equal(element.getAttribute('aria-label'), 'Uploading document');
        assert.equal(element.getAttribute('aria-busy'), 'true');
        assert.equal(element.childNodes[0].childNodes[0].className, 'nl-spinner');

        NeuroLearnLoading.showMessage(element, message);
        assert.equal(element.textContent, message);
        assert.equal(element.getAttribute('aria-busy'), 'false');
        assert.equal(element.classList.contains('nl-loading-indicator'), false);
        assert.equal(state === 'success' ? element.textContent.includes('complete') : element.textContent.includes('failed'), true);
    }
});

test('shared button spinner disables during work and restores original content and disabled state afterward', () => {
    const button = new FakeElement(fakeDocument);
    const originalLabel = new FakeElement(fakeDocument);
    originalLabel.textContent = 'Submit';
    button.append(originalLabel);

    NeuroLearnLoading.setButtonLoading(button, true, 'Submitting');
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('aria-busy'), 'true');
    assert.equal(button.childNodes[0].childNodes[0].className, 'nl-spinner nl-spinner--small');

    NeuroLearnLoading.setButtonLoading(button, false);
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('aria-busy'), null);
    assert.equal(button.childNodes[0], originalLabel);
    assert.equal(button.textContent, 'Submit');
});

test('shared spinner honors reduced-motion preferences and is linked on every application page', () => {
    const css = fs.readFileSync(path.join(__dirname, '../../frontend/loading-spinner.css'), 'utf8');
    assert.match(css, /prefers-reduced-motion:\s*reduce/);
    assert.match(css, /animation:\s*none/);
    for (const page of ['index.html', 'login_signup.html', 'dashboard.html', 'admin.html', 'study.html']) {
        const html = fs.readFileSync(path.join(__dirname, '../../frontend', page), 'utf8');
        assert.match(html, /loading-spinner\.css/, page);
    }
});
