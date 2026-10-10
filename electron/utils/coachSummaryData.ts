// coachSummaryData.ts
//
// Post-parse normalisation for the coach-ready summary fields (openLoops,
// promises, demoReview, negotiation, nextCallPlaybook.callGoal).
//
// The prompt already forbids fabrications and placeholders, but a prompt
// instruction is not a guarantee (the same reasoning behind
// summaryReconciliation.ts): a fallback-tier provider can still emit
// "limit": "N/A", a reaction with a verdict outside the allowed set, or a
// demo block on a discovery call. This module makes those guarantees real in
// code. Everything here is lossy ONLY toward grounded data: invalid or
// placeholder entries are dropped, valid ones pass through untouched, and no
// existing (old-schema) summary field is ever touched.

import { CoachCallType } from '../../src/types';
import { isPlaceholderSummaryItem } from '../summaryReconciliation';

const VERDICTS = ['landed', 'follow_up'] as const;
const TERM_STATUSES = ['agreed', 'open', 'leaning', 'must_have'] as const;

/** A usable non-empty string, or undefined. */
const cleanString = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t.length ? t : undefined;
};

/** A usable non-placeholder string, or undefined — for optional descriptive
 *  fields where "N/A"/"Unknown" means "the LLM had nothing" and must be
 *  omitted instead (spec: never store placeholder values). */
const cleanOptionalText = (v: unknown): string | undefined => {
    const s = cleanString(v);
    return s !== undefined && !isPlaceholderSummaryItem(s) ? s : undefined;
};

/** Framework component names (plus the legacy gap categories), normalised.
 *  Banned as Coach's-notes labels — that's Call Analysis territory, not
 *  film-review skills. */
const FRAMEWORK_COACH_LABELS = new Set([
    'budget', 'authority', 'need', 'timeline', 'metrics',
    'economicbuyer', 'decisioncriteria', 'decisionprocess',
    'identifypain', 'pain', 'champion', 'competition',
    'identifychampion', 'process',
]);

function isFrameworkCoachLabel(label: string): boolean {
    const normalized = label
        .replace(/^(meddic{1,2}|bant|discovery)\s*/i, '')
        .replace(/[\s_]+/g, '')
        .trim()
        .toLowerCase();
    return FRAMEWORK_COACH_LABELS.has(normalized);
}

const sanitizeOpenLoops = (raw: any): Array<{ concern: string; suggestedAnswer?: string }> | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const loops = raw
        .map((l: any) => {
            const concern = cleanOptionalText(l?.concern);
            if (!concern) return null;
            const suggestedAnswer = cleanOptionalText(l?.suggestedAnswer);
            return suggestedAnswer ? { concern, suggestedAnswer } : { concern };
        })
        .filter((l: any): l is { concern: string; suggestedAnswer?: string } => l !== null);
    return loops.length ? loops : undefined;
};

const sanitizePromises = (raw: any): Array<{ text: string; owner?: string; dueDate?: string }> | undefined => {
    if (!Array.isArray(raw)) return undefined;
    const promises = raw
        .map((p: any) => {
            const text = cleanOptionalText(p?.text);
            if (!text) return null;
            const owner = cleanOptionalText(p?.owner);
            const dueDate = cleanOptionalText(p?.dueDate);
            return { text, ...(owner ? { owner } : {}), ...(dueDate ? { dueDate } : {}) };
        })
        .filter((p: any) => p !== null);
    return promises.length ? promises : undefined;
};

const sanitizeDemoReview = (raw: any) => {
    if (!raw || typeof raw !== 'object') return undefined;
    const review: { reactions?: any[]; successCriteria?: any[] } = {};

    if (Array.isArray(raw.reactions)) {
        const reactions = raw.reactions
            .map((r: any) => {
                const feature = cleanOptionalText(r?.feature);
                const quote = cleanOptionalText(r?.quote);
                const speaker = cleanOptionalText(r?.speaker);
                if (!feature || !quote || !speaker) return null;
                if (!VERDICTS.includes(r?.verdict)) return null;
                const timestamp = cleanOptionalText(r?.timestamp);
                return { feature, verdict: r.verdict, quote, speaker, ...(timestamp ? { timestamp } : {}) };
            })
            .filter((r: any) => r !== null);
        if (reactions.length) review.reactions = reactions;
    }

    if (Array.isArray(raw.successCriteria)) {
        const successCriteria = raw.successCriteria
            .map((c: any) => {
                const metric = cleanOptionalText(c?.metric);
                const target = cleanOptionalText(c?.target);
                if (!metric || !target) return null;
                const owner = cleanOptionalText(c?.owner);
                return { metric, target, ...(owner ? { owner } : {}) };
            })
            .filter((c: any) => c !== null);
        if (successCriteria.length) review.successCriteria = successCriteria;
    }

    return Object.keys(review).length ? review : undefined;
};

const sanitizeNegotiation = (raw: any) => {
    if (!raw || typeof raw !== 'object') return undefined;
    const negotiation: { terms?: any[]; trades?: any[]; limit?: string; pathToSignature?: any[] } = {};

    if (Array.isArray(raw.terms)) {
        const terms = raw.terms
            .map((t: any) => {
                const term = cleanOptionalText(t?.term);
                if (!term) return null;
                // A discussed term must survive even when the provider emits a
                // junk status — 'open' claims the least (never "agreed").
                const status = TERM_STATUSES.includes(t?.status) ? t.status : 'open';
                return {
                    term,
                    theyAsked: cleanString(t?.theyAsked) ?? '',
                    youOffered: cleanString(t?.youOffered) ?? '',
                    status,
                };
            })
            .filter((t: any) => t !== null);
        if (terms.length) negotiation.terms = terms;
    }

    if (Array.isArray(raw.trades)) {
        const trades = raw.trades
            .map((t: any) => {
                const give = cleanOptionalText(t?.give);
                const get = cleanOptionalText(t?.get);
                return give && get ? { give, get } : null;
            })
            .filter((t: any) => t !== null);
        if (trades.length) negotiation.trades = trades;
    }

    // Walk-away limit: only ever stored when the rep explicitly stated one on
    // the call. A placeholder here is worse than nothing — it would render as
    // a real boundary — so "N/A"-style values remove the key entirely.
    const limit = cleanOptionalText(raw.limit);
    if (limit) negotiation.limit = limit;

    if (Array.isArray(raw.pathToSignature)) {
        const pathToSignature = raw.pathToSignature
            .map((p: any) => {
                const step = cleanOptionalText(p?.step);
                if (!step) return null;
                const date = cleanOptionalText(p?.date);
                const owner = cleanOptionalText(p?.owner);
                return { ...(date ? { date } : {}), step, ...(owner ? { owner } : {}) };
            })
            .filter((p: any) => p !== null);
        if (pathToSignature.length) negotiation.pathToSignature = pathToSignature;
    }

    return Object.keys(negotiation).length ? negotiation : undefined;
};

/**
 * Validate the coach-ready fields on a freshly generated (or regenerated)
 * summary. Drops entries with missing required members, invalid enum values,
 * or placeholder content; strips type-specific blocks that don't belong to
 * the resolved call type; leaves every other property untouched.
 */
export function sanitizeCoachSummary(summary: any, callType: CoachCallType): any {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return summary;
    const out: any = { ...summary };

    // nextCallPlaybook.callGoal — placeholder goals are worse than no goal.
    if (out.nextCallPlaybook && typeof out.nextCallPlaybook === 'object') {
        const callGoal = cleanOptionalText(out.nextCallPlaybook.callGoal);
        const playbook: any = { ...out.nextCallPlaybook };
        if (callGoal) playbook.callGoal = callGoal;
        else delete playbook.callGoal;
        out.nextCallPlaybook = playbook;
    }

    const openLoops = sanitizeOpenLoops(out.openLoops);
    if (openLoops) out.openLoops = openLoops;
    else delete out.openLoops;

    const promises = sanitizePromises(out.promises);
    if (promises) out.promises = promises;
    else delete out.promises;

    // salesCoachReview.whatIDidRight — film-review highlights. A fallback-tier
    // model sometimes ignores the object schema and emits framework-labelled
    // items ("EconomicBuyer: The prospect…") instead; framework coverage is
    // Call Analysis's job, so those entries are dropped here. This runs only
    // on newly generated summaries — stored legacy data never passes through.
    if (Array.isArray(out.salesCoachReview?.whatIDidRight)) {
        const kept = out.salesCoachReview.whatIDidRight.filter((item: any) => {
            if (item && typeof item === 'object') {
                if (!(String(item.moment ?? '').trim() || String(item.why ?? '').trim())) return false;
                return !isFrameworkCoachLabel(String(item.skill ?? ''));
            }
            if (typeof item !== 'string' || !item.trim()) return false;
            return !isFrameworkCoachLabel(item.split(':')[0] ?? '');
        });
        out.salesCoachReview = { ...out.salesCoachReview, whatIDidRight: kept };
    }

    // Type-specific blocks: keep only what the resolved call type owns.
    // stakeholders is dropped for every type — nothing consumes it (its UI
    // was removed with the fixed-structure Game Plan), so the prompt no
    // longer asks for it and stale stored values are not re-persisted.
    if (callType === 'demo') {
        delete out.negotiation;
        delete out.stakeholders;
        const demoReview = sanitizeDemoReview(out.demoReview);
        if (demoReview) out.demoReview = demoReview;
        else delete out.demoReview;
    } else if (callType === 'negotiation') {
        delete out.demoReview;
        delete out.stakeholders;
        const negotiation = sanitizeNegotiation(out.negotiation);
        if (negotiation) out.negotiation = negotiation;
        else delete out.negotiation;
    } else {
        delete out.demoReview;
        delete out.stakeholders;
        delete out.negotiation;
    }

    return out;
}

/**
 * Keys to explicitly blank when persisting a summary for `callType`, so a
 * merge-based update (updateMeetingSummary spreads updates over the stored
 * summary) drops type-specific blocks left over from a previous generation
 * with a different call type. JSON.stringify omits undefined values, so
 * spreading this removes the stored keys. stakeholders is blanked for every
 * type — it is no longer generated or displayed anywhere.
 */
export function clearForeignCoachBlocks(
    callType: CoachCallType,
): { demoReview?: undefined; stakeholders?: undefined; negotiation?: undefined } {
    if (callType === 'demo') return { negotiation: undefined, stakeholders: undefined };
    if (callType === 'negotiation') return { demoReview: undefined, stakeholders: undefined };
    return { demoReview: undefined, stakeholders: undefined, negotiation: undefined };
}
