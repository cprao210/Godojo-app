// ─── Scorecard Prompt Builder ─────────────────────────────────────────────────
// Generates the LLM prompt for multi-type meeting scorecard analysis.
// Called from MeetingPersistence.ts after transcript is available.

import { MeetingType, CategoryConfig, ScoringCriteriaSettings, LiveAnalysisData } from '../../src/types';
import { resolveEffectiveScorecardConfig } from "../../src/lib/utils"

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
    const catKeys = cfg.categories.map((c: any) => buildCategoryBlock(c)).join(',\n');
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

// ── Live-analysis grounding ───────────────────────────────────────────────────
// The Call Analysis tab is the single source of truth for MEDDIC, BANT,
// objections and signals. Feeding it to the scorecard prompt stops the model
// from forming a second, contradictory opinion of the same frameworks. The
// deterministic backstop lives in electron/scorecardReconciliation.ts — this
// block exists so the *narrative* fields (reasoning, coaching) are grounded
// too, not just the numbers the backstop overwrites.
const CAP = 180;
const clip = (s: string | undefined): string => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > CAP ? `${t.slice(0, CAP)}…` : t;
};

function buildGroundingBlock(live: LiveAnalysisData | null): string {
    if (!live) return '';

    const fieldLines = (
        entries: [string, { status?: string; evidence?: string } | undefined][]
    ) => entries
        .map(([label, f]) => `          - ${label}: ${f?.status || 'missing'}${clip(f?.evidence) ? ` — "${clip(f?.evidence)}"` : ''}`)
        .join('\n');

    const bant = fieldLines([
        ['Budget', live.bant?.budget], ['Authority', live.bant?.authority],
        ['Need', live.bant?.need], ['Timeline', live.bant?.timeline],
    ]);
    const meddic = fieldLines([
        ['Metrics', live.meddic?.metrics], ['Economic Buyer', live.meddic?.economic_buyer],
        ['Decision Criteria', live.meddic?.decision_criteria], ['Decision Process', live.meddic?.decision_process],
        ['Identify Pain', live.meddic?.identify_pain], ['Champion', live.meddic?.champion],
        ['Competition', live.meddic?.competition],
    ]);

    const objections = (live.objections ?? []).slice(0, 12);
    const objectionLines = objections.length
        ? objections.map(o => `          - [${o.resolved ? 'resolved' : o.status === 'deferred' ? 'deferred' : 'open'}] "${clip(o.quote)}"`).join('\n')
        : '          - NONE: no objections were raised on this call.';

    const signals = (live.signals ?? []).slice(0, 12);
    const signalLines = signals.length
        ? signals.map(s => `          - [${s.category || 'neutral'}] "${clip(s.quote)}"`).join('\n')
        : '          - NONE: no buying/risk signals were captured on this call.';

    return `
        CALL ANALYSIS (AUTHORITATIVE — captured live during the call):
        This is the assessment the user already sees in the Call Analysis tab. It
        overrides your own reading of the transcript. Do NOT re-qualify these
        frameworks yourself and do NOT contradict a status below.
        BANT:
${bant}
        MEDDIC:
${meddic}
        OBJECTIONS TRACKED:
${objectionLines}
        SIGNALS CAPTURED:
${signalLines}
        Scoring these: confirmed = full marks for that component, partial = half,
        missing = zero. Objection handling scores off the list above only —
        "NONE" means zero, not a pass. Buying-intent scores off the positive
        signals above only. Quote the evidence above rather than hunting for
        your own.
`;
}

export function buildScorecardPrompt(
    customSettings: ScoringCriteriaSettings | null = null,
    hintMeetingTypes: ('discovery' | 'demo' | 'negotiation')[] | null = null,
    liveAnalysis: LiveAnalysisData | null = null
): string {
    const allBlocks = (['discovery', 'demo', 'negotiation'] as MeetingType[])
        .map(t => buildScorecardBlock(t, customSettings))
        .join(',\n');

    const categoryDocs = (['discovery', 'demo', 'negotiation'] as MeetingType[]).map(type => {
        const cfg = resolveEffectiveScorecardConfig(type, customSettings);
        const cats = cfg.categories.map((c: any) => {
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
${buildGroundingBlock(liveAnalysis)}
        RULES:
        - Only score meeting types you detected (or were pre-selected)
        - Use direct transcript quotes as evidence wherever possible
        - Never fabricate evidence — if not in transcript, score 0 for that checkpoint${liveAnalysis ? `
        - The CALL ANALYSIS block above is authoritative for MEDDIC, BANT, objections and signals. Score those categories from it, reuse its evidence, and never assert something it marks "missing" was covered (or vice versa)` : ''}
        - Before assigning any score above 0 for a checkpoint, you must be able to cite a CLIENT quote (not just a REP question) that substantively satisfies it. If the only relevant line is the rep asking or a client deflection/non-answer, score that checkpoint 0.
        - overallScore = weighted average of category scores (score/maxScore * weight), summed
        - Keep coaching recommendations specific and actionable (not generic)
        ${hintMeetingTypes && hintMeetingTypes.length > 0
            ? `- The user pre-selected the meeting type(s) for this call — every one of them MUST appear in "detectedTypes" and have a corresponding entry in "scorecards", with confidenceScore fixed at 95, even if transcript evidence is thin. Weak evidence should pull individual category/checkpoint scores toward 0, NOT cause the whole type to be omitted. Do not apply the confidenceScore<50 omission rule below to a pre-selected type — that rule only applies to types you detect yourself beyond the pre-selected list.`
            : `- confidenceScore: 90–100 = very clear, 70–89 = likely, 50–69 = some evidence, <50 = skip this type
        - Omit any meeting type with confidenceScore < 50`}
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