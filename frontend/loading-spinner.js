'use strict';

(function initializeNeuroLearnLoading(root) {
    const buttonStates = new WeakMap();

    function spinner(document, label, small = false) {
        const wrapper = document.createElement('span');
        wrapper.className = 'nl-button-spinner-content';
        const icon = document.createElement('span');
        icon.className = small ? 'nl-spinner nl-spinner--small' : 'nl-spinner';
        icon.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.className = 'nl-sr-only';
        text.textContent = label;
        wrapper.append(icon, text);
        return wrapper;
    }

    function showIndicator(element, label = 'Loading') {
        if (!element) return;
        element.replaceChildren(spinner(element.ownerDocument || root.document, label));
        element.hidden = false;
        element.classList?.add('nl-loading-indicator', 'nl-loading-indicator--section');
        element.setAttribute('role', 'status');
        element.setAttribute('aria-label', label);
        element.setAttribute('aria-busy', 'true');
    }

    function showMessage(element, message) {
        if (!element) return;
        element.textContent = message;
        element.classList?.remove('nl-loading-indicator', 'nl-loading-indicator--section');
        element.removeAttribute('aria-label');
        element.setAttribute('aria-busy', 'false');
    }

    function setButtonLoading(button, active, label = 'Loading') {
        if (!button) return;
        if (active) {
            if (buttonStates.has(button)) return;
            buttonStates.set(button, {
                children: Array.from(button.childNodes),
                disabled: button.disabled,
                ariaBusy: button.getAttribute('aria-busy')
            });
            const content = spinner(button.ownerDocument || root.document, label, true);
            button.replaceChildren(content);
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            return;
        }
        const state = buttonStates.get(button);
        if (!state) return;
        button.replaceChildren(...state.children);
        button.disabled = state.disabled;
        if (state.ariaBusy === null) button.removeAttribute('aria-busy');
        else button.setAttribute('aria-busy', state.ariaBusy);
        buttonStates.delete(button);
    }

    root.NeuroLearnLoading = Object.freeze({ setButtonLoading, showIndicator, showMessage });
})(typeof window === 'undefined' ? globalThis : window);
