// Cross-checks a generated meeting summary against the source transcript and
// returns a 0-100 grounding confidence score plus specific unsupported /
// hallucinated fields. Used by MeetingPersistence to decide whether to
// accept a generated summary or regenerate it with targeted corrections.

import { LLMHelper } from "../LLMHelper";
import { SUMMARY_VERIFICATION_PROMPT } from "./prompts";

export interface SummaryVerificationIssue {
    field: string;
    problem: string;
    quote_or_evidence?: string;
}

export interface SummaryVerificationResult {
    confidence: number; // 0-100
    issues: SummaryVerificationIssue[];
}

/**
 * Verify a generated summary JSON string against the raw transcript text.
 * Uses LLMHelper.generateContentStructured, which already has multi-provider
 * fallback (OpenAI -> Gemini Pro -> Gemini Flash -> Claude -> Groq -> Ollama),
 * so the verification step doesn't become a new single point of failure.
 *
 * Fails OPEN on verifier errors (parse failure, all providers down): returns
 * a neutral mid-range score rather than throwing, so a verifier outage can't
 * crash meeting save. The caller's retry loop still has a hard attempt cap,
 * so this can't cause an infinite regeneration loop either.
 */
export async function verifySummaryAgainstTranscript(
    llmHelper: LLMHelper,
    transcript: string,
    summaryJson: string,
): Promise<SummaryVerificationResult> {
    // Cap transcript length passed to the verifier — it only needs enough to
    // check grounding, and this keeps the check cheap/fast relative to the
    // (much more expensive) full generation call.
    const MAX_TRANSCRIPT_CHARS = 20000;
    const trimmedTranscript = transcript.length > MAX_TRANSCRIPT_CHARS
        ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n[...transcript truncated for verification...]"
        : transcript;

    const message = `${SUMMARY_VERIFICATION_PROMPT}

ORIGINAL TRANSCRIPT:
${trimmedTranscript}

GENERATED SUMMARY (JSON):
${summaryJson}`;

    try {
        const raw = await llmHelper.generateContentStructured(message);
        const jsonMatch = raw.match(/```json\n([\s\S]*?)\n```/) || [null, raw];
        const jsonStr = (jsonMatch[1] || raw).trim();
        const parsed = JSON.parse(jsonStr);

        const confidence = typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(100, parsed.confidence))
            : 0;
        const issues: SummaryVerificationIssue[] = Array.isArray(parsed.issues)
            ? parsed.issues.filter((i: any) => i && typeof i.field === "string")
            : [];

        return { confidence, issues };
    } catch (e: any) {
        console.error("[SummaryVerifier] Verification call failed, treating as inconclusive:", e.message);
        return {
            confidence: 50,
            issues: [{ field: "verifier", problem: `Verification call failed: ${e.message}` }],
        };
    }
}

/**
 * Turn verification issues into a prompt addendum instructing the model to
 * fix the specific flagged fields on the next generation attempt, rather
 * than just re-rolling and hoping for a better outcome.
 */
export function buildCorrectionAddendum(issues: SummaryVerificationIssue[]): string {
    if (!issues.length) return "";
    const lines = issues
        .map(i => `- ${i.field}: ${i.problem}${i.quote_or_evidence ? ` (closest transcript evidence: "${i.quote_or_evidence}")` : ""}`)
        .join("\n");
    return `

IMPORTANT — CORRECTIONS REQUIRED FROM PREVIOUS ATTEMPT:
Your previous attempt at this summary contained unsupported or fabricated claims, listed below. Regenerate the full summary, fixing each of these. If the transcript genuinely doesn't support a field, mark it "Missing"/null/empty rather than inventing something — do not guess:
${lines}`;
}