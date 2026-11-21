'use strict';

const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const path = require('node:path');

const configPath = path.join(__dirname, '../src/config/mysql.js');

function loadConfigWithPoolMock() {
    const pool = new EventEmitter();
    let options;
    const mysqlMock = {
        createPool(poolOptions) {
            options = poolOptions;
            return pool;
        }
    };

    const module = { exports: {} };
    const fakeProcess = { env: new Proxy({}, { get: () => undefined }) };
    const fakeConsole = { error() {} };
    const source = fs.readFileSync(configPath, 'utf8');
    vm.runInNewContext(source, {
        require(request) {
            if (request === 'mysql2/promise') return mysqlMock;
            throw new Error(`Unexpected module request: ${request}`);
        },
        module,
        process: fakeProcess,
        console: fakeConsole
    }, { filename: configPath });
    return { pool: module.exports, options, console: fakeConsole };
}

function createQueuedConnection() {
    const state = {
        destroyed: false,
        pending: [],
        executed: [],
        active: false,
        initializationCallback: null
    };

    function startNext() {
        if (state.active || state.destroyed || state.pending.length === 0) return;
        state.active = true;
        const command = state.pending.shift();
        state.executed.push(command.sql);
        if (command.sql === "SET time_zone = '+00:00'") {
            state.initializationCallback = error => {
                try {
                    command.callback(error || null);
                } finally {
                    state.active = false;
                    if (state.destroyed) {
                        while (state.pending.length) {
                            state.pending.shift().callback(new Error('connection destroyed'));
                        }
                    } else {
                        startNext();
                    }
                }
            };
            return;
        }
        command.callback(state.destroyed ? new Error('connection destroyed') : null);
        state.active = false;
        startNext();
    }

    return {
        state,
        query(sql, callback) {
            if (state.destroyed) {
                callback(new Error('connection destroyed'));
                return;
            }
            state.pending.push({ sql, callback });
            startNext();
        },
        destroy() {
            state.destroyed = true;
        }
    };
}

test('mysql pool explicitly uses UTC date conversion and preserves existing pool settings', () => {
    const { options } = loadConfigWithPoolMock();
    assert.equal(options.timezone, 'Z');
    assert.equal(options.waitForConnections, true);
    assert.equal(options.connectionLimit, 10);
    assert.equal(options.queueLimit, 0);
});

test('each new pool connection queues UTC initialization before application work', () => {
    const { pool } = loadConfigWithPoolMock();
    for (let index = 0; index < 2; index++) {
        const connection = createQueuedConnection();
        pool.emit('connection', connection);
        assert.deepEqual(connection.state.executed, ["SET time_zone = '+00:00'"]);
        assert.equal(connection.state.initializationCallback instanceof Function, true);
    }
});

test('application query executes only after UTC initialization succeeds', () => {
    const { pool, console: configConsole } = loadConfigWithPoolMock();
    const connection = createQueuedConnection();
    const applicationResults = [];
    configConsole.error = () => assert.fail('successful initialization must not log an error');
    pool.emit('connection', connection);
    connection.query('SELECT application_data', error => applicationResults.push(error || null));

    assert.deepEqual(connection.state.executed, ["SET time_zone = '+00:00'"]);
    assert.equal(applicationResults.length, 0, 'application query remains queued while UTC setup is pending');
    connection.state.initializationCallback(null);

    assert.deepEqual(connection.state.executed, ["SET time_zone = '+00:00'", 'SELECT application_data']);
    assert.deepEqual(applicationResults, [null]);
    assert.equal(connection.state.destroyed, false);
});

test('initialization failure destroys the connection and fails queued application work', () => {
    const { pool, console: configConsole } = loadConfigWithPoolMock();
    const logged = [];
    const connection = createQueuedConnection();
    const applicationResults = [];
    configConsole.error = message => logged.push(message);
    pool.emit('connection', connection);
    connection.query('SELECT application_data', error => applicationResults.push(error || null));

    assert.deepEqual(connection.state.executed, ["SET time_zone = '+00:00'"]);
    connection.state.initializationCallback(new Error('sensitive server detail'));

    assert.equal(connection.state.destroyed, true);
    assert.deepEqual(connection.state.executed, ["SET time_zone = '+00:00'"]);
    assert.equal(applicationResults.length, 1);
    assert.ok(applicationResults[0] instanceof Error);
    assert.equal(logged.length, 1);
    assert.ok(logged.every(message => !message.includes('sensitive server detail')));
});

test('synchronous exception while queuing UTC initialization destroys the connection safely', () => {
    const { pool, console: configConsole } = loadConfigWithPoolMock();
    const logged = [];
    configConsole.error = message => logged.push(message);
    const connection = {
        destroyed: false,
        query() { throw new Error('sensitive server detail'); },
        destroy() { this.destroyed = true; }
    };
    pool.emit('connection', connection);
    assert.equal(connection.destroyed, true);
    assert.equal(logged.length, 1);
    assert.ok(!logged[0].includes('sensitive server detail'));
});

test('a connection with a missing initialization callback remains blocked without a custom timeout', () => {
    const { pool } = loadConfigWithPoolMock();
    const connection = createQueuedConnection();
    const applicationResults = [];
    pool.emit('connection', connection);
    connection.query('SELECT application_data', error => applicationResults.push(error || null));

    assert.deepEqual(connection.state.executed, ["SET time_zone = '+00:00'"]);
    assert.equal(connection.state.pending.length, 1);
    assert.equal(applicationResults.length, 0);
    assert.equal(connection.state.destroyed, false);
});
