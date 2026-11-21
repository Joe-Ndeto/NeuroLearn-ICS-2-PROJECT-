'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    calculateMastery,
    HALF_LIFE_DAYS,
    MAX_QUESTION_WEIGHT,
    MASTERED_THRESHOLD,
    PREREQUISITE_THRESHOLD,
    MIN_DISTINCT_ASSESSMENTS,
    MASTERY_DECIMAL_PLACES
} = require('../src/services/masteryCalculator');

const AS_OF = '2026-11-21T12:00:00.000Z';
const dateDaysAgo = days => new Date(Date.parse(AS_OF) - days * 24 * 60 * 60 * 1000).toISOString();
const observation = (assessmentId, score, overrides = {}) => ({
    assessmentId,
    score,
    assessmentDate: AS_OF,
    questionCount: 1,
    correctCount: score === 100 ? 1 : 0,
    timestampProvenance: 'utc',
    ...overrides
});
const closeTo = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} was not within ${tolerance} of ${expected}`);

test('exports the fixed mastery policy constants', () => {
    assert.equal(HALF_LIFE_DAYS, 45);
    assert.equal(MAX_QUESTION_WEIGHT, 5);
    assert.equal(MASTERED_THRESHOLD, 85);
    assert.equal(PREREQUISITE_THRESHOLD, 80);
    assert.equal(MIN_DISTINCT_ASSESSMENTS, 2);
    assert.equal(MASTERY_DECIMAL_PLACES, 4);
});

test('no observations produce unknown mastery without satisfying either threshold', () => {
    assert.deepEqual(calculateMastery([], { asOf: AS_OF }), {
        mastery: null,
        evidenceStatus: 'UNKNOWN',
        distinctAssessmentCount: 0,
        isMastered: false,
        prerequisiteSatisfied: false,
        totalWeight: 0,
        temporalCoverage: {
            totalObservations: 0,
            verifiedUtcObservations: 0,
            unknownTimeObservations: 0,
            legacyObservations: 0,
            complete: false
        }
    });
});

test('one assessment is provisional and a high score alone does not satisfy a prerequisite', () => {
    const result = calculateMastery([observation('quiz-one', 100)], { asOf: AS_OF });
    assert.equal(result.mastery, 100);
    assert.equal(result.evidenceStatus, 'PROVISIONAL');
    assert.equal(result.distinctAssessmentCount, 1);
    assert.equal(result.isMastered, true);
    assert.equal(result.prerequisiteSatisfied, false);
});

test('two distinct assessments are evidence-qualified and mastery at least 80 satisfies prerequisites', () => {
    const result = calculateMastery([
        observation('quiz-one', 80),
        observation('quiz-two', 80)
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 80);
    assert.equal(result.evidenceStatus, 'EVIDENCE_QUALIFIED');
    assert.equal(result.distinctAssessmentCount, 2);
    assert.equal(result.isMastered, false);
    assert.equal(result.prerequisiteSatisfied, true);
});

test('mastery exactly 85 is mastered while prerequisite status remains independently evidence-qualified', () => {
    const single = calculateMastery([observation('one', 85)], { asOf: AS_OF });
    assert.equal(single.mastery, 85);
    assert.equal(single.isMastered, true);
    assert.equal(single.prerequisiteSatisfied, false);

    const qualified = calculateMastery([
        observation('one', 85), observation('two', 85)
    ], { asOf: AS_OF });
    assert.equal(qualified.isMastered, true);
    assert.equal(qualified.prerequisiteSatisfied, true);
});

test('four-decimal mastery precision preserves decisions immediately around 80 and 85', () => {
    const belowPrerequisite = calculateMastery([
        observation('prereq-below-a', 79.9999), observation('prereq-below-b', 79.9999)
    ], { asOf: AS_OF });
    const abovePrerequisite = calculateMastery([
        observation('prereq-above-a', 80.0001), observation('prereq-above-b', 80.0001)
    ], { asOf: AS_OF });
    const belowMastered = calculateMastery([
        observation('mastery-below-a', 84.9999), observation('mastery-below-b', 84.9999)
    ], { asOf: AS_OF });
    const aboveMastered = calculateMastery([
        observation('mastery-above-a', 85.0001), observation('mastery-above-b', 85.0001)
    ], { asOf: AS_OF });

    assert.equal(belowPrerequisite.mastery, 79.9999);
    assert.equal(belowPrerequisite.prerequisiteSatisfied, false);
    assert.equal(abovePrerequisite.mastery, 80.0001);
    assert.equal(abovePrerequisite.prerequisiteSatisfied, true);
    assert.equal(belowMastered.mastery, 84.9999);
    assert.equal(belowMastered.isMastered, false);
    assert.equal(aboveMastered.mastery, 85.0001);
    assert.equal(aboveMastered.isMastered, true);
});

test('known question counts weight an assessment by its question count', () => {
    const result = calculateMastery([
        observation(1, 100, { questionCount: 4, correctCount: 4 }),
        observation(2, 0, { questionCount: 1, correctCount: 0 })
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 80);
    assert.equal(result.totalWeight, 5);
});

test('question-count weight is capped at five', () => {
    const result = calculateMastery([
        observation('many', 100, { questionCount: 12, correctCount: 12 }),
        observation('few', 0, { questionCount: 1, correctCount: 0 })
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 83.3333);
    assert.equal(result.totalWeight, 6);
});

test('weight halves after 45 days of recency decay', () => {
    const result = calculateMastery([
        observation('recent', 0, { assessmentDate: AS_OF }),
        observation('old', 100, { assessmentDate: dateDaysAgo(HALF_LIFE_DAYS) })
    ], { asOf: AS_OF });
    closeTo(result.totalWeight, 1.5);
    assert.equal(result.mastery, 33.3333);
});

test('unknown provenance uses base weights without recency decay', () => {
    const result = calculateMastery([
        observation('unknown-recent', 100, { questionCount: 1, correctCount: 1, timestampProvenance: 'unknown', assessmentDate: AS_OF }),
        observation('unknown-old', 0, { questionCount: 5, correctCount: 0, timestampProvenance: 'unknown', assessmentDate: dateDaysAgo(450) })
    ], { asOf: AS_OF });
    assert.equal(result.totalWeight, 6);
    assert.equal(result.mastery, 16.6667);
    assert.deepEqual(result.temporalCoverage, {
        totalObservations: 2,
        verifiedUtcObservations: 0,
        unknownTimeObservations: 2,
        legacyObservations: 0,
        complete: false
    });
});

test('NULL historical dates require unknown provenance and use base evidence weight', () => {
    const result = calculateMastery([
        observation('undated', 75, {
            assessmentDate: null,
            questionCount: 3,
            correctCount: 2,
            timestampProvenance: 'unknown'
        })
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 75);
    assert.equal(result.totalWeight, 3);
    assert.equal(result.temporalCoverage.unknownTimeObservations, 1);

    assert.throws(() => calculateMastery([
        observation('undated-without-provenance', 75, { assessmentDate: null })
    ], { asOf: AS_OF }));
    assert.throws(() => calculateMastery([
        observation('utc-undated', 75, { assessmentDate: null, timestampProvenance: 'utc' })
    ], { asOf: AS_OF }));
});

test('malformed non-NULL dates remain errors for unknown provenance', () => {
    assert.throws(() => calculateMastery([
        observation('malformed-unknown', 75, {
            assessmentDate: 'not-a-date',
            timestampProvenance: 'unknown'
        })
    ], { asOf: AS_OF }));
});

test('invalid timestamp provenance is rejected', () => {
    assert.throws(() => calculateMastery([
        observation('invalid-provenance', 75, { timestampProvenance: 'local' })
    ], { asOf: AS_OF }), /timestamp provenance/);
});

test('legacy valid-date calls retain recency behavior and are not classified as UTC or explicitly unknown', () => {
    const legacyRecent = { ...observation('legacy-recent', 0) };
    const legacyOld = { ...observation('legacy-old', 100, { assessmentDate: dateDaysAgo(HALF_LIFE_DAYS) }) };
    delete legacyRecent.timestampProvenance;
    delete legacyOld.timestampProvenance;
    const result = calculateMastery([legacyRecent, legacyOld], { asOf: AS_OF });
    closeTo(result.totalWeight, 1.5);
    assert.equal(result.mastery, 33.3333);
    assert.deepEqual(result.temporalCoverage, {
        totalObservations: 2,
        verifiedUtcObservations: 0,
        unknownTimeObservations: 0,
        legacyObservations: 2,
        complete: false
    });
});

test('temporal coverage distinguishes legacy, explicit unknown, and verified UTC observations', () => {
    const complete = calculateMastery([
        observation('utc-a', 80), observation('utc-b', 80)
    ], { asOf: AS_OF });
    assert.deepEqual(complete.temporalCoverage, {
        totalObservations: 2,
        verifiedUtcObservations: 2,
        unknownTimeObservations: 0,
        legacyObservations: 0,
        complete: true
    });

    const mixed = calculateMastery([
        observation('utc', 80),
        observation('unknown', 80, { timestampProvenance: 'unknown', assessmentDate: null }),
        (() => {
            const legacy = observation('legacy', 80);
            delete legacy.timestampProvenance;
            return legacy;
        })()
    ], { asOf: AS_OF });
    assert.deepEqual(mixed.temporalCoverage, {
        totalObservations: 3,
        verifiedUtcObservations: 1,
        unknownTimeObservations: 1,
        legacyObservations: 1,
        complete: false
    });
});

test('zero observations have incomplete temporal coverage because no timestamps were verified', () => {
    const result = calculateMastery([], { asOf: AS_OF });
    assert.equal(result.temporalCoverage.totalObservations, 0);
    assert.equal(result.temporalCoverage.complete, false);
});

test('historical rows with both counts null use fallback weight one', () => {
    const result = calculateMastery([
        observation('legacy', 100, { questionCount: null, correctCount: null })
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 100);
    assert.equal(result.totalWeight, 1);
});

test('mixed historical and new evidence applies fallback and question-count weights', () => {
    const result = calculateMastery([
        observation('legacy', 100, { questionCount: null, correctCount: null }),
        observation('new', 0, { questionCount: 3, correctCount: 0 })
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 25);
    assert.equal(result.totalWeight, 4);
});

test('returns mastery rounded consistently without rounding total weight', () => {
    const result = calculateMastery([
        observation('a', 100, { questionCount: 1, correctCount: 1 }),
        observation('b', 0, { questionCount: 2, correctCount: 0 })
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 33.3333);
    assert.equal(result.mastery, Number(result.mastery.toFixed(MASTERY_DECIMAL_PLACES)));
});

test('future assessment dates use zero elapsed days', () => {
    const result = calculateMastery([
        observation('future', 100, { assessmentDate: '2026-11-23T12:00:00Z', questionCount: 4, correctCount: 4 })
    ], { asOf: AS_OF });
    assert.equal(result.mastery, 100);
    assert.equal(result.totalWeight, 4);
});

test('rejects invalid score, date, assessment ID, counts, and asOf', () => {
    const invalidRecords = [
        observation(1, -0.01),
        observation(1, 100.01),
        observation(1, NaN),
        observation(1, Infinity),
        observation(1, 50, { assessmentDate: 'not-a-date' }),
        observation('', 50),
        observation('   ', 50),
        observation(0, 50),
        observation(-1, 50),
        observation(Number.MAX_SAFE_INTEGER + 1, 50),
        observation(1, 50, { questionCount: 0, correctCount: 0 }),
        observation(1, 50, { questionCount: -1, correctCount: 0 }),
        observation(1, 50, { questionCount: 1.5, correctCount: 1 }),
        observation(1, 50, { questionCount: 2, correctCount: -1 }),
        observation(1, 50, { questionCount: 2, correctCount: 3 }),
        observation(1, 50, { questionCount: 2, correctCount: 1.5 })
    ];
    for (const invalid of invalidRecords) {
        assert.throws(() => calculateMastery([invalid], { asOf: AS_OF }));
    }
    assert.throws(() => calculateMastery([], { asOf: 'invalid-date' }));
    assert.throws(() => calculateMastery([], {}));
});

test('rejects records where only one evidence count is null', () => {
    for (const counts of [
        { questionCount: null, correctCount: 0 },
        { questionCount: 1, correctCount: null }
    ]) {
        assert.throws(() => calculateMastery([observation('partial', 50, counts)], { asOf: AS_OF }));
    }
});

test('rejects duplicate assessment IDs rather than double-counting them', () => {
    assert.throws(() => calculateMastery([
        observation('same-id', 90), observation('same-id', 90)
    ], { asOf: AS_OF }), /Duplicate assessmentId/);
});

test('does not mutate input observations or records', () => {
    const records = [
        observation('first', 90, { assessmentDate: new Date(AS_OF) }),
        observation('second', 70)
    ];
    const before = structuredClone(records);
    const arrayReference = records;
    calculateMastery(records, { asOf: new Date(AS_OF) });
    assert.equal(records, arrayReference);
    assert.deepEqual(records, before);
});

test('reordering observations does not materially change mastery', () => {
    const records = [
        observation('first', 100, { questionCount: 5, correctCount: 5, assessmentDate: dateDaysAgo(10) }),
        observation('second', 60, { questionCount: 3, correctCount: 2, assessmentDate: dateDaysAgo(50) }),
        observation('third', 80, { questionCount: null, correctCount: null, assessmentDate: dateDaysAgo(20) })
    ];
    const forward = calculateMastery(records, { asOf: AS_OF });
    const reverse = calculateMastery([...records].reverse(), { asOf: AS_OF });
    closeTo(forward.mastery, reverse.mastery, 1e-12);
    closeTo(forward.totalWeight, reverse.totalWeight, 1e-12);
});
