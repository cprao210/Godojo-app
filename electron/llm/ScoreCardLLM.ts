// ─── Scorecard Prompt Builder ─────────────────────────────────────────────────
// Generates the LLM prompt for multi-type meeting scorecard analysis.
// Called from MeetingPersistence.ts after transcript is available.

import { SCORECARD_CONFIGS, MeetingType, CategoryConfig } from '../../src/types/score-card';

function buildCategoryBlock(cat: CategoryConfig): string {
    return `    "${cat.key}": {
      "categoryName": "${cat.label}",
      "score": <0–${cat.weight}>,
      "maxScore": ${cat.weight},
      "weight": ${cat.weight},
      "reasoning": "<concise explanation based on transcript evidence>",
      "transcriptEvidence": ["<exact or near-exact quote>", ...],
      "strengths": ["<what was done well>", ...],
      "improvementAreas": ["<specific coaching point>", ...]
    }`;
}

function buildScorecardBlock(type: MeetingType): string {
    const cfg = SCORECARD_CONFIGS.find(c => c.meetingType === type);
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

export function buildScorecardPrompt(): string {
    const allBlocks = (['discovery', 'demo', 'negotiation'] as MeetingType[])
        .map(t => buildScorecardBlock(t))
        .join(',\n');

    const categoryDocs = SCORECARD_CONFIGS.map(cfg => {
        const cats = cfg.categories.map(c =>
            `    - ${c.label} (weight: ${c.weight}%)\n      Checkpoints: ${c.checkpoints.join(', ')}`
        ).join('\n');
        return `${cfg.label.toUpperCase()} MEETING CATEGORIES:\n${cats}`;
    }).join('\n\n');

    return `You are an expert sales coach. Analyze the sales call transcript and generate a structured Meeting Scorecard.

        STEP 1 — DETECT MEETING TYPES
        Determine which meeting types are present. A call may contain multiple types.
        Types: discovery, demo, negotiation
        Only include types with clear evidence in the transcript.

        STEP 2 — SCORE EACH DETECTED TYPE
        For each detected meeting type, score every category based on transcript evidence.
        Score = points earned out of maxScore (weight). Use evidence-based reasoning.

        SCORING SCALE:
        - Full marks: Criterion clearly met with strong evidence
        - Partial (50–80%): Attempted but incomplete or weak
        - Minimal (1–49%): Barely touched
        - Zero: Not present at all

        ${categoryDocs}

        RULES:
        - Only score meeting types you detected
        - Use direct transcript quotes as evidence wherever possible
        - Never fabricate evidence — if not in transcript, score 0 for that checkpoint
        - overallScore = weighted average of category scores (score/maxScore * weight), summed
        - Keep coaching recommendations specific and actionable (not generic)
        - confidenceScore: 90–100 = very clear, 70–89 = likely, 50–69 = some evidence, <50 = skip this type
        - Omit any meeting type with confidenceScore < 50

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