// electron/llm/index.ts
// Central export for all LLM modules

export { AnswerLLM } from "./AnswerLLM";
export { AssistLLM } from "./AssistLLM";
export { ClarifyLLM } from "./ClarifyLLM";
export { FollowUpLLM } from "./FollowUpLLM";
export { FollowUpQuestionsLLM } from "./FollowUpQuestionsLLM";
export { RecapLLM } from "./RecapLLM";
export { WhatToAnswerLLM } from "./WhatToAnswerLLM";
export { WhatAmIMissingLLM } from "./WhatAmIMissing"; // WHAT AM I MISSING
export { DiscoveryLLM } from "./DiscoveryLLM"; // DISCOVERY MODE
export { ObjectionHandlerLLM } from "./ObjectionHandlerLLM"; // OBJECTION HANDLER MODE
export {
    verifySummaryAgainstTranscript,
    buildCorrectionAddendum
} from "./SummaryVerifier";
export type { SummaryVerificationIssue, SummaryVerificationResult } from "./SummaryVerifier";
export {
    cleanTranscript,
    sparsifyTranscript,
    formatTranscriptForLLM,
    prepareTranscriptForWhatToAnswer
} from "./transcriptCleaner";
export type { TranscriptTurn } from "./transcriptCleaner";
export {
    buildTemporalContext,
    formatTemporalContextForPrompt
} from "./TemporalContextBuilder";
export type { TemporalContext, AssistantResponse } from "./TemporalContextBuilder";
export {
    classifyIntent,
    getAnswerShapeGuidance,
    warmupIntentClassifier
} from "./IntentClassifier";
export type { ConversationIntent, IntentResult } from "./IntentClassifier";
export type { GenerationConfig, GeminiContent } from "./types";
export {
    HARD_SYSTEM_PROMPT,
    ASSIST_MODE_PROMPT,
    WHAT_AM_I_MISSING_PROMPT, // WHAT AM I MISSING
    GROQ_TITLE_PROMPT,
    GROQ_SUMMARY_JSON_PROMPT,
    FOLLOWUP_EMAIL_PROMPT,
    GROQ_FOLLOWUP_EMAIL_PROMPT,
    SUMMARY_VERIFICATION_PROMPT
} from "./prompts";
export { buildSummaryPrompt, buildCoachCallTypeSection } from "./summaryPrompt";