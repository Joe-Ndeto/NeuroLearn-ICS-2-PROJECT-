
'use strict';

(() => {
    const api = window.NeuroLearnApi;
    const roleRouting = window.NeuroLearnRoleRouting;

    const GOOGLE_CLIENT_ID =
        '1019813293146-e10qgtk8iubmr79gamtq773acu37hie4.apps.googleusercontent.com';

    const elements = {
        header: document.getElementById('student-header'),
        content: document.getElementById('profile-content'),
        sessionMessage: document.getElementById('profile-session-message'),
        logoutButton: document.getElementById('logout-button'),
        error: document.getElementById('profile-error'),

        avatar: document.getElementById('profile-avatar'),
        username: document.getElementById('profile-username'),
        email: document.getElementById('profile-email'),
        role: document.getElementById('profile-role'),

        detailUsername: document.getElementById('detail-username'),
        detailEmail: document.getElementById('detail-email'),
        detailLearnerId: document.getElementById('detail-learner-id'),
        detailRole: document.getElementById('detail-role'),

        profileForm: document.getElementById('profile-edit-form'),
        editUsername: document.getElementById('edit-username'),
        editEmail: document.getElementById('edit-email'),
        profileMessage: document.getElementById('profile-update-message'),

        passwordForm: document.getElementById('password-change-form'),
        currentPasswordGroup: document.getElementById('current-password-group'),
        currentPassword: document.getElementById('current-password'),
        newPassword: document.getElementById('new-password'),
        confirmPassword: document.getElementById('confirm-password'),
        passwordButton: document.getElementById('password-submit-button'),
        googleReauth: document.getElementById('google-password-reauth'),
        googleButton: document.getElementById('google-password-button'),
        passwordMessage: document.getElementById('password-update-message')
    };

    let googlePasswordSetup = false;
    let passwordStatus = null;
    let passwordRequestInProgress = false;

    function getInitials(username) {
        const words = String(username || '')
            .trim()
            .split(/\s+/)
            .filter(Boolean);

        if (words.length === 0) return 'NL';

        return words
            .slice(0, 2)
            .map(word => word.charAt(0).toUpperCase())
            .join('');
    }

    function showError(message) {
        elements.error.textContent = message;
        elements.error.hidden = false;
    }

    function showMessage(element, message, success) {
        element.textContent = message;
        element.hidden = false;
        element.classList.toggle('success-message', success);
        element.classList.toggle('error-message', !success);
    }

    function renderProfile(learner) {
        const username = String(learner.username || 'Learner');
        const email = String(learner.email || 'Not available');
        const role = String(learner.role || 'student');

        elements.avatar.textContent = getInitials(username);
        elements.username.textContent = username;
        elements.email.textContent = email;
        elements.role.textContent = role;

        elements.detailUsername.textContent = username;
        elements.detailEmail.textContent = email;
        elements.detailLearnerId.textContent =
            String(learner.learner_id ?? 'Not available');
        elements.detailRole.textContent = role;

        elements.editUsername.value = username;
        elements.editEmail.value = email;
    }

    async function loadProfile() {
        const response = await api.get('/auth/me');

        if (
            !response?.success ||
            !response.learner ||
            typeof response.learner !== 'object'
        ) {
            throw new Error(
                'Unable to retrieve your account information.'
            );
        }

        renderProfile(response.learner);
    }

    async function loadPasswordStatus() {
        const response = await api.get('/auth/password-status');

        if (
            !response?.success ||
            typeof response.hasPassword !== 'boolean' ||
            typeof response.googleLinked !== 'boolean'
        ) {
            throw new Error('Unable to determine your password settings.');
        }

        passwordStatus = response;

        if (response.hasPassword) {
            showExistingPasswordForm();
        } else if (response.googleLinked) {
            showGooglePasswordForm();
        } else {
            throw new Error(
                'Your account has no password or linked Google account. Please contact support.'
            );
        }
    }

    function showExistingPasswordForm() {
        elements.currentPasswordGroup.hidden = false;
        elements.currentPassword.required = true;

        elements.passwordButton.hidden = false;
        elements.passwordButton.textContent = 'Change Password';

        elements.googleReauth.hidden = true;
    }

    function showGooglePasswordForm() {
        elements.currentPasswordGroup.hidden = true;
        elements.currentPassword.required = false;
        elements.currentPassword.value = '';

        elements.passwordButton.hidden = true;
        elements.googleReauth.hidden = false;

        initializeGooglePasswordButton();
    }

    function initializeGooglePasswordButton() {
        if (googlePasswordSetup) return;

        if (!window.google?.accounts?.id) {
            showMessage(
                elements.passwordMessage,
                'Google Sign-In is still loading. Please refresh the page and try again.',
                false
            );
            return;
        }

        window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleGooglePasswordCredential
        });

        window.google.accounts.id.renderButton(
            elements.googleButton,
            {
                theme: 'outline',
                size: 'large',
                text: 'continue_with',
                shape: 'rectangular',
                width: 280
            }
        );

        googlePasswordSetup = true;
    }

    function validateNewPassword() {
        const newPassword = elements.newPassword.value;
        const confirmPassword = elements.confirmPassword.value;

        if (newPassword.length < 8) {
            showMessage(
                elements.passwordMessage,
                'Your new password must contain at least 8 characters.',
                false
            );
            return false;
        }

        if (newPassword !== confirmPassword) {
            showMessage(
                elements.passwordMessage,
                'Your new password and confirmation do not match.',
                false
            );
            return false;
        }

        return true;
    }

    async function handleProfileUpdate(event) {
        event.preventDefault();

        elements.profileMessage.hidden = true;

        const username = elements.editUsername.value.trim();
        const email = elements.editEmail.value.trim();

        if (!username || !email) {
            showMessage(
                elements.profileMessage,
                'Username and email are required.',
                false
            );
            return;
        }

        const button = elements.profileForm.querySelector(
            'button[type="submit"]'
        );

        button.disabled = true;
        button.textContent = 'Saving...';

        try {
            const response = await api.patch('/auth/profile', {
                username,
                email
            });

            if (!response?.success || !response.learner) {
                throw new Error(
                    response?.message || 'Profile update failed.'
                );
            }

            renderProfile(response.learner);

            showMessage(
                elements.profileMessage,
                response.message || 'Profile updated successfully.',
                true
            );

        } catch (error) {
            console.error('Profile update error:', error);

            showMessage(
                elements.profileMessage,
                error.message || 'Unable to update your profile.',
                false
            );

        } finally {
            button.disabled = false;
            button.textContent = 'Save Changes';
        }
    }

    async function handlePasswordChange(event) {
        event.preventDefault();

        elements.passwordMessage.hidden = true;

        if (!passwordStatus?.hasPassword) {
            return;
        }

        const currentPassword = elements.currentPassword.value;
        const newPassword = elements.newPassword.value;

        if (!validateNewPassword()) return;

        if (!currentPassword) {
            showMessage(
                elements.passwordMessage,
                'Please enter your current password.',
                false
            );
            return;
        }

        if (currentPassword === newPassword) {
            showMessage(
                elements.passwordMessage,
                'Your new password must be different from your current password.',
                false
            );
            return;
        }

        elements.passwordButton.disabled = true;
        elements.passwordButton.textContent = 'Changing...';

        try {
            const response = await api.patch('/auth/password', {
                currentPassword,
                newPassword
            });

            if (!response?.success) {
                throw new Error(
                    response?.message || 'Password change failed.'
                );
            }

            elements.passwordForm.reset();

            showMessage(
                elements.passwordMessage,
                response.message || 'Password changed successfully.',
                true
            );

        } catch (error) {
            console.error('Password change error:', error);

            showMessage(
                elements.passwordMessage,
                error.message || 'Unable to change your password.',
                false
            );

        } finally {
            elements.passwordButton.disabled = false;
            elements.passwordButton.textContent = 'Change Password';
        }
    }

    async function handleGooglePasswordCredential(response) {
        if (passwordRequestInProgress) return;

        elements.passwordMessage.hidden = true;

        if (!response?.credential) {
            showMessage(
                elements.passwordMessage,
                'Google verification failed. Please try again.',
                false
            );
            return;
        }

        if (!validateNewPassword()) return;

        passwordRequestInProgress = true;

        try {
            const result = await api.patch('/auth/password', {
                googleCredential: response.credential,
                newPassword: elements.newPassword.value
            });

            if (!result?.success) {
                throw new Error(
                    result?.message || 'Unable to set your password.'
                );
            }

            elements.passwordForm.reset();

            passwordStatus = {
                ...passwordStatus,
                hasPassword: true
            };

            showExistingPasswordForm();

            showMessage(
                elements.passwordMessage,
                'Google account verified. Your password has been set successfully. You can now use your email and password to sign in.',
                true
            );

        } catch (error) {
            console.error('Google password setup error:', error);

            showMessage(
                elements.passwordMessage,
                error.message || 'Unable to set your password.',
                false
            );

        } finally {
            passwordRequestInProgress = false;
        }
    }

    async function initializeProfilePage() {
        try {
            if (!api || !roleRouting) {
                throw new Error(
                    'The NeuroLearn application could not be initialized.'
                );
            }

            const result = await roleRouting.validateAndRoute({
                api,
                location: window.location,
                expectedRole: 'student',
                onUnavailable: message => showError(message)
            });

            if (!result?.ok) return;

            await loadProfile();
            await loadPasswordStatus();

            elements.sessionMessage.hidden = true;
            elements.header.hidden = false;
            elements.content.hidden = false;

        } catch (error) {
            console.error('Profile initialization error:', error);

            showError(
                error.message || 'Unable to load your profile.'
            );

            elements.sessionMessage.hidden = true;
            elements.content.hidden = false;
        }
    }

    function logout() {
        api.clearSession();
    }

    elements.logoutButton.addEventListener('click', logout);
    elements.profileForm.addEventListener('submit', handleProfileUpdate);
    elements.passwordForm.addEventListener('submit', handlePasswordChange);

    // Handle the case where Google Identity Services loads after this file.
    const googleScript = document.querySelector(
        'script[src*="accounts.google.com/gsi/client"]'
    );

    if (googleScript) {
        googleScript.addEventListener('load', () => {
            if (passwordStatus && !passwordStatus.hasPassword) {
                initializeGooglePasswordButton();
            }
        });
    }

    initializeProfilePage();
})();
