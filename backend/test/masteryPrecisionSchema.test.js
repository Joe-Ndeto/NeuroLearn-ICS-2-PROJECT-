'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('fresh-install mastery precision is DECIMAL(7,4) with the existing nullable default', () => {
    const schema = read('database/mysql/schema.sql');
    const learningPathDefinition = schema.match(/CREATE TABLE learning_path\s*\(([\s\S]*?)\n\);/i)?.[1];
    assert.ok(learningPathDefinition, 'learning_path table definition should exist');
    assert.match(learningPathDefinition, /mastery_level\s+DECIMAL\(7,4\)\s+DEFAULT\s+0/i);
    assert.doesNotMatch(learningPathDefinition, /mastery_level[^,]*\bNOT NULL\b/i);
});

test('migration 008 widens only mastery precision and does not recalculate stored values', () => {
    const migration = read('database/mysql/migrations/008_expand_learning_path_mastery_precision.sql');
    const executableSql = migration.replace(/--[^\r\n]*/g, '').trim();
    assert.match(executableSql, /^ALTER\s+TABLE\s+learning_path\s+MODIFY\s+COLUMN\s+mastery_level\s+DECIMAL\(7,4\)\s+NULL\s+DEFAULT\s+0\s*;$/i);
    assert.doesNotMatch(executableSql, /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i);
});

test('MySQL documentation includes migration 008 preflight and verification guidance', () => {
    const readme = read('database/mysql/README.md');
    assert.match(readme, /Migration order is 001 through 009/);
    assert.match(readme, /learning_path\.mastery_level.*DECIMAL\(5,2\).*nullable.*default `0`/i);
    assert.match(readme, /widening the scale retains existing two-decimal numeric values/i);
    assert.match(readme, /migration 008 is DDL.*backup/i);
    assert.match(readme, /do not apply the migration blindly/i);
});
