'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../frontend/config.js'), 'utf8');

function loadConfig(location, initialConfig = undefined) {
    const window = { location, NEUROLEARN_CONFIG: initialConfig };
    vm.runInNewContext(source, { window });
    return window.NEUROLEARN_CONFIG;
}

test('frontend configuration defaults production to same-origin and local development to localhost API', () => {
    assert.equal(loadConfig({ origin: 'https://learn.example', hostname: 'learn.example', protocol: 'https:' }).apiBaseUrl,
        'https://learn.example/api');
    assert.equal(loadConfig({ origin: 'http://localhost:5500', hostname: 'localhost', protocol: 'http:' }).apiBaseUrl,
        'http://localhost:5000/api');
});

test('explicit API configuration is retained and frontend config contains no backend secret settings', () => {
    const config = loadConfig(
        { origin: 'https://learn.example', hostname: 'learn.example', protocol: 'https:' },
        { apiBaseUrl: 'https://api.example/api/' }
    );
    assert.equal(config.apiBaseUrl, 'https://api.example/api');
    assert.equal(Object.keys(config).some(key => /secret|password|gemini|token/i.test(key)), false);
});
