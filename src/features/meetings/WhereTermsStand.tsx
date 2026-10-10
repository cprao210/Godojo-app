import type { ReactNode } from 'react';
import { Handshake, Lock } from 'lucide-react';
import type { MeetingDetailedSummary, NegotiationTerm } from '@/types';
import { callInvolves } from '@/lib/coachSummary';
import { EmptySectionNote } from './coachShared';

/**
 * "Move the deal to signature" — the negotiation-specific panel between
 * Call Summary and the Game Plan. Shown whenever the call included a
 * negotiation (negotiation-typed, or a mixed selection/detection that
 * contains negotiation).
 *
 * Three sections, each omitted when its data is missing:
 *   1. "Where the terms stand" ← negotiation.terms (asked/offered/status)
 *   2. "Trades to offer"      ← negotiation.trades (give ⇄ get) with the
 *      walk-away limit card (negotiation.limit) attached underneath
 *   3. "Path to signature"    ← negotiation.pathToSignature (steps/owners)
 */

type TermStatus = NegotiationTerm['status'];

function statusOf(term: NegotiationTerm): TermStatus | null {
    return ['agreed', 'open', 'leaning', 'must_have'].includes(term.status)
        ? term.status
        : null;
}

function statusPill(status: TermStatus, isLight: boolean): { label: string; className: string } {
    switch (status) {
        case 'agreed':
            return {
                label: 'Agreed',
                className: isLight
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
                    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
            };
        case 'open':
            return {
                label: 'Open',
                className: isLight
                    ? 'border-amber-300 text-amber-600'
                    : 'border-amber-500/45 text-amber-400',
            };
        case 'leaning':
            return {
                label: 'Leaning yes',
                className: isLight
                    ? 'border-blue-200 bg-blue-50 text-blue-600'
                    : 'border-blue-500/30 bg-blue-500/10 text-blue-300',
            };
        case 'must_have':
            return {
                label: 'Must have',
                className: isLight
                    ? 'border-red-200 bg-red-50 text-red-600'
                    : 'border-red-500/30 bg-red-500/10 text-red-400',
            };
    }
}

function SectionHeading({ title, right, isLight }: {
    title: string;
    right?: ReactNode;
    isLight: boolean;
}) {
    return (
        <div className="mb-4 flex items-center justify-between gap-3">
            <h4 className={`shrink-0 text-[15px] font-semibold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                {title}
            </h4>
            {right}
        </div>
    );
}

export default function WhereTermsStand({ summary, meetingTypes, scorecardDetectedTypes, isLight }: {
    summary: MeetingDetailedSummary;
    /** Meeting types the user selected during the live call. */
    meetingTypes?: string[];
    /** Types the scorecard detected (separate fetch from the summary's own). */
    scorecardDetectedTypes?: string[];
    isLight: boolean;
}) {
    const terms = (summary.negotiation?.terms ?? [])
        .filter((t): t is NegotiationTerm =>
            !!t && typeof t.term === 'string' && t.term.trim().length > 0
            && ((typeof t.theyAsked === 'string' && t.theyAsked.trim().length > 0)
                || (typeof t.youOffered === 'string' && t.youOffered.trim().length > 0)));
    const trades = (summary.negotiation?.trades ?? [])
        .filter((t) => !!t
            && typeof t.give === 'string' && t.give.trim().length > 0
            && typeof t.get === 'string' && t.get.trim().length > 0);
    const limit = summary.negotiation?.limit?.trim() || null;
    const pathSteps = (summary.negotiation?.pathToSignature ?? [])
        .filter((s) => !!s && typeof s.step === 'string' && s.step.trim().length > 0);

    const involvesNegotiation = callInvolves('negotiation', summary, meetingTypes, scorecardDetectedTypes);
    if (!involvesNegotiation
        || (terms.length === 0 && trades.length === 0 && !limit && pathSteps.length === 0)) {
        return null;
    }

    const agreedCount = terms.filter((t) => statusOf(t) === 'agreed').length;
    const openCount = terms.length - agreedCount;

    const sectionDivider = `mt-7 border-t pt-7 ${isLight ? 'border-slate-100' : 'border-white/[0.05]'}`;
    const listCard = `overflow-hidden rounded-xl border ${isLight
        ? 'border-slate-200 bg-white'
        : 'border-white/[0.07] bg-white/[0.02]'
        }`;
    const columnLabel = 'mb-1 text-[9.5px] font-bold uppercase tracking-[0.14em]';

    return (
        <section id="coach-negotiation" className="mb-10">
            <div className={`rounded-2xl border ${isLight
                ? 'border-slate-200/80 bg-white shadow-[0_20px_60px_-25px_rgba(30,58,138,0.15)]'
                : 'border-white/[0.07] bg-gray-800/20'
                }`}>
                <div className="p-6 sm:p-7">
                    {/* Header */}
                    <div className={`flex items-center justify-between gap-4 border-b pb-5 ${isLight ? 'border-slate-100' : 'border-white/[0.06]'}`}>
                        <div className="flex min-w-0 items-center gap-3.5">
                            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${isLight
                                ? 'border-blue-100 bg-blue-50'
                                : 'border-blue-500/25 bg-blue-500/15'
                                }`}>
                                <Handshake size={18} className={isLight ? 'text-blue-600' : 'text-blue-300'} />
                            </div>
                            <div className="min-w-0">
                                <h3 className={`text-[19px] font-bold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                                    Move the deal to signature
                                </h3>
                                <p className={`mt-0.5 text-[12.5px] ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                    Shown because this call included negotiation
                                </p>
                            </div>
                        </div>
                        <span className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-semibold ${isLight
                            ? 'border-slate-200 bg-slate-50 text-slate-500'
                            : 'border-white/10 bg-white/[0.04] text-white/50'
                            }`}>
                            Negotiation
                        </span>
                    </div>

                    {/* 1 — Where the terms stand */}
                    {(
                        <section className="mt-6">
                            <SectionHeading
                                title="Where the terms stand"
                                isLight={isLight}
                                right={
                                    <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium">
                                        <span className={isLight ? 'text-emerald-600' : 'text-emerald-400'}>
                                            {agreedCount} agreed
                                        </span>
                                        <span className={isLight ? 'text-slate-300' : 'text-white/25'}>·</span>
                                        <span className={isLight ? 'text-amber-600' : 'text-amber-400'}>
                                            {openCount} open
                                        </span>
                                    </span>
                                }
                            />
                            {terms.length > 0 ? (
                            <div className={listCard}>
                                <ul className={`divide-y ${isLight ? 'divide-slate-100' : 'divide-white/[0.05]'}`}>
                                    {terms.map((term, i) => {
                                        const theyAsked = term.theyAsked?.trim() || null;
                                        const youOffered = term.youOffered?.trim() || null;
                                        const status = statusOf(term);
                                        const pill = status ? statusPill(status, isLight) : null;
                                        return (
                                            <li key={i} className="px-4 py-3.5">
                                                <div className="flex items-center justify-between gap-3">
                                                    <p className={`min-w-0 text-[14px] font-semibold leading-snug ${isLight ? 'text-slate-900' : 'text-white'}`}>
                                                        {term.term.trim()}
                                                    </p>
                                                    {pill && (
                                                        <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.1em] ${pill.className}`}>
                                                            {pill.label}
                                                        </span>
                                                    )}
                                                </div>
                                                {(theyAsked || youOffered) && (
                                                    <div className={`mt-2.5 grid gap-4 ${theyAsked && youOffered ? 'sm:grid-cols-2 sm:gap-6' : 'sm:grid-cols-1'}`}>
                                                        {theyAsked && (
                                                            <div>
                                                                <p className={`${columnLabel} ${isLight ? 'text-slate-400' : 'text-white/35'}`}>They asked</p>
                                                                <p className={`text-[13px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/70'}`}>
                                                                    {theyAsked}
                                                                </p>
                                                            </div>
                                                        )}
                                                        {youOffered && (
                                                            <div>
                                                                <p className={`${columnLabel} ${isLight ? 'text-blue-600' : 'text-blue-300'}`}>You offered</p>
                                                                <p className={`text-[13px] leading-relaxed ${isLight ? 'text-blue-700' : 'text-blue-200/90'}`}>
                                                                    {youOffered}
                                                                </p>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                            ) : (
                                <EmptySectionNote text="No terms were discussed on this call yet." isLight={isLight} />
                            )}
                        </section>
                    )}

                    {/* 2 — Trades to offer (walk-away limit rides underneath) */}
                    {(
                        <section className={sectionDivider}>
                            <SectionHeading
                                title="Trades to offer"
                                isLight={isLight}
                                right={
                                    <span className={`hidden text-[11.5px] italic sm:inline ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                        never give without getting something back
                                    </span>
                                }
                            />
                            {trades.length > 0 ? (
                            <div className="space-y-3">
                                {trades.map((trade, i) => (
                                    <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-3">
                                        <div className={`rounded-xl border p-3.5 ${isLight
                                            ? 'border-amber-200 bg-amber-50/70'
                                            : 'border-amber-500/20 bg-amber-500/[0.06]'
                                            }`}>
                                            <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-amber-600' : 'text-amber-300'}`}>
                                                If you give
                                            </p>
                                            <p className={`text-[13px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                                {trade.give.trim()}
                                            </p>
                                        </div>
                                        <span className={`self-center select-none text-center font-serif text-[22px] leading-none ${isLight ? 'text-slate-300' : 'text-white/25'}`}>
                                            ⇄
                                        </span>
                                        <div className={`rounded-xl border p-3.5 ${isLight
                                            ? 'border-emerald-200 bg-emerald-50/70'
                                            : 'border-emerald-500/20 bg-emerald-500/[0.06]'
                                            }`}>
                                            <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-emerald-600' : 'text-emerald-300'}`}>
                                                Ask for
                                            </p>
                                            <p className={`text-[13px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                                {trade.get.trim()}
                                            </p>
                                        </div>
                                    </div>
                                ))}
                                {limit && (
                                    <div className={`flex items-center gap-3 rounded-xl border border-dashed p-4 ${isLight
                                        ? 'border-amber-300 bg-amber-50/60'
                                        : 'border-amber-500/30 bg-amber-500/[0.06]'
                                        }`}>
                                        <Lock size={15} className="shrink-0 text-amber-400" />
                                        <p className={`text-[13.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-white/75'}`}>
                                            <span className={`font-semibold ${isLight ? 'text-slate-900' : 'text-white'}`}>Your limit:</span> {limit}
                                        </p>
                                    </div>
                                )}
                            </div>
                            ) : limit ? null : (
                                <EmptySectionNote text="No trades prepared yet — and no walk-away limit was captured." isLight={isLight} />
                            )}
                        </section>
                    )}

                    {/* 3 — Path to signature */}
                    {(
                        <section className={sectionDivider}>
                            <SectionHeading
                                title="Path to signature"
                                isLight={isLight}
                                right={
                                    <span className={`hidden text-[11.5px] italic sm:inline ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                        confirm each step and owner on the call
                                    </span>
                                }
                            />
                            {pathSteps.length > 0 ? (
                            <ol className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                {pathSteps.map((step, i) => {
                                    const ownerUnknown = (step.owner ?? '').trim().toLowerCase() === 'owner not confirmed';
                                    return (
                                        <li
                                            key={i}
                                            className={`rounded-xl border p-4 ${isLight ? 'border-slate-200 bg-white' : 'border-white/[0.07] bg-white/[0.02]'}`}
                                        >
                                            {step.date?.trim() && (
                                                <p className={`text-[11px] font-semibold ${isLight ? 'text-blue-600' : 'text-blue-300'}`}>
                                                    {step.date.trim()}
                                                </p>
                                            )}
                                            <p className={`mt-1 text-[13.5px] font-semibold leading-snug ${isLight ? 'text-slate-900' : 'text-white'}`}>
                                                {step.step.trim()}
                                            </p>
                                            {ownerUnknown ? (
                                                <p className="mt-1.5 text-[11px] font-medium text-amber-400">Owner not confirmed</p>
                                            ) : step.owner?.trim() ? (
                                                <p className={`mt-1.5 text-[11px] ${isLight ? 'text-slate-400' : 'text-white/35'}`}>{step.owner.trim()}</p>
                                            ) : null}
                                        </li>
                                    );
                                })}
                            </ol>
                            ) : (
                                <EmptySectionNote text="No path to signature was agreed yet." isLight={isLight} />
                            )}
                        </section>
                    )}
                </div>
            </div>
        </section>
    );
}
