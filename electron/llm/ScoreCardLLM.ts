// ─── Scorecard Prompt Builder ─────────────────────────────────────────────────
// Generates the LLM prompt for multi-type meeting scorecard analysis.
// Called from MeetingPersistence.ts after transcript is available.

import {
    MeetingType,
    CategoryConfig,
    ScoringCriteriaSettings,
    resolveEffectiveScorecardConfig,
} from '../../src/types/score-card';

function buildCategoryBlock(cat: CategoryConfig): string {
    return `    "${cat.key}": {
      "categoryName": "${cat.label}",
      "score": <0–${cat.weight}>,
      "maxScore": ${cat.weight},
      "weight": ${cat.weight},
      "reasoning": "<concise explanation based on transcript evidence>",
      "transcriptEvidence": ["REP: <exact or near-exact quote from the sales rep>", "CLIENT: <exact or near-exact quote from the prospect/client>", ...],
      "strengths": ["<what was done well>", ...],
      "improvementAreas": ["<specific coaching point>", ...]
    }`;
}

function buildScorecardBlock(type: MeetingType, customSettings: ScoringCriteriaSettings | null): string {
    const cfg = resolveEffectiveScorecardConfig(type, customSettings);
    if (!cfg) return '';
    const catKeys = cfg.categories.map(c => buildCategoryBlock(c)).join(',\n');
    return `  "${type}": {
    "meetingType": "${type}",
    "overallScore": <0–100 weighted>,
    "confidenceScore": <0–100, how confident you are this type applies>,
    "detectedReason": "<one sentence: why you detected this meeting type>",
    "categoryBreakdown": {
        ${catKeys}
    },
    "topStrengths": ["<strength 1>", "<strength 2>", "<strength 3>"],
    "coachingRecommendations": ["<actionable coaching point>", ...]
  }`;
}

export function buildScorecardPrompt(
    customSettings: ScoringCriteriaSettings | null = null,
    hintMeetingTypes: ('discovery' | 'demo' | 'negotiation')[] | null = null
): string {
    const allBlocks = (['discovery', 'demo', 'negotiation'] as MeetingType[])
        .map(t => buildScorecardBlock(t, customSettings))
        .join(',\n');

    const categoryDocs = (['discovery', 'demo', 'negotiation'] as MeetingType[]).map(type => {
        const cfg = resolveEffectiveScorecardConfig(type, customSettings);
        const cats = cfg.categories.map(c => {
            const checkpointLine = c.checkpoints.length
                ? `Checkpoints: ${c.checkpoints.join(', ')}`
                : 'No specific checkpoints defined — use judgment.';
            return `    - ${c.label} (weight: ${c.weight}%)\n      ${checkpointLine}`;
        }).join('\n');
        return `${cfg.label?.toUpperCase() ?? type.toUpperCase()} MEETING CATEGORIES:\n${cats}`;
    }).join('\n\n');

    // If the user explicitly told us the meeting types, skip auto-detection
    const detectionBlock = hintMeetingTypes && hintMeetingTypes.length > 0
        ? `STEP 1 — MEETING TYPES (PRE-SELECTED BY USER)
        The user has already identified this call as: ${hintMeetingTypes.map(t => `"${t}"`).join(', ')}.
        Score ONLY these types. Do not detect or add additional types.
        Set confidenceScore to 95 for each pre-selected type.`
        : `STEP 1 — DETECT MEETING TYPES
        Determine which meeting types are present. A call may contain multiple types.
        Types: discovery, demo, negotiation
        Only include types with clear evidence in the transcript.`;

    return `You are an expert sales coach. Analyze the sales call transcript and generate a structured Meeting Scorecard.

        ${detectionBlock}

        STEP 2 — SCORE EACH DETECTED TYPE
        For each detected meeting type, score every category based on transcript evidence.
        Score = points earned out of maxScore (weight). Use evidence-based reasoning.

        SCORING SCALE (apply per checkpoint within a category, then combine):
        - Full marks: Checkpoint is clearly confirmed by the CLIENT's own words — not just asked about
        - Partial (50–80%): Checkpoint was substantively answered but is incomplete, vague, or not yet confirmed by the client (e.g. rep gave a price range but client did not confirm budget fit)
        - Minimal (1–49%): Checkpoint was raised but the client deflected, gave a non-answer, or gave a soft no (e.g. "it depends", "not really", "timing might not be great") — being merely asked about is NOT evidence it was met
        - Zero: Not raised, or raised and explicitly declined/unanswered

        A category's score must reflect how many of its checkpoints were actually confirmed by the client, not how many the rep attempted to cover. Do not average toward the middle by default — most real calls should score low on categories where the client gave no real information.

        ${categoryDocs}

        RULES:
        - Only score meeting types you detected (or were pre-selected)
        - Use direct transcript quotes as evidence wherever possible
        - Never fabricate evidence — if not in transcript, score 0 for that checkpoint
        - Before assigning any score above 0 for a checkpoint, you must be able to cite a CLIENT quote (not just a REP question) that substantively satisfies it. If the only relevant line is the rep asking or a client deflection/non-answer, score that checkpoint 0.
        - overallScore = weighted average of category scores (score/maxScore * weight), summed
        - Keep coaching recommendations specific and actionable (not generic)
        - confidenceScore: 90–100 = very clear, 70–89 = likely, 50–69 = some evidence, <50 = skip this type
        - Omit any meeting type with confidenceScore < 50
        - Prefix every transcriptEvidence entry with the speaker role: "REP: <quote>" for the sales rep, "CLIENT: <quote>" for the prospect/client

        OUTPUT FORMAT:
        Return ONLY a valid JSON object — no markdown fences, no explanation.

        {
            "detectedTypes": ["discovery", "demo", "negotiation"],
            "overallWeightedScore": <0–100>,
            "scorecards": {
                ${allBlocks}
            }
        }

        If a meeting type is NOT detected, omit it entirely from "scorecards".
        "detectedTypes" lists only the types present.
        "overallWeightedScore" is the average of all scorecard overallScores, weighted by confidenceScore.`;
}