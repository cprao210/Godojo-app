import { MeetingType, ScorecardConfig, ScoringCriteriaSettings, CustomScorecardConfig, CustomCategoryConfig } from "@/types";

export function cn(...classes: (string | undefined)[]) {
  return classes.filter(Boolean).join(" ")
}

/**
 * Classifies a raw LLM-provider error string (thrown from
 * LLMHelper.generateMeetingSummary, surfaced via the regenerate-summary IPC
 * call) into a short machine-readable reason for PostHog and a human-readable
 * message for the UI. Provider error text varies (Gemini's SDK throws things
 * like "429 RESOURCE_EXHAUSTED...", Groq's throws "rate_limit_exceeded" /
 * "on tokens per minute (TPM)..."), so this matches on substrings rather than
 * a fixed error shape.
 */
export function classifyLLMError(rawError: string | undefined | null): { reason: string; message: string } {
  const text = (rawError ?? '').toLowerCase();

  const isGemini = text.includes('gemini') || text.includes('resource_exhausted') || text.includes('generativelanguage');
  const isGroq = text.includes('groq');
  const isRateLimited = text.includes('429') || text.includes('rate_limit') || text.includes('rate limit')
    || text.includes('quota') || text.includes('resource_exhausted') || text.includes('exceeded');

  if (isGemini && isRateLimited) {
    return { reason: 'gemini_key_exhausted', message: 'The Gemini API key has hit its usage limit. Try again later, or check your API key/billing in Settings.' };
  }
  if (isGroq && isRateLimited) {
    return { reason: 'groq_rate_limited', message: 'The Groq rate limit was exceeded. Please wait a moment and try again.' };
  }
  if (isRateLimited) {
    return { reason: 'provider_rate_limited', message: 'The AI provider\u2019s usage limit was reached. Please wait a moment and try again.' };
  }
  if (text.includes('timeout') || text.includes('timed out')) {
    return { reason: 'provider_timeout', message: 'The request timed out while regenerating the summary. Please try again.' };
  }
  if (!text) {
    return { reason: 'unknown', message: 'Something went wrong while regenerating the summary. Please try again.' };
  }
  return { reason: 'provider_error', message: 'Failed to regenerate the summary — the AI provider returned an error. Please try again.' };
}

export const SCORECARD_CONFIGS: ScorecardConfig[] = [
  {
    meetingType: 'discovery',
    label: 'Discovery',
    color: '#a78bfa',
    categories: [
      {
        key: 'meddic',
        label: 'MEDDIC',
        weight: 40,
        checkpoints: [
          'Metrics: business impact and ROI quantified',
          'Economic Buyer: identified and engaged',
          'Decision Criteria: understood and documented',
          'Decision Process: mapped and confirmed',
          'Identify Pain: root cause and urgency explored',
          'Champion: identified and mobilised',
        ],
      },
      {
        key: 'bant',
        label: 'BANT',
        weight: 30,
        checkpoints: [
          'Budget: confirmed or range established',
          'Authority: decision maker identified',
          'Need: pain clearly confirmed',
          'Timeline: deadline or urgency established',
        ],
      },
      {
        key: 'objection_handling',
        label: 'Objection Handling',
        weight: 30,
        checkpoints: [
          'Objections surfaced and acknowledged',
          'Root cause of objection explored',
          'Evidence or reframe provided',
          'Buyer acceptance confirmed',
          'Objection resolved or deferred with plan',
        ],
      },
    ],
  },
  {
    meetingType: 'demo',
    label: 'Demo',
    color: '#34d399',
    categories: [
      {
        key: 'prep_and_alignment',
        label: 'Preparation & Alignment',
        weight: 10,
        checkpoints: [
          'Discovery recapped',
          'Pain points restated',
          'Priorities confirmed',
          'Success criteria confirmed',
          'Stakeholders acknowledged',
          'Agenda established',
          'Introduction completed',
          'Expectations set',
        ],
      },
      {
        key: 'personalization',
        label: 'Personalization',
        weight: 20,
        checkpoints: [
          'Pain points connected to demo',
          'Outcomes explained',
          'Industry examples used',
          'Persona-specific examples used',
          'Customer terminology used',
          'Relevant workflows demonstrated',
        ],
      },
      {
        key: 'value_creation',
        label: 'Value Creation',
        weight: 20,
        checkpoints: [
          'Business impact discussed',
          'ROI discussed',
          'Pain quantified',
          'Cost of inaction discussed',
          'Urgency created',
          'Revenue impact discussed',
          'Efficiency impact discussed',
          'Outcomes tied back to buyer problems',
        ],
      },
      {
        key: 'buyer_engagement',
        label: 'Buyer Engagement',
        weight: 10,
        checkpoints: [
          'Talk/listen ratio balanced',
          'Buyer participation encouraged',
          'Buyer questions welcomed',
          'Positive/negative reactions addressed',
        ],
      },
      {
        key: 'buying_intent',
        label: 'Buying Intent Signals',
        weight: 10,
        checkpoints: [
          'Positive buyer statements noted',
          'Implementation questions surfaced',
          'Pricing questions addressed',
          'Security/procurement questions handled',
          'Integration/rollout questions explored',
        ],
      },
      {
        key: 'objection_handling',
        label: 'Objection Handling',
        weight: 10,
        checkpoints: [
          'Objections acknowledged',
          'Root cause identified',
          'Evidence provided',
          'Buyer acceptance verified',
          'Objections resolved or deferred',
        ],
      },
      {
        key: 'competitive_positioning',
        label: 'Competitive Positioning',
        weight: 5,
        checkpoints: [
          'Competitors discussed',
          'Differentiators highlighted',
          'Value-based positioning used',
          'Competitor weakness linked to buyer pain',
        ],
      },
      {
        key: 'execution_quality',
        label: 'Demo Execution Quality',
        weight: 5,
        checkpoints: [
          'Navigation quality smooth',
          'Pacing appropriate',
          'Confidence and tonality strong',
          'Time management effective',
        ],
      },
      {
        key: 'commercial_progression',
        label: 'Commercial Progression',
        weight: 10,
        checkpoints: [
          'Next steps agreed',
          'Timeline discussed',
          'Stakeholders added',
          'Commitment secured',
          'Buying process discussed',
        ],
      },
    ],
  },
  {
    meetingType: 'negotiation',
    label: 'Negotiation',
    color: '#fbbf24',
    categories: [
      {
        key: 'preparation',
        label: 'Preparation',
        weight: 20,
        checkpoints: [
          'Buying process understood',
          'Decision maker confirmed',
          'Procurement/Finance/IT identified',
          'Competition discussed',
          'Budget understood',
          'Timeline confirmed',
        ],
      },
      {
        key: 'value_reinforcement',
        label: 'Value Reinforcement',
        weight: 20,
        checkpoints: [
          'Business impact restated',
          'Pricing tied to pain',
          'ROI discussed',
          'Cost of inaction discussed',
          'Investment justified before discounting',
        ],
      },
      {
        key: 'discount_management',
        label: 'Discount Management',
        weight: 20,
        checkpoints: [
          'Value defended before discounting',
          'Concession received in return for discount',
          'Approval process discussed',
          'Discount not given away freely',
        ],
      },
      {
        key: 'competitive_positioning',
        label: 'Competitive Positioning',
        weight: 20,
        checkpoints: [
          'Competitors mentioned and addressed',
          'Differentiators highlighted',
          'Outcome-focused discussion',
          'Competitive positioning handled effectively',
        ],
      },
      {
        key: 'commitment_and_closing',
        label: 'Commitment & Closing',
        weight: 20,
        checkpoints: [
          'Verbal commitment secured',
          'Clear next step agreed',
          'Signature timeline discussed',
          'Remaining blockers identified',
          'Mutual Action Plan referenced',
        ],
      },
    ],
  },
];

/**
 * Merge user-defined criteria with the built-in defaults.
 * Returns the custom config if it's enabled and has at least one category,
 * otherwise falls back to the built-in SCORECARD_CONFIGS entry.
 */
export function resolveEffectiveScorecardConfig(
  meetingType: MeetingType,
  customSettings: ScoringCriteriaSettings | null,
): ScorecardConfig {
  const builtIn = SCORECARD_CONFIGS.find(c => c.meetingType === meetingType)!;
  if (!customSettings) return builtIn;

  const custom = customSettings.configs.find((c: CustomScorecardConfig) => c.meetingType === meetingType);
  if (!custom || !custom.enabled || custom.categories.length === 0) return builtIn;

  return {
    meetingType: custom.meetingType,
    label: builtIn.label,
    color: builtIn.color,
    categories: custom.categories.map((cat: CustomCategoryConfig) => ({
      key: cat.key,
      label: cat.label,
      weight: cat.weight,
      checkpoints: cat.checkpoints,
    })),
  };
}

export function getConfigForType(type: MeetingType): ScorecardConfig | undefined {
  return SCORECARD_CONFIGS.find(c => c.meetingType === type);
}