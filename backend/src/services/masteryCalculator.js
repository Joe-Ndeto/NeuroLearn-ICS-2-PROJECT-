'use strict';

const HALF_LIFE_DAYS = 45;
const MAX_QUESTION_WEIGHT = 5;
const MASTERED_THRESHOLD = 85;
const PREREQUISITE_THRESHOLD = 80;
const MIN_DISTINCT_ASSESSMENTS = 2;
const MASTERY_DECIMAL_PLACES = 4;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function parseDate(value, fieldName) {
    if (!(value instanceof Date) && typeof value !== 'string') {
        throw new TypeError(`${fieldName} must be a Date or date string.`);
    }
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new TypeError(`${fieldName} must be a valid date.`);
    }
    return date;
}

function assessmentKey(value) {
    if (typeof value === 'string') {
        if (value.trim().length === 0) throw new TypeError('assessmentId must be a non-empty string or positive safe integer.');
        return `string:${value}`;
    }
    if (Number.isSafeInteger(value) && value > 0) return `number:${value}`;
    throw new TypeError('assessmentId must be a non-empty string or positive safe integer.');
}

function validateObservation(observation, index) {
    if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
        throw new TypeError(`Observation at index ${index} must be an object.`);
    }

    const key = assessmentKey(observation.assessmentId);
    if (typeof observation.score !== 'number' || !Number.isFinite(observation.score) ||
        observation.score < 0 || observation.score > 100) {
        throw new TypeError(`Observation at index ${index} has an invalid score.`);
    }

    const assessmentDate = parseDate(observation.assessmentDate, `assessmentDate at index ${index}`);
    const questionIsNull = observation.questionCount === null;
    const correctIsNull = observation.correctCount === null;
    if (questionIsNull !== correctIsNull) {
        throw new TypeError(`Observation at index ${index} must provide both counts or neither.`);
    }

    let baseWeight = 1;
    if (!questionIsNull) {
        if (!Number.isSafeInteger(observation.questionCount) || observation.questionCount <= 0 ||
            !Number.isSafeInteger(observation.correctCount) || observation.correctCount < 0 ||
            observation.correctCount > observation.questionCount) {
            throw new TypeError(`Observation at index ${index} has invalid question counts.`);
        }
        baseWeight = Math.min(observation.questionCount, MAX_QUESTION_WEIGHT);
    }

    return { key, score: observation.score, assessmentDate, baseWeight };
}

/**
 * Calculates recency-weighted mastery for one concept.
 * Future assessment timestamps are treated as occurring at `asOf` (zero elapsed days)
 * to avoid giving clock-skewed observations more than their base question weight.
 */
function calculateMastery(observations, { asOf } = {}) {
    if (!Array.isArray(observations)) throw new TypeError('observations must be an array.');
    const asOfDate = parseDate(asOf, 'asOf');
    const validated = observations.map(validateObservation);
    const seen = new Set();
    for (const observation of validated) {
        if (seen.has(observation.key)) throw new TypeError('Duplicate assessmentId in observations.');
        seen.add(observation.key);
    }

    if (validated.length === 0) {
        return {
            mastery: null,
            evidenceStatus: 'UNKNOWN',
            distinctAssessmentCount: 0,
            isMastered: false,
            prerequisiteSatisfied: false,
            totalWeight: 0
        };
    }

    let weightedScore = 0;
    let totalWeight = 0;
    for (const observation of validated) {
        const elapsedDays = Math.max(0, (asOfDate.getTime() - observation.assessmentDate.getTime()) / MILLISECONDS_PER_DAY);
        const weight = observation.baseWeight * (2 ** (-elapsedDays / HALF_LIFE_DAYS));
        weightedScore += weight * observation.score;
        totalWeight += weight;
    }

    const unroundedMastery = weightedScore / totalWeight;
    const mastery = Number(unroundedMastery.toFixed(MASTERY_DECIMAL_PLACES));
    const distinctAssessmentCount = seen.size;
    const evidenceQualified = distinctAssessmentCount >= MIN_DISTINCT_ASSESSMENTS;

    return {
        mastery,
        evidenceStatus: evidenceQualified ? 'EVIDENCE_QUALIFIED' : 'PROVISIONAL',
        distinctAssessmentCount,
        isMastered: mastery >= MASTERED_THRESHOLD,
        prerequisiteSatisfied: evidenceQualified && mastery >= PREREQUISITE_THRESHOLD,
        totalWeight
    };
}

module.exports = {
    calculateMastery,
    HALF_LIFE_DAYS,
    MAX_QUESTION_WEIGHT,
    MASTERED_THRESHOLD,
    PREREQUISITE_THRESHOLD,
    MIN_DISTINCT_ASSESSMENTS,
    MASTERY_DECIMAL_PLACES
};
