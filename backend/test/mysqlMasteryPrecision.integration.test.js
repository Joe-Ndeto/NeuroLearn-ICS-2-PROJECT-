'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const integrationEnabled = process.env.NEUROLEARN_RUN_MYSQL_INTEGRATION === '1';
const config = integrationEnabled ? {
    host: process.env.NEUROLEARN_TEST_MYSQL_HOST,
    port: process.env.NEUROLEARN_TEST_MYSQL_PORT
        ? Number(process.env.NEUROLEARN_TEST_MYSQL_PORT)
        : 3306,
    user: process.env.NEUROLEARN_TEST_MYSQL_USER,
    password: process.env.NEUROLEARN_TEST_MYSQL_PASSWORD,
    database: process.env.NEUROLEARN_TEST_MYSQL_DATABASE
} : null;
const missingConfig = integrationEnabled && config
    ? ['host', 'user', 'password', 'database'].filter(key => !config[key])
    : [];
const safeTestDatabase = Boolean(config?.database && /test/i.test(config.database));
const skipReason = !integrationEnabled
    ? 'Opt in with NEUROLEARN_RUN_MYSQL_INTEGRATION=1 and explicit test-database settings.'
    : missingConfig.length > 0
        ? `Missing explicit MySQL test configuration: ${missingConfig.join(', ')}.`
        : !safeTestDatabase
            ? 'Refusing integration connection because the configured database name does not identify a test database.'
            : false;

test('MySQL learning_path mastery column retains four decimal places', { skip: skipReason }, async () => {
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection(config);
    const probeTable = 'neurolearn_mastery_precision_probe';
    try {
        const [columns] = await connection.execute(
            `SELECT DATA_TYPE AS dataType, NUMERIC_PRECISION AS numericPrecision,
                    NUMERIC_SCALE AS numericScale, IS_NULLABLE AS isNullable,
                    COLUMN_DEFAULT AS columnDefault
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'learning_path'
               AND COLUMN_NAME = 'mastery_level'`,
            [config.database]
        );
        assert.equal(columns.length, 1, 'learning_path.mastery_level should exist in the configured test database');
        assert.equal(String(columns[0].dataType).toLowerCase(), 'decimal');
        assert.equal(Number(columns[0].numericPrecision), 7);
        assert.equal(Number(columns[0].numericScale), 4);
        assert.equal(columns[0].isNullable, 'YES');
        assert.equal(Number(columns[0].columnDefault), 0);

        await connection.query(
            `CREATE TEMPORARY TABLE ${probeTable} AS
             SELECT mastery_level FROM learning_path LIMIT 0`
        );
        await connection.execute(
            `INSERT INTO ${probeTable} (mastery_level) VALUES (?)`,
            [66.6667]
        );
        const [storedRows] = await connection.query(
            `SELECT mastery_level AS masteryLevel FROM ${probeTable}`
        );
        assert.equal(Number(storedRows[0].masteryLevel).toFixed(4), '66.6667');
    } finally {
        try {
            await connection.query(`DROP TEMPORARY TABLE IF EXISTS ${probeTable}`);
        } finally {
            await connection.end();
        }
    }
});
