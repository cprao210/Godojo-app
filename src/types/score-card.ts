// ─── Meeting Scorecard Types ──────────────────────────────────────────────────
// Centralized, extensible scoring configuration.
// Add new meeting types here without touching UI components.

export type MeetingType = 'discovery' | 'demo' | 'negotiation';

// ── Per-category output from LLM ─────────────────────────────────────────────
export interface ScoredCategory {
    categoryName: string;
    score: number;          // 0–maxScore
    maxScore: number;
    weight: number;         // 0–100 (percentage weight of this category)
    reasoning: string;
    transcriptEvidence: string[];
    strengths: string[];
    improvementAreas: string[];
}

// ── Per-meeting-type scorecard ────────────────────────────────────────────────
export interface MeetingScorecard {
    meetingType: MeetingType;
    overallScore: number;          // 0–100 weighted
    confidenceScore: number;       // 0–100, how confident LLM is this type applies
    detectedReason: string;        // Why this type was detected
    categoryBreakdown: ScoredCategory[];
    topStrengths: string[];
    coachingRecommendations: string[];
}

// ── Top-level wrapper (supports multi-type meetings) ─────────────────────────
export interface MeetingScorecardResult {
    scorecards: MeetingScorecard[];
    overallWeightedScore: number;  // cross-type weighted average
    detectedTypes: MeetingType[];
}

// ─── Scoring configuration (centralized) ─────────────────────────────────────
// Extend this to add future meeting types — no UI component changes needed.

export interface CategoryConfig {
    key: string;
    label: string;
    weight: number; // must sum to 100 per scorecard type
    checkpoints: string[];
}

export interface ScorecardConfig {
    meetingType: MeetingType;
    label: string;
    color: string;
    categories: CategoryConfig[];
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

export function getConfigForType(type: MeetingType): ScorecardConfig | undefined {
    return SCORECARD_CONFIGS.find(c => c.meetingType === type);
}