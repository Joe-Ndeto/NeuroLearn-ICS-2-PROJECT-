'use strict';

function safeErrorDetails(error) {
    const safeIdentifier = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
        ? value
        : null;
    const details = {
        name: safeIdentifier(error?.name) || 'Error',
        code: safeIdentifier(error?.code)
    };
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) details.status = status;
    return details;
}

function logSafeError(logger, label, error) {
    logger.error(label, safeErrorDetails(error));
}

module.exports = { logSafeError, safeErrorDetails };
