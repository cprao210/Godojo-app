/**
 * bantMeddic.ts
 *
 * There are two BANT/MEDDICC shapes in the app:
 *   1. `LiveAnalysisData` (`detailedSummary.liveAnalysis.bant` / `.meddic`) —
 *      the raw shape from the live-analysis backend: snake_case keys
 *      (economic_buyer, decision_criteria, ...), lowercase status
 *      ('confirmed' | 'partial' | 'missing' | ''), a `summary` line and a
 *      list of verbatim `evidence` spans. Rows saved before that carry a bare
 *      string `evidence`, no `summary`, and an `evidence_clean` readable
 *      rendering, so this module's accessors serve both shapes and nothing
 *      else reads the fields directly. `summary` is the source of truth for
 *      anything showing one line; `evidence` is reference material.
 *   2. `MeetingDetailedSummary.bant` / `.meddicc` — the canonical UI shape:
 *      camelCase keys (economicBuyer, decisionCriteria, ...), Title-case
 *      status ('Clear' | 'Partial' | 'Missing'), field name `detail`.
 *
 * liveAnalysis is the authoritative data (see reconcileBantMeddicWithLiveAnalysis
 * in electron/MeetingPersistence.ts, which is the same mapping mirrored here for
 * the frontend). Anything that needs to read BANT/MEDDICC off liveAnalysis
 * should go through `normalizeBant`/`normalizeMeddicc` below instead of
 * hand-rolling the key/status conversion — that's what caused the casing and
 * vocabulary to drift out of sync across call sites.
 */
import type { EvidenceValue, LiveAnalysisData } from '@/types';

/** Mirrors STATUS_MAP in electron/MeetingPersistence.ts exactly. */
export const STATUS_MAP: Record<string, 'Clear' | 'Partial' | 'Missing'> = {
    confirmed: 'Clear',
    partial: 'Partial',
    missing: 'Missing',
    '': 'Missing',
};

/** snake_case liveAnalysis.meddic key -> camelCase canonical meddicc key. */
const MEDDIC_KEY_MAP = {
    metrics: 'metrics',
    economic_buyer: 'economicBuyer',
    decision_criteria: 'decisionCriteria',
    decision_process: 'decisionProcess',
    identify_pain: 'identifyPain',
    champion: 'champion',
    competition: 'competition',
} as const;

/** The evidence and summary a BANT/MEDDIC field can carry. */
export type EvidenceBearing =
    | { evidence?: EvidenceValue; evidence_clean?: string; summary?: string }
    | null
    | undefined;

/** string | string[] | undefined -> a trimmed, non-empty string[]. */
export const toEvidenceList = (v: EvidenceValue | undefined): string[] => {
    if (Array.isArray(v)) return v.map((s) => String(s ?? '').trim()).filter(Boolean);
    if (typeof v === 'string') { const t = v.trim(); return t ? [t] : []; }
    return [];
};

/**
 * The verbatim evidence spans for a BANT/MEDDIC field, in backend order —
 * the reference material behind the assessment.
 *
 * Reads `evidence` only. `evidence_clean` is NOT an evidence rendering any
 * more: the backend now mirrors `summary` into it for older builds
 * (add_legacy_evidence_mirror), so treating it as evidence would show the
 * summary twice and hide the real spans. It is a card-body fallback — see
 * fieldText.
 */
export const fieldEvidenceList = (f: EvidenceBearing): string[] => toEvidenceList(f?.evidence);

/** The backend's one-line reading of the field. '' on rows that predate it. */
export const fieldSummary = (f: EvidenceBearing): string =>
    typeof f?.summary === 'string' ? f.summary.trim() : '';

/** The verbatim spans as ONE string, joined with a space. */
export const fieldEvidence = (f: EvidenceBearing): string => fieldEvidenceList(f).join(' ');

/**
 * The one line to show for a criterion — the source of truth for every
 * one-line reader. Same precedence as the backend's to_summary_shape:
 * `summary`, then `evidence_clean` (the readable rendering on rows saved
 * before summaries existed), then the joined spans.
 */
export const fieldText = (f: EvidenceBearing): string =>
    fieldSummary(f) || (typeof f?.evidence_clean === 'string' ? f.evidence_clean.trim() : '') || fieldEvidence(f);

/**
 * Everything a field card needs. The evidence disclosure appears only when
 * there is a summary: without one, the body already IS the evidence (or its
 * legacy rendering), and a disclosure would just repeat it. Kept here rather
 * than in the component so the rule is unit-testable.
 */
export function fieldDisplay(f: EvidenceBearing): {
    evidence: string[];
    body: string;
    showDisclosure: boolean;
} {
    const evidence = fieldEvidenceList(f);
    return {
        evidence,
        body: fieldText(f),
        showDisclosure: fieldSummary(f) !== '' && evidence.length > 0,
    };
}

type CanonicalField = { status: 'Clear' | 'Partial' | 'Missing'; detail: string };

const toCanonicalField = (f: ({ status: string } & EvidenceBearing) | undefined): CanonicalField => ({
    status: STATUS_MAP[f?.status ?? ''] ?? 'Missing',
    // `detail` is the one line people read (Summary tab, PDF, Self-Analysis).
    detail: fieldText(f),
});

/** Canonical BANT shape: all four fields always present, status is the narrow literal union. */
type CanonicalBant = Record<'budget' | 'authority' | 'need' | 'timeline', CanonicalField>;

/** Canonical MEDDICC shape: all seven fields always present, status is the narrow literal union. */
type CanonicalMeddicc = Record<
    'metrics' | 'economicBuyer' | 'decisionCriteria' | 'decisionProcess' | 'identifyPain' | 'champion' | 'competition',
    CanonicalField
>;

/** liveAnalysis.bant -> canonical { budget, authority, need, timeline } shape. */
export function normalizeBant(bant: LiveAnalysisData['bant'] | undefined): CanonicalBant | null {
    if (!bant) return null;
    return {
        budget: toCanonicalField(bant.budget),
        authority: toCanonicalField(bant.authority),
        need: toCanonicalField(bant.need),
        timeline: toCanonicalField(bant.timeline),
    };
}

/** liveAnalysis.meddic -> canonical { metrics, economicBuyer, ... } shape. */
export function normalizeMeddicc(meddic: LiveAnalysisData['meddic'] | undefined): CanonicalMeddicc | null {
    if (!meddic) return null;
    const out = {} as CanonicalMeddicc;
    for (const [liveKey, canonicalKey] of Object.entries(MEDDIC_KEY_MAP) as [keyof typeof MEDDIC_KEY_MAP, keyof CanonicalMeddicc][]) {
        out[canonicalKey] = toCanonicalField((meddic as any)?.[liveKey]);
    }
    return out;
}

/** Human-readable label for a canonical camelCase key, e.g. economicBuyer -> "ECONOMIC BUYER". */
export const labelFor = (camelKey: string): string =>
    camelKey.replace(/([A-Z])/g, ' $1').trim().toUpperCase();

/**
 * Filters a normalized bant/meddicc object down to only the Clear (confirmed)
 * fields, returning ordered [label, detail] pairs ready to render/format.
 */
export function confirmedOnly(
    normalized: Record<string, CanonicalField> | null,
    order: string[],
): { label: string; detail: string }[] {
    if (!normalized) return [];
    return order
        .filter((key) => normalized[key]?.status === 'Clear')
        .map((key) => ({ label: labelFor(key), detail: normalized[key].detail }));
}

export const BANT_ORDER = ['budget', 'authority', 'need', 'timeline'];
export const MEDDICC_ORDER = ['metrics', 'economicBuyer', 'decisionCriteria', 'decisionProcess', 'identifyPain', 'champion', 'competition'];