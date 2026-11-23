'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rankRecommendations } = require('../src/services/recommendationRanker');

const AS_OF = '2026-01-01T00:00:00.000Z';
const daysAgo = days => new Date(Date.parse(AS_OF) - days * 24 * 60 * 60 * 1000).toISOString();

function candidate(conceptId, overrides = {}) {
    return {
        conceptId,
        conceptName: `Concept ${conceptId}`,
        mastery: 50,
        evidenceStatus: 'PROVISIONAL',
        prerequisites: [],
        assessmentHistory: [],
        ...overrides
    };
}

function prerequisite(conceptId, mastery = 80, evidenceStatus = 'EVIDENCE_QUALIFIED') {
    return { conceptId, conceptName: `Prerequisite ${conceptId}`, mastery, evidenceStatus };
}

function assessment(assessmentId, assessmentDate, timestampProvenance = 'utc') {
    return { assessmentId, assessmentDate, timestampProvenance };
}

test('UNKNOWN mastery is retained as UNKNOWN, allowed for cold start, and gets the full gap component', () => {
    const [result] = rankRecommendations([
        candidate(1, { mastery: null, evidenceStatus: 'UNKNOWN' })
    ], { asOf: AS_OF });

    assert.equal(result.mastery, null);
    assert.equal(result.evidenceStatus, 'UNKNOWN');
    assert.equal(result.G, 1);
    assert.match(result.explanation, /Mastery is UNKNOWN/);
});

test('PROVISIONAL and EVIDENCE_QUALIFIED candidates are both rankable below the mastered threshold', () => {
    const results = rankRecommendations([
        candidate(1, { mastery: 40, evidenceStatus: 'PROVISIONAL' }),
        candidate(2, { mastery: 60, evidenceStatus: 'EVIDENCE_QUALIFIED' })
    ], { asOf: AS_OF });

    assert.deepEqual(results.map(item => item.conceptId), [1, 2]);
    assert.equal(results[0].evidenceStatus, 'PROVISIONAL');
    assert.equal(results[1].evidenceStatus, 'EVIDENCE_QUALIFIED');
    assert.equal(results[0].G, 0.6);
    assert.equal(results[1].G, 0.4);
});

test('candidate mastery gap follows (100 - mastery) / 100', () => {
    const [result] = rankRecommendations([
        candidate(1, { mastery: 72.5, evidenceStatus: 'EVIDENCE_QUALIFIED' })
    ], { asOf: AS_OF });
    assert.equal(result.G, 0.275);
});

test('candidate with no prerequisites has full prerequisite readiness', () => {
    const [result] = rankRecommendations([candidate(1)], { asOf: AS_OF });
    assert.equal(result.R, 1);
    assert.deepEqual(result.prerequisiteReadiness, {
        satisfied: true,
        satisfiedCount: 0,
        totalCount: 0,
        averageMastery: 100,
        prerequisites: []
    });
});

test('satisfied prerequisite mastery is averaged into R and reported', () => {
    const [result] = rankRecommendations([
        candidate(3, { prerequisites: [prerequisite(1, 80), prerequisite(2, 100)] })
    ], { asOf: AS_OF });
    assert.equal(result.R, 0.9);
    assert.equal(result.prerequisiteReadiness.satisfied, true);
    assert.equal(result.prerequisiteReadiness.satisfiedCount, 2);
    assert.equal(result.prerequisiteReadiness.averageMastery, 90);
});

test('any unsatisfied prerequisite excludes the candidate', () => {
    const results = rankRecommendations([
        candidate(3, { prerequisites: [prerequisite(1, 80), prerequisite(2, 90, 'PROVISIONAL')] })
    ], { asOf: AS_OF });
    assert.deepEqual(results, []);
});

test('prerequisite chain closure checks every supplied direct and transitive prerequisite', () => {
    const blocked = rankRecommendations([
        candidate(3, { prerequisites: [prerequisite(2, 90), prerequisite(1, 79.9999)] })
    ], { asOf: AS_OF });
    const ready = rankRecommendations([
        candidate(3, { prerequisites: [prerequisite(2, 90), prerequisite(1, 80)] })
    ], { asOf: AS_OF });
    assert.equal(blocked.length, 0);
    assert.equal(ready.length, 1);
    assert.equal(ready[0].prerequisiteReadiness.totalCount, 2);
});

test('prerequisite gate rejects PROVISIONAL and UNKNOWN evidence even at high mastery', () => {
    const results = rankRecommendations([
        candidate(3, { prerequisites: [prerequisite(1, 100, 'PROVISIONAL')] }),
        candidate(4, { prerequisites: [prerequisite(2, null, 'UNKNOWN')] })
    ], { asOf: AS_OF });
    assert.deepEqual(results, []);
});

test('prerequisite mastery at 80 qualifies while values immediately below 80 do not', () => {
    const results = rankRecommendations([
        candidate(1, { prerequisites: [prerequisite(10, 79.9999)] }),
        candidate(2, { prerequisites: [prerequisite(11, 80)] }),
        candidate(3, { prerequisites: [prerequisite(12, 80.0001)] })
    ], { asOf: AS_OF });
    assert.deepEqual(results.map(item => item.conceptId), [2, 3]);
});

test('candidates at or above 85 mastery are excluded', () => {
    const results = rankRecommendations([
        candidate(1, { mastery: 84.9999, evidenceStatus: 'EVIDENCE_QUALIFIED' }),
        candidate(2, { mastery: 85, evidenceStatus: 'EVIDENCE_QUALIFIED' }),
        candidate(3, { mastery: 100, evidenceStatus: 'PROVISIONAL' })
    ], { asOf: AS_OF });
    assert.deepEqual(results.map(item => item.conceptId), [1]);
    assert.equal(results[0].mastery, 84.9999);
});

test('fresh verified UTC evidence has zero urgency', () => {
    const [result] = rankRecommendations([
        candidate(1, { assessmentHistory: [assessment(1, AS_OF)] })
    ], { asOf: AS_OF });
    assert.equal(result.U, 0);
});

test('stale verified UTC evidence increases urgency by the 45-day half-life formula', () => {
    const [result] = rankRecommendations([
        candidate(1, { assessmentHistory: [assessment(1, daysAgo(45))] })
    ], { asOf: AS_OF });
    assert.equal(result.U, 0.5);
});

test('unknown timestamp provenance never supplies urgency, including a valid historical date', () => {
    const [result] = rankRecommendations([
        candidate(1, { assessmentHistory: [assessment(1, daysAgo(900), 'unknown')] })
    ], { asOf: AS_OF });
    assert.equal(result.U, 0);
    assert.match(result.explanation, /No verified UTC assessment date is available/);
});

test('future verified UTC dates are clamped to zero elapsed days', () => {
    const [result] = rankRecommendations([
        candidate(1, { assessmentHistory: [assessment(1, '2026-02-01T00:00:00.000Z')] })
    ], { asOf: AS_OF });
    assert.equal(result.U, 0);
});

test('most recent verified UTC assessment is selected and other unknown dates are ignored', () => {
    const [result] = rankRecommendations([
        candidate(1, {
            assessmentHistory: [
                assessment(1, daysAgo(45)),
                assessment(2, daysAgo(10)),
                assessment(3, daysAgo(900), 'unknown')
            ]
        })
    ], { asOf: AS_OF });
    assert.ok(result.U > 0);
    assert.ok(result.U < 0.5);
    assert.match(result.explanation, new RegExp(new Date(daysAgo(10)).toISOString()));
});

test('sorts by rounded priority descending and concept ID ascending on ties', () => {
    const results = rankRecommendations([
        candidate(9, { mastery: 50 }),
        candidate(2, { mastery: 50 }),
        candidate(5, { mastery: 20 })
    ], { asOf: AS_OF });
    assert.deepEqual(results.map(item => item.conceptId), [5, 2, 9]);
    assert.equal(results[1].priorityScore, results[2].priorityScore);
});

test('empty input returns an empty ranked list', () => {
    assert.deepEqual(rankRecommendations([], { asOf: AS_OF }), []);
});

test('rejects missing prerequisite information and malformed top-level input', () => {
    const missingPrerequisites = candidate(1);
    delete missingPrerequisites.prerequisites;
    assert.throws(() => rankRecommendations([missingPrerequisites], { asOf: AS_OF }), /must supply prerequisites as an array/);
    assert.throws(() => rankRecommendations(null, { asOf: AS_OF }), /candidates must be an array/);
    assert.throws(() => rankRecommendations([], {}), /asOf/);
});

test('rejects malformed candidate and prerequisite IDs, names, mastery and evidence statuses', () => {
    const invalidCandidates = [
        candidate(0),
        candidate(1, { conceptName: '  ' }),
        candidate(1, { mastery: -1 }),
        candidate(1, { mastery: 101 }),
        candidate(1, { mastery: null, evidenceStatus: 'PROVISIONAL' }),
        candidate(1, { mastery: 20, evidenceStatus: 'UNKNOWN' }),
        candidate(1, { evidenceStatus: 'MAYBE' }),
        candidate(1, { prerequisites: [prerequisite(1)] }),
        candidate(1, { prerequisites: [{ ...prerequisite(2), conceptName: '' }] }),
        candidate(1, { prerequisites: [prerequisite(2, 101)] })
    ];
    for (const invalid of invalidCandidates) {
        assert.throws(() => rankRecommendations([invalid], { asOf: AS_OF }));
    }
    assert.throws(() => rankRecommendations([candidate(1), candidate(1)], { asOf: AS_OF }), /unique/);
});

test('rejects malformed, duplicate, unprovenanced and impossible assessment timestamps', () => {
    const invalidHistory = [
        [assessment(1, 'not-a-date')],
        [assessment(1, null, 'utc')],
        [{ assessmentId: 1, assessmentDate: AS_OF }],
        [assessment(1, null, 'unknown'), assessment(1, null, 'unknown')],
        [{ assessmentId: 0, assessmentDate: AS_OF, timestampProvenance: 'utc' }]
    ];
    for (const assessmentHistory of invalidHistory) {
        assert.throws(() => rankRecommendations([
            candidate(1, { assessmentHistory })
        ], { asOf: AS_OF }));
    }
    assert.throws(() => rankRecommendations([
        candidate(1, { assessmentHistory: {} })
    ], { asOf: AS_OF }), /must be an array/);
});

test('explanation reports the same rounded components and priority used for sorting', () => {
    const [result] = rankRecommendations([
        candidate(1, {
            mastery: 50,
            prerequisites: [prerequisite(9, 90)],
            assessmentHistory: [assessment(1, daysAgo(45))]
        })
    ], { asOf: AS_OF });
    const expected = 100 * (0.55 * result.G + 0.30 * result.R + 0.15 * result.U);
    assert.equal(result.priorityScore, Number(expected.toFixed(4)));
    assert.match(result.explanation, new RegExp(`G=${result.G}`));
    assert.match(result.explanation, new RegExp(`R=${result.R}`));
    assert.match(result.explanation, new RegExp(`U=${result.U}`));
    assert.match(result.explanation, new RegExp(`Priority score ${result.priorityScore.toFixed(4)}`));
    assert.match(result.explanation, /not a probability/);
});
