
'use strict';

const {
    createRecommendationService,
    RecommendationServiceError
} = require('./recommendationService');

const COURSE_ID_PATTERN =
    /^COURSE-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PREREQUISITE_THRESHOLD = 80;
const QUALIFIED_EVIDENCE_STATUS = 'EVIDENCE_QUALIFIED';

class ConceptAccessError extends Error {
    constructor(code, message, status = 503, cause = null) {
        super(message);
        this.name = 'ConceptAccessError';
        this.code = code;
        this.status = status;
        if (cause) this.cause = cause;
    }
}

function validateLearnerId(value) {
    const learnerId = Number(value);

    if (!Number.isSafeInteger(learnerId) || learnerId < 1) {
        throw new ConceptAccessError(
            'INVALID_LEARNER_ID',
            'A valid learner ID is required.',
            400
        );
    }

    return learnerId;
}

function validateCourseId(value) {
    if (typeof value !== 'string' || !COURSE_ID_PATTERN.test(value)) {
        throw new ConceptAccessError(
            'INVALID_COURSE_ID',
            'A valid course ID is required.',
            400
        );
    }

    return value;
}

function validateConceptId(value) {
    const conceptId = typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : value;

    if (!Number.isSafeInteger(conceptId) || conceptId < 1) {
        throw new ConceptAccessError(
            'INVALID_CONCEPT_ID',
            'A valid concept ID is required.',
            400
        );
    }

    return conceptId;
}

function validateMastery(value, conceptName) {
    if (value === null) return null;

    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 100
    ) {
        throw new ConceptAccessError(
            'INVALID_PROGRESS_DATA',
            `Mastery data for ${conceptName} is invalid.`
        );
    }

    return value;
}

function validateEvidenceStatus(value, conceptName) {
    if (!['UNKNOWN', 'PROVISIONAL', 'EVIDENCE_QUALIFIED'].includes(value)) {
        throw new ConceptAccessError(
            'INVALID_PROGRESS_DATA',
            `Evidence status for ${conceptName} is invalid.`
        );
    }

    return value;
}

function isPrerequisiteSatisfied(prerequisite) {
    return prerequisite.evidenceStatus === QUALIFIED_EVIDENCE_STATUS &&
        prerequisite.mastery !== null &&
        prerequisite.mastery >= PREREQUISITE_THRESHOLD;
}

function describePrerequisiteBlock(prerequisite) {
    if (
        prerequisite.mastery === null ||
        prerequisite.evidenceStatus === 'UNKNOWN'
    ) {
        return {
            reason: 'ASSESSMENT_REQUIRED',
            message: `Complete assessments for ${prerequisite.conceptName} before continuing.`
        };
    }

    if (prerequisite.mastery < PREREQUISITE_THRESHOLD) {
        return {
            reason: 'REVISION_REQUIRED',
            message: `Revise ${prerequisite.conceptName} and reach at least ${PREREQUISITE_THRESHOLD}% mastery.`
        };
    }

    if (prerequisite.evidenceStatus !== QUALIFIED_EVIDENCE_STATUS) {
        return {
            reason: 'MORE_EVIDENCE_REQUIRED',
            message: `Complete another assessment for ${prerequisite.conceptName} to confirm your mastery.`
        };
    }

    return {
        reason: 'PREREQUISITE_NOT_SATISFIED',
        message: `Complete the prerequisite requirements for ${prerequisite.conceptName}.`
    };
}

function normalizePrerequisite(prerequisite, conceptName) {
    if (
        !prerequisite ||
        !Number.isSafeInteger(prerequisite.conceptId) ||
        prerequisite.conceptId < 1 ||
        typeof prerequisite.conceptName !== 'string' ||
        !prerequisite.conceptName.trim()
    ) {
        throw new ConceptAccessError(
            'INVALID_PROGRESS_DATA',
            `Prerequisite data for ${conceptName} is invalid.`
        );
    }

    const mastery = validateMastery(
        prerequisite.mastery,
        prerequisite.conceptName
    );

    const evidenceStatus = validateEvidenceStatus(
        prerequisite.evidenceStatus,
        prerequisite.conceptName
    );

    if (
        (mastery === null && evidenceStatus !== 'UNKNOWN') ||
        (mastery !== null && evidenceStatus === 'UNKNOWN')
    ) {
        throw new ConceptAccessError(
            'INVALID_PROGRESS_DATA',
            `Evidence data for ${prerequisite.conceptName} is inconsistent.`
        );
    }

    return {
        conceptId: prerequisite.conceptId,
        conceptName: prerequisite.conceptName.trim(),
        mastery,
        evidenceStatus,
        satisfied: isPrerequisiteSatisfied({ mastery, evidenceStatus })
    };
}

function createConceptAccessService({
    recommendationService: injectedRecommendationService = null
} = {}) {
    const recommendationService =
        injectedRecommendationService || createRecommendationService();

    if (
        !recommendationService ||
        typeof recommendationService.getRecommendationResultForLearner !== 'function'
    ) {
        throw new TypeError(
            'A recommendation service with getRecommendationResultForLearner is required.'
        );
    }

    async function getCourseConceptAccessForLearner({
        learnerId,
        courseId,
        recommendationResult: suppliedRecommendationResult = null
    } = {}) {
        const numericLearnerId = validateLearnerId(learnerId);
        const validCourseId = validateCourseId(courseId);

        let result = suppliedRecommendationResult;

        if (result === null) {
            try {
                result = await recommendationService.getRecommendationResultForLearner({
                    learnerId: numericLearnerId,
                    courseId: validCourseId
                });
            } catch (error) {
                if (error instanceof RecommendationServiceError) throw error;

                throw new ConceptAccessError(
                    'CONCEPT_ACCESS_UNAVAILABLE',
                    'Concept access information could not be loaded.',
                    503,
                    error
                );
            }
        }

        if (
            !result ||
            !Array.isArray(result.concepts) ||
            !result.coursePrerequisiteEligibility ||
            typeof result.coursePrerequisiteEligibility.eligible !== 'boolean' ||
            !Array.isArray(result.coursePrerequisiteEligibility.prerequisites)
        ) {
            throw new ConceptAccessError(
                'INVALID_PROGRESS_DATA',
                'The recommendation service returned incomplete progression data.'
            );
        }

        const coursePrerequisites = result.coursePrerequisiteEligibility.prerequisites.map(item => {
            if (
                !item ||
                !Number.isSafeInteger(item.courseId) ||
                item.courseId < 1 ||
                typeof item.title !== 'string' ||
                typeof item.satisfied !== 'boolean'
            ) {
                throw new ConceptAccessError(
                    'INVALID_PROGRESS_DATA',
                    'Course prerequisite information is invalid.'
                );
            }

            return {
                courseId: item.courseId,
                title: item.title,
                satisfied: item.satisfied
            };
        });

        const courseEligible = result.coursePrerequisiteEligibility.eligible;
        const seenConceptIds = new Set();

        const concepts = result.concepts.map(concept => {
            if (
                !concept ||
                !Number.isSafeInteger(concept.conceptId) ||
                concept.conceptId < 1 ||
                typeof concept.conceptName !== 'string' ||
                !concept.conceptName.trim() ||
                !Array.isArray(concept.prerequisites)
            ) {
                throw new ConceptAccessError(
                    'INVALID_PROGRESS_DATA',
                    'Concept progression information is invalid.'
                );
            }

            if (seenConceptIds.has(concept.conceptId)) {
                throw new ConceptAccessError(
                    'INVALID_PROGRESS_DATA',
                    'Duplicate concepts were returned for the selected course.'
                );
            }

            seenConceptIds.add(concept.conceptId);

            const conceptName = concept.conceptName.trim();
            const mastery = validateMastery(concept.mastery, conceptName);
            const evidenceStatus = validateEvidenceStatus(
                concept.evidenceStatus,
                conceptName
            );

            if (
                (mastery === null && evidenceStatus !== 'UNKNOWN') ||
                (mastery !== null && evidenceStatus === 'UNKNOWN')
            ) {
                throw new ConceptAccessError(
                    'INVALID_PROGRESS_DATA',
                    `Mastery and evidence status for ${conceptName} are inconsistent.`
                );
            }

            if (
                !Number.isSafeInteger(concept.assessmentCount) ||
                concept.assessmentCount < 0
            ) {
                throw new ConceptAccessError(
                    'INVALID_PROGRESS_DATA',
                    `Assessment count for ${conceptName} is invalid.`
                );
            }

            const prerequisites = concept.prerequisites.map(item =>
                normalizePrerequisite(item, conceptName)
            );

            const unsatisfiedPrerequisites = prerequisites.filter(
                item => !item.satisfied
            );

            let accessible = true;
            let status = 'UNLOCKED';
            let reason = null;
            let message = 'This concept is available for learning.';
            let revisionTarget = null;

            if (!courseEligible) {
                accessible = false;
                status = 'LOCKED';
                reason = 'COURSE_PREREQUISITE_REQUIRED';
                message = 'Complete the required prerequisite course before accessing this concept.';
            } else if (unsatisfiedPrerequisites.length > 0) {
                accessible = false;
                status = 'LOCKED';

                const blockingPrerequisite = unsatisfiedPrerequisites[0];
                const block = describePrerequisiteBlock(blockingPrerequisite);

                reason = block.reason;
                message = block.message;

                revisionTarget = {
                    conceptId: blockingPrerequisite.conceptId,
                    conceptName: blockingPrerequisite.conceptName
                };
            }

            return {
                conceptId: concept.conceptId,
                conceptName,
                mastery,
                evidenceStatus,
                assessmentCount: concept.assessmentCount,
                prerequisites,
                accessible,
                status,
                reason,
                message,
                revisionTarget
            };
        });

        return {
            learnerId: numericLearnerId,
            courseId: validCourseId,
            progressionThreshold: PREREQUISITE_THRESHOLD,
            concepts,
            coursePrerequisiteEligibility: {
                eligible: courseEligible,
                prerequisites: coursePrerequisites
            }
        };
    }

    async function getConceptAccessForLearner({
        learnerId,
        courseId,
        conceptId,
        recommendationResult
    } = {}) {
        const validConceptId = validateConceptId(conceptId);

        const progression = await getCourseConceptAccessForLearner({
            learnerId,
            courseId,
            recommendationResult
        });

        const concept = progression.concepts.find(
            item => item.conceptId === validConceptId
        );

        if (!concept) {
            throw new ConceptAccessError(
                'CONCEPT_NOT_FOUND',
                'The requested concept does not belong to the selected course.',
                404
            );
        }

        return {
            ...concept,
            courseId: progression.courseId,
            coursePrerequisiteEligibility:
                progression.coursePrerequisiteEligibility
        };
    }

    return {
        getCourseConceptAccessForLearner,
        getConceptAccessForLearner
    };
}

module.exports = {
    ConceptAccessError,
    createConceptAccessService
};
