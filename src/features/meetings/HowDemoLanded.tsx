import type { ReactNode } from 'react';
import { MonitorPlay } from 'lucide-react';
import type { DemoReaction, MeetingDetailedSummary } from '@/types';
import { callInvolves } from '@/lib/coachSummary';
import { CopyButton, EmptySectionNote } from './coachShared';

/**
 * "Follow up on the demo" — the demo-specific panel between Call Summary and
 * the Game Plan. Shown whenever the call included a demo (demo-typed, or a
 * mixed selection/detection that contains demo).
 *
 * Three sections, each omitted when its data is missing:
 *   1. "How it landed"          ← demoReview.reactions (feature, quote, verdict)
 *   2. "Answer what you owe them" ← openLoops (concern + TRY SAYING answer)
 *   3. "Agree how the pilot is judged" ← demoReview.successCriteria
 *
 * The Practice-with-Dojo button is intentionally commented out for now —
 * re-enable by wiring `onPractice` (see the note in the open-loop card).
 */

type Verdict = 'landed' | 'follow_up';

function verdictOf(reaction: DemoReaction): Verdict | null {
    return reaction.verdict === 'landed' || reaction.verdict === 'follow_up'
        ? reaction.verdict
        : null;
}

function verdictPill(verdict: Verdict, isLight: boolean): string {
    return verdict === 'landed'
        ? isLight
            ? 'border-emerald-200 bg-emerald-50 text-emerald-600'
            : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
        : isLight
            ? 'border-amber-200 bg-amber-50 text-amber-700'
            : 'border-amber-500/30 bg-amber-500/10 text-amber-300';
}

function SectionHeading({ title, right, isLight }: {
    title: string;
    right?: ReactNode;
    isLight: boolean;
}) {
    return (
        <div className="mb-4 flex items-center justify-between gap-3">
            <h4 className={`text-[15px] font-semibold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                {title}
            </h4>
            {right}
        </div>
    );
}

export default function HowDemoLanded({ summary, meetingTypes, scorecardDetectedTypes, isLight }: {
    summary: MeetingDetailedSummary;
    /** Meeting types the user selected during the live call. */
    meetingTypes?: string[];
    /** Types the scorecard detected (separate fetch from the summary's own). */
    scorecardDetectedTypes?: string[];
    isLight: boolean;
}) {
    const reactions = (summary.demoReview?.reactions ?? [])
        .filter((r): r is DemoReaction =>
            !!r && typeof r.feature === 'string' && r.feature.trim().length > 0
            && typeof r.quote === 'string' && r.quote.trim().length > 0);
    const openLoops = (summary.openLoops ?? [])
        .filter((l) => !!l && typeof l.concern === 'string' && l.concern.trim().length > 0);
    const criteria = (summary.demoReview?.successCriteria ?? [])
        .filter((c) => !!c
            && typeof c.metric === 'string' && c.metric.trim().length > 0
            && typeof c.target === 'string' && c.target.trim().length > 0);

    const involvesDemo = callInvolves('demo', summary, meetingTypes, scorecardDetectedTypes);
    if (!involvesDemo
        || (reactions.length === 0 && openLoops.length === 0 && criteria.length === 0)) {
        return null;
    }

    const landedCount = reactions.filter((r) => verdictOf(r) === 'landed').length;
    const followUpCount = reactions.filter((r) => verdictOf(r) === 'follow_up').length;

    return (
        <section id="coach-demo" className="mb-10">
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
                                <MonitorPlay size={18} className={isLight ? 'text-blue-600' : 'text-blue-300'} />
                            </div>
                            <div className="min-w-0">
                                <h3 className={`text-[19px] font-bold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                                    Follow up on the demo
                                </h3>
                                <p className={`mt-0.5 text-[12.5px] ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                    Shown because this call included a demo
                                </p>
                            </div>
                        </div>
                        <span className={`shrink-0 rounded-md border px-2.5 py-1 text-[11px] font-semibold ${isLight
                            ? 'border-slate-200 bg-slate-50 text-slate-500'
                            : 'border-white/10 bg-white/[0.04] text-white/50'
                            }`}>
                            Demo
                        </span>
                    </div>

                    {/* 1 — How it landed */}
                    {(
                        <section className="mt-6">
                            <SectionHeading
                                title="How it landed"
                                isLight={isLight}
                                right={(landedCount > 0 || followUpCount > 0) && (
                                    <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium">
                                        {landedCount > 0 && (
                                            <span className={isLight ? 'text-emerald-600' : 'text-emerald-400'}>
                                                {landedCount} landed
                                            </span>
                                        )}
                                        {landedCount > 0 && followUpCount > 0 && (
                                            <span className={isLight ? 'text-slate-300' : 'text-white/25'}>•</span>
                                        )}
                                        {followUpCount > 0 && (
                                            <span className={isLight ? 'text-amber-600' : 'text-amber-400'}>
                                                {followUpCount} to follow up
                                            </span>
                                        )}
                                    </span>
                                )}
                            />
                            {reactions.length > 0 ? (
                            <div className={`overflow-hidden rounded-xl border ${isLight
                                ? 'border-slate-200 bg-white'
                                : 'border-white/[0.07] bg-white/[0.02]'
                                }`}>
                                <ul className={`divide-y ${isLight ? 'divide-slate-100' : 'divide-white/[0.05]'}`}>
                                    {reactions.map((reaction, i) => {
                                        const verdict = verdictOf(reaction);
                                        const attribution = [
                                            reaction.speaker?.trim() || null,
                                            reaction.timestamp?.trim() || null,
                                        ].filter(Boolean).join(' · ');
                                        return (
                                            <li key={i} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                                                <p className={`shrink-0 text-[13.5px] font-semibold sm:w-[190px] ${isLight ? 'text-slate-900' : 'text-white'}`}>
                                                    {reaction.feature.trim()}
                                                </p>
                                                <p className={`min-w-0 flex-1 text-[13px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-slate-300'}`}>
                                                    &ldquo;{reaction.quote.trim()}&rdquo;
                                                    {attribution && (
                                                        <span className={isLight ? 'text-slate-400' : 'text-white/35'}> — {attribution}</span>
                                                    )}
                                                </p>
                                                {verdict && (
                                                    <span className={`shrink-0 rounded-md border px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.1em] ${verdictPill(verdict, isLight)}`}>
                                                        {verdict === 'landed' ? 'Landed' : 'Follow up'}
                                                    </span>
                                                )}
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>
                            ) : (
                                <EmptySectionNote text="No feature reactions were captured from the demo." isLight={isLight} />
                            )}
                        </section>
                    )}

                    {/* 2 — Answer what you owe them */}
                    {(
                        <section className={`mt-7 border-t pt-7 ${isLight ? 'border-slate-100' : 'border-white/[0.05]'}`}>
                            <SectionHeading title="Answer what you owe them" isLight={isLight} />
                            {openLoops.length > 0 ? (
                            <div className="space-y-3">
                                {openLoops.map((loop, i) => {
                                    const concern = loop.concern.trim();
                                    const suggestedAnswer = loop.suggestedAnswer?.trim() || null;
                                    return (
                                        <div
                                            key={i}
                                            className={`rounded-xl border p-4 ${isLight
                                                ? 'border-amber-200 bg-amber-50/50'
                                                : 'border-amber-500/25 bg-amber-500/[0.04]'
                                                }`}
                                        >
                                            <p className={`mb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-amber-600' : 'text-amber-400'}`}>
                                                They asked
                                            </p>
                                            <p className={`text-[14px] leading-relaxed ${isLight ? 'text-slate-800' : 'text-white/85'}`}>
                                                &ldquo;{concern}&rdquo;
                                            </p>
                                            {suggestedAnswer && (
                                                <div className={`mt-3 rounded-lg border p-3 ${isLight
                                                    ? 'border-emerald-200 bg-emerald-50'
                                                    : 'border-emerald-500/20 bg-emerald-500/[0.08]'
                                                    }`}>
                                                    <div className="flex items-start justify-between gap-2.5">
                                                        <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`}>
                                                            Try saying
                                                        </p>
                                                        <CopyButton text={suggestedAnswer} label="suggested answer" isLight={isLight} />
                                                    </div>
                                                    <p className={`text-[13px] leading-relaxed ${isLight ? 'text-emerald-800' : 'text-emerald-100/90'}`}>
                                                        &ldquo;{suggestedAnswer}&rdquo;
                                                    </p>
                                                </div>
                                            )}
                                            {/* Practice with Dojo — disabled for now. To re-enable, add an
                                                `onPractice?: (prompt: string) => void` prop, pass MeetingDetails'
                                                handlePracticeWithDojo, and render a ghost button under the
                                                TRY SAYING panel: onPractice(`Help me practice responding to: "${concern}"`).
                                                See the same (commented) button in GamePlan's OpenLoopCard. */}
                                        </div>
                                    );
                                })}
                            </div>
                            ) : (
                                <EmptySectionNote text="Nothing left open — every question from the demo was answered on the call." isLight={isLight} />
                            )}
                        </section>
                    )}

                    {/* 3 — Agree how the pilot is judged */}
                    {(
                        <section className={`mt-7 border-t pt-7 ${isLight ? 'border-slate-100' : 'border-white/[0.05]'}`}>
                            <SectionHeading
                                title="Agree how the pilot is judged"
                                isLight={isLight}
                                right={
                                    <span className={`shrink-0 text-[11.5px] italic ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                        get a yes on each, out loud
                                    </span>
                                }
                            />
                            {criteria.length > 0 ? (
                            <div className={`overflow-hidden rounded-xl border ${isLight
                                ? 'border-slate-200 bg-white'
                                : 'border-white/[0.07] bg-white/[0.02]'
                                }`}>
                                <ul className={`divide-y ${isLight ? 'divide-slate-100' : 'divide-white/[0.05]'}`}>
                                    {criteria.map((c, i) => (
                                        <li key={i} className="flex flex-col gap-1 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-4">
                                            <span className="shrink-0 text-[19px] font-bold leading-none text-emerald-400">
                                                {c.target.trim()}
                                            </span>
                                            <p className={`min-w-0 flex-1 text-[13.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                                                {c.metric.trim()}
                                            </p>
                                            {c.owner?.trim() && (
                                                <span className={`shrink-0 text-[11.5px] sm:ml-auto sm:text-right ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                                    {c.owner.trim()}&rsquo;s metric
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            ) : (
                                <EmptySectionNote text="No success criteria were discussed yet — propose them on the follow-up call." isLight={isLight} />
                            )}
                        </section>
                    )}
                </div>
            </div>
        </section>
    );
}
