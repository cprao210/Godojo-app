/**
 * useMeetingScorecard.ts
 *
 * Small hook backing MeetingScorecardPanel: which meeting-type tab is
 * active when a meeting produced more than one scorecard (e.g. a call that
 * covered both discovery and demo), plus the accent-color / score-label
 * lookups shared by every scorecard sub-component.
 */
import { useState } from 'react';
import type { MeetingType } from '@/types';

// ─── Accent palette per meeting type ─────────────────────────────────────────
const TYPE_ACCENT: Record<MeetingType, { color: string; glow: string; bg: string; border: string; label: string }> = {
    discovery: { color: '#a78bfa', glow: 'rgba(167,139,250,0.25)', bg: 'rgba(167,139,250,0.08)', border: 'rgba(167,139,250,0.22)', label: 'Discovery' },
    demo: { color: '#34d399', glow: 'rgba(52,211,153,0.25)', bg: 'rgba(52,211,153,0.07)', border: 'rgba(52,211,153,0.20)', label: 'Demo' },
    negotiation: { color: '#fbbf24', glow: 'rgba(251,191,36,0.25)', bg: 'rgba(251,191,36,0.07)', border: 'rgba(251,191,36,0.20)', label: 'Negotiation' },
};

// Fallback for meeting types outside the known union (e.g. a new/renamed type the
// LLM emits before this map is updated). The backend spreads the LLM's JSON output
// verbatim with no meetingType validation, so this lookup can't assume a hit.
const DEFAULT_TYPE_ACCENT = { color: '#94a3b8', glow: 'rgba(148,163,184,0.25)', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.22)', label: '' };

export function getTypeAccent(type: string) {
    return TYPE_ACCENT[type as MeetingType] ?? { ...DEFAULT_TYPE_ACCENT, label: type };
}

// ─── Score → semantic label ───────────────────────────────────────────────────
export function scoreLabel(n: number) {
    if (n >= 80) return 'Excellent';
    if (n >= 65) return 'Strong';
    if (n >= 50) return 'Good';
    if (n >= 35) return 'Fair';
    return 'Needs Work';
}

export function useMeetingScorecard() {
    const [activeType, setActiveType] = useState<MeetingType | null>(null);
    return { activeType, setActiveType };
}