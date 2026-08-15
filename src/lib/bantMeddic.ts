/**
 * bantMeddic.ts
 *
 * There are two BANT/MEDDICC shapes in the app:
 *   1. `LiveAnalysisData` (`detailedSummary.liveAnalysis.bant` / `.meddic`) —
 *      the raw shape from the live-analysis backend: snake_case keys
 *      (economic_buyer, decision_criteria, ...), lowercase status
 *      ('confirmed' | 'partial' | 'missing' | ''), field name `evidence`.
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
import type { LiveAnalysisData } from '@/types';

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

type CanonicalField = { status: 'Clear' | 'Partial' | 'Missing'; detail: string };

const toCanonicalField = (f: { status: string; evidence: string } | undefined): CanonicalField => ({
    status: STATUS_MAP[f?.status ?? ''] ?? 'Missing',
    detail: f?.evidence || '',
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