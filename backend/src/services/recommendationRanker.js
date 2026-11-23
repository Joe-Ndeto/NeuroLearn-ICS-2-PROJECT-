'use strict';

const HALF_LIFE_DAYS = 45;
const PREREQUISITE_THRESHOLD = 80;
const MASTERED_THRESHOLD = 85;
const PREREQUISITE_EVIDENCE_STATUS = 'EVIDENCE_QUALIFIED';
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const SCORE_DECIMAL_PLACES = 4;
const EVIDENCE_STATUSES = new Set(['UNKNOWN', 'PROVISIONAL', 'EVIDENCE_QUALIFIED']);

function round(value, places) {
    return Number(value.toFixed(places));
}

function parseDate(value, fieldName) {
    if (!(value instanceof Date) && typeof value !== 'string') {
        throw new TypeError(`${fieldName} must be a Date or date string.`);
    }
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError(`${fieldName} must be a valid date.`);
    return date;
}

function validateConceptId(value, fieldName) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`${fieldName} must be a positive safe integer.`);
    }
    return value;
}

function validateEvidence(mastery, evidenceStatus, fieldName) {
    if (!EVIDENCE_STATUSES.has(evidenceStatus)) {
        throw new TypeError(`${fieldName}.evidenceStatus is invalid.`);
    }
    if (mastery === null) {
        if (evidenceStatus !== 'UNKNOWN') {
            throw new TypeError(`${fieldName} with null mastery must have UNKNOWN evidence status.`);
        }
        return;
    }
    if (typeof mastery !== 'number' || !Number.isFinite(mastery) || mastery < 0 || mastery > 100) {
        throw new TypeError(`${fieldName}.mastery must be null or a number from 0 to 100.`);
    }
    if (evidenceStatus === 'UNKNOWN') {
        throw new TypeError(`${fieldName} with numeric mastery cannot have UNKNOWN evidence status.`);
    }
}

function validateAssessmentHistory(history, fieldName) {
    if (history === undefined) return [];
    if (!Array.isArray(history)) throw new TypeError(`${fieldName} must be an array when provided.`);

    const seenAssessmentIds = new Set();
    return history.map((observation, index) => {
        const label = `${fieldName}[${index}]`;
        if (!observation || typeof observation !== 'object' || Array.isArray(observation)) {
            throw new TypeError(`${label} must be an object.`);
        }
        const assessmentId = validateConceptId(observation.assessmentId, `${label}.assessmentId`);
        if (seenAssessmentIds.has(assessmentId)) {
            throw new TypeError(`${fieldName} must not contain duplicate assessment IDs.`);
        }
        seenAssessmentIds.add(assessmentId);

        if (observation.timestampProvenance !== 'utc' && observation.timestampProvenance !== 'unknown') {
            throw new TypeError(`${label}.timestampProvenance must be 'utc' or 'unknown'.`);
        }
        let assessmentDate = null;
        if (observation.assessmentDate === null) {
            if (observation.timestampProvenance !== 'unknown') {
                throw new TypeError(`${label}.assessmentDate may be null only with unknown provenance.`);
            }
        } else {
            assessmentDate = parseDate(observation.assessmentDate, `${label}.assessmentDate`);
        }
        return { assessmentId, assessmentDate, timestampProvenance: observation.timestampProvenance };
    });
}

function validatePrerequisites(candidate, candidateId) {
    if (!Array.isArray(candidate.prerequisites)) {
        throw new TypeError(`Candidate ${candidateId} must supply prerequisites as an array.`);
    }
    const seenIds = new Set();
    return candidate.prerequisites.map((prerequisite, index) => {
        const fieldName = `Candidate ${candidateId} prerequisites[${index}]`;
        if (!prerequisite || typeof prerequisite !== 'object' || Array.isArray(prerequisite)) {
            throw new TypeError(`${fieldName} must be an object.`);
        }
        const conceptId = validateConceptId(prerequisite.conceptId, `${fieldName}.conceptId`);
        if (conceptId === candidateId) throw new TypeError(`${fieldName} cannot refer to its candidate itself.`);
        if (seenIds.has(conceptId)) throw new TypeError(`Candidate ${candidateId} has duplicate prerequisite IDs.`);
        seenIds.add(conceptId);
        if (typeof prerequisite.conceptName !== 'string' || !prerequisite.conceptName.trim()) {
            throw new TypeError(`${fieldName}.conceptName must be a non-empty string.`);
        }
        validateEvidence(prerequisite.mastery, prerequisite.evidenceStatus, fieldName);
        return {
            conceptId,
            conceptName: prerequisite.conceptName.trim(),
            mastery: prerequisite.mastery,
            evidenceStatus: prerequisite.evidenceStatus,
            satisfied: prerequisite.evidenceStatus === PREREQUISITE_EVIDENCE_STATUS &&
                prerequisite.mastery !== null && prerequisite.mastery >= PREREQUISITE_THRESHOLD
        };
    });
}

function validateCandidate(candidate, index) {
    const fieldName = `Candidate at index ${index}`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new TypeError(`${fieldName} must be an object.`);
    }
    const conceptId = validateConceptId(candidate.conceptId, `${fieldName}.conceptId`);
    if (typeof candidate.conceptName !== 'string' || !candidate.conceptName.trim()) {
        throw new TypeError(`${fieldName}.conceptName must be a non-empty string.`);
    }
    validateEvidence(candidate.mastery, candidate.evidenceStatus, fieldName);
    const prerequisites = validatePrerequisites(candidate, conceptId);
    const assessmentHistory = validateAssessmentHistory(
        candidate.assessmentHistory,
        `${fieldName}.assessmentHistory`
    );

    return {
        conceptId,
        conceptName: candidate.conceptName.trim(),
        mastery: candidate.mastery,
        evidenceStatus: candidate.evidenceStatus,
        prerequisites,
        assessmentHistory
    };
}

function latestVerifiedUtcDate(history) {
    let latest = null;
    for (const observation of history) {
        if (observation.timestampProvenance !== 'utc') continue;
        if (latest === null || observation.assessmentDate.getTime() > latest.getTime()) {
            latest = observation.assessmentDate;
        }
    }
    return latest;
}

function rankRecommendations(candidates, { asOf } = {}) {
    if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array.');
    const asOfDate = parseDate(asOf, 'asOf');
    const validatedCandidates = candidates.map(validateCandidate);
    const seenCandidateIds = new Set();
    for (const candidate of validatedCandidates) {
        if (seenCandidateIds.has(candidate.conceptId)) {
            throw new TypeError('Candidate concept IDs must be unique.');
        }
        seenCandidateIds.add(candidate.conceptId);
    }

    const ranked = [];
    for (const candidate of validatedCandidates) {
        if (candidate.mastery !== null && candidate.mastery >= MASTERED_THRESHOLD) continue;
        if (candidate.prerequisites.some(prerequisite => !prerequisite.satisfied)) continue;

        const G = candidate.mastery === null ? 1 : (100 - candidate.mastery) / 100;
        const R = candidate.prerequisites.length === 0
            ? 1
            : candidate.prerequisites.reduce((sum, prerequisite) => sum + prerequisite.mastery / 100, 0) /
                candidate.prerequisites.length;
        const verifiedDate = latestVerifiedUtcDate(candidate.assessmentHistory);
        const daysSinceVerifiedAssessment = verifiedDate === null
            ? null
            : Math.max(0, (asOfDate.getTime() - verifiedDate.getTime()) / MILLISECONDS_PER_DAY);
        const U = daysSinceVerifiedAssessment === null
            ? 0
            : 1 - (2 ** (-daysSinceVerifiedAssessment / HALF_LIFE_DAYS));
        const exposedComponents = { G, R, U };
        const priorityScore = round(
            100 * (0.55 * exposedComponents.G + 0.30 * exposedComponents.R + 0.15 * exposedComponents.U),
            SCORE_DECIMAL_PLACES
        );
        const satisfiedPrerequisites = candidate.prerequisites.filter(item => item.satisfied).length;
        const averagePrerequisiteMastery = candidate.prerequisites.length === 0
            ? 100
            : candidate.prerequisites.reduce((sum, item) => sum + item.mastery, 0) /
                candidate.prerequisites.length;
        const prerequisiteReadiness = {
            satisfied: true,
            satisfiedCount: satisfiedPrerequisites,
            totalCount: candidate.prerequisites.length,
            averageMastery: averagePrerequisiteMastery,
            prerequisites: candidate.prerequisites.map(item => ({ ...item }))
        };

        const masteryExplanation = candidate.mastery === null
            ? 'Mastery is UNKNOWN, so the candidate receives the full gap component.'
            : `Mastery is ${candidate.mastery.toFixed(4)}%, producing G=${exposedComponents.G}.`;
        const prerequisiteExplanation = candidate.prerequisites.length === 0
            ? 'There are no prerequisites, so R=1.00000000.'
            : `${satisfiedPrerequisites}/${candidate.prerequisites.length} prerequisites satisfy the evidence and 80% gate; average mastery is ${prerequisiteReadiness.averageMastery}%, so R=${exposedComponents.R}.`;
        const urgencyExplanation = verifiedDate === null
            ? 'No verified UTC assessment date is available, so U=0.'
            : `The most recent verified UTC assessment was ${verifiedDate.toISOString()} (${daysSinceVerifiedAssessment.toFixed(4)} days ago), so U=${exposedComponents.U}.`;
        const explanation = `${masteryExplanation} ${prerequisiteExplanation} ${urgencyExplanation} Priority score ${priorityScore.toFixed(SCORE_DECIMAL_PLACES)} is calculated as 100 x (0.55G + 0.30R + 0.15U). This score is a ranking priority, not a probability.`;

        ranked.push({
            conceptId: candidate.conceptId,
            conceptName: candidate.conceptName,
            priorityScore,
            mastery: candidate.mastery,
            evidenceStatus: candidate.evidenceStatus,
            G: exposedComponents.G,
            R: exposedComponents.R,
            U: exposedComponents.U,
            prerequisiteReadiness,
            explanation
        });
    }

    ranked.sort((left, right) =>
        right.priorityScore - left.priorityScore || left.conceptId - right.conceptId
    );
    return ranked;
}

module.exports = { rankRecommendations, HALF_LIFE_DAYS, MASTERED_THRESHOLD, PREREQUISITE_THRESHOLD };
