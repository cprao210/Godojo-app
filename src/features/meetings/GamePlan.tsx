import { useState } from 'react';
import type { ReactNode } from 'react';
import {
    Calendar,
    Check,
    ChevronDown,
    ChevronUp,
    Compass,
    ListChecks,
    Quote,
    Swords,
    Target,
} from 'lucide-react';
import type { CoachPromise, CoachQuestion, Meeting, MeetingDetailedSummary } from '@/types';
import { coachQuestionText, coachPromises } from '@/lib/coachSummary';
import { CopyButton, EmptySectionNote } from './coachShared';

/**
 * Game Plan — the next-call coaching block on the Coach tab.
 *
 * One fixed structure for every call type (single or mixed):
 * Open with → Ask these → Close the open loops → Reinforce the value →
 * Promises you made. Presentation layer only: every field it renders comes
 * straight from MeetingDetailedSummary (nextCallPlaybook, openLoops,
 * promises). Sections whose data is missing are omitted — never faked with
 * placeholders. Old summaries (string questions) render identically.
 */

type GamePlanProps = {
    summary: MeetingDetailedSummary;
    date: string;
    participants?: Meeting['participants'];
    isLight: boolean;
    /** Opens the existing Ask Dojo chat with a prefilled practice prompt. */
    onPractice?: (prompt: string) => void;
};

/** The Game Plan is the same shape for every call type — fixed title and icon. */
const GAME_PLAN_TITLE = 'Your game plan for the next call';

const QUESTIONS_PREVIEW_COUNT = 3;

function SectionHeader({ index, title, hint, right, isLight }: {
    index: number;
    title: string;
    hint?: string;
    right?: ReactNode;
    isLight: boolean;
}) {
    return (
        <div className="mb-4 flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-bold ${isLight
                    ? 'border-blue-200 bg-blue-50 text-blue-600'
                    : 'border-blue-500/30 bg-blue-500/15 text-blue-300'
                    }`}>
                    {index}
                </span>
                <h4 className={`shrink-0 text-[15px] font-semibold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    {title}
                </h4>
                {hint && (
                    <span className={`hidden min-w-0 truncate text-[12px] sm:inline ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                        {hint}
                    </span>
                )}
            </div>
            {right}
        </div>
    );
}

function GoalCard({ goal, closes, isLight }: { goal: string; closes: string[]; isLight: boolean }) {
    return (
        <div className={`rounded-xl border p-4 sm:p-5 ${isLight
            ? 'border-blue-200 bg-blue-50/70'
            : 'border-blue-500/20 bg-blue-500/[0.08]'
            }`}>
            <div className="mb-2 flex items-center gap-2">
                <Target size={14} className={isLight ? 'text-blue-600' : 'text-blue-300'} />
                <span className={`text-[11px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-blue-600' : 'text-blue-300'}`}>
                    Your goal for the call
                </span>
            </div>
            <p className={`text-[15.5px] font-semibold leading-relaxed ${isLight ? 'text-slate-900' : 'text-white'}`}>
                {goal}
            </p>
            {closes.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                    <span className={`text-[11px] font-medium ${isLight ? 'text-slate-500' : 'text-white/40'}`}>Closes:</span>
                    {closes.map(gap => (
                        <span
                            key={gap}
                            className={`rounded-md border px-2 py-0.5 text-[10.5px] font-semibold ${isLight
                                ? 'border-amber-200 bg-amber-50 text-amber-700'
                                : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                                }`}>
                            {gap}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

/** One unresolved customer concern + the suggested way to answer it. */
// `onPractice` stays in the prop type (plumbed from MeetingDetails) but is not
// destructured — the Practice-with-Dojo button below is currently disabled.
function OpenLoopCard({ concern, suggestedAnswer, isLight }: {
    concern: string;
    suggestedAnswer?: string;
    isLight: boolean;
    onPractice?: (prompt: string) => void;
}) {
    return (
        <div className={`flex h-full flex-col rounded-xl border p-4 ${isLight
            ? 'border-slate-200 bg-slate-50/70'
            : 'border-white/[0.07] bg-white/[0.03]'
            }`}>
            <div className="flex items-start gap-2.5">
                <Quote size={14} className={`mt-0.5 shrink-0 ${isLight ? 'text-slate-300' : 'text-white/20'}`} />
                <p className={`text-[13.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                    {concern}
                </p>
            </div>
            {suggestedAnswer && (
                <div className={`mt-3 rounded-lg border p-3 ${isLight
                    ? 'border-emerald-200 bg-emerald-50'
                    : 'border-emerald-500/20 bg-emerald-500/[0.08]'
                    }`}>
                    <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`}>
                        Try saying
                    </p>
                    <p className={`text-[13px] leading-relaxed ${isLight ? 'text-emerald-800' : 'text-emerald-100/90'}`}>
                        {suggestedAnswer}
                    </p>
                </div>
            )}
            {/* {onPractice && (
                <button
                    type="button"
                    onClick={() => onPractice(`Help me practice responding to this pushback: "${concern}"`)}
                    className={`mt-3 flex w-fit items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11.5px] font-medium transition-colors ${isLight
                        ? 'border-slate-200 bg-white text-slate-600 hover:border-blue-300 hover:text-blue-600'
                        : 'border-white/10 bg-white/[0.04] text-white/60 hover:border-blue-500/40 hover:text-blue-300'
                        }`}>
                    <Swords size={12} />
                    Practice with Dojo
                </button>
            )} */}
        </div>
    );
}

/**
 * Splits a leading stat off a quantitative value point ("70–80% faster
 * turnaround" → "70–80%" / "faster turnaround"). Strings with no leading
 * number simply render whole — nothing is invented either way.
 */
function splitLeadingStat(text: string): { stat: string | null; rest: string } {
    const trimmed = text.trim();
    const tokens = trimmed.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /[\d₹$€£%]/.test(tokens[i])) i++;
    if (i === 0 || i >= tokens.length) return { stat: null, rest: trimmed };
    return { stat: tokens.slice(0, i).join(' '), rest: tokens.slice(i).join(' ') };
}

function formatDueDate(dueDate?: string): string | null {
    const raw = dueDate?.trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    if (!isNaN(parsed.getTime())) {
        return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return raw;
}

// ── Call-type sections ──────────────────────────────────────────────────────

function OpenWithCard({ recap, isLight }: { recap: string; isLight: boolean }) {
    return (
        <div className={`flex items-start gap-3 rounded-xl border p-4 ${isLight
            ? 'border-slate-200 bg-slate-50/70'
            : 'border-white/[0.07] bg-white/[0.03]'
            }`}>
            <span className={`mt-2 select-none font-serif text-[34px] leading-[0.55] ${isLight ? 'text-slate-300' : 'text-white/20'}`}>
                &ldquo;
            </span>
            <p className={`flex-1 text-[14.5px] leading-relaxed ${isLight ? 'text-slate-800' : 'text-slate-200'}`}>
                {recap}
            </p>
            <CopyButton text={recap} label="opening recap" isLight={isLight} />
        </div>
    );
}

function QuestionsCard({ questions, isLight }: { questions: CoachQuestion[]; isLight: boolean }) {
    const [expanded, setExpanded] = useState(false);
    const visible = expanded ? questions : questions.slice(0, QUESTIONS_PREVIEW_COUNT);
    return (
        <div className={`overflow-hidden rounded-xl border ${isLight
            ? 'border-slate-200 bg-white'
            : 'border-white/[0.07] bg-white/[0.02]'
            }`}>
            <ul className={`divide-y ${isLight ? 'divide-slate-100' : 'divide-white/[0.05]'}`}>
                {visible.map((q, i) => {
                    const text = coachQuestionText(q);
                    const gap = typeof q === 'string' ? undefined : q?.gap?.trim();
                    return (
                        <li key={i} className="flex items-center gap-3 px-4 py-3">
                            {gap && (
                                <span className={`w-[110px] shrink-0 rounded-md border px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wide ${isLight
                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                    : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                                    }`}>
                                    {gap}
                                </span>
                            )}
                            <p className={`min-w-0 flex-1 text-[13.5px] leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-300'}`}>
                                {text}
                            </p>
                            <CopyButton text={text} label={`question ${i + 1}`} isLight={isLight} />
                        </li>
                    );
                })}
            </ul>
            {questions.length > QUESTIONS_PREVIEW_COUNT && (
                <button
                    type="button"
                    onClick={() => setExpanded(prev => !prev)}
                    aria-expanded={expanded}
                    className={`flex w-full items-center justify-center gap-1.5 border-t px-4 py-2.5 text-[12px] font-medium transition-colors ${isLight
                        ? 'border-slate-100 text-blue-600 hover:bg-blue-50/60'
                        : 'border-white/[0.05] text-blue-300 hover:bg-blue-500/[0.06]'
                        }`}>
                    {expanded
                        ? <>Show fewer <ChevronUp size={13} /></>
                        : <>Show all {questions.length} questions <ChevronDown size={13} /></>}
                </button>
            )}
        </div>
    );
}

function ValueCard({ quantitative, qualitative, isLight }: {
    quantitative: string[];
    qualitative: string[];
    isLight: boolean;
}) {
    const columnLabel = `mb-3 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-slate-400' : 'text-white/35'}`;
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {quantitative.length > 0 && (
                <div className={`rounded-xl border p-4 ${isLight ? 'border-slate-200 bg-white' : 'border-white/[0.07] bg-white/[0.02]'}`}>
                    <p className={columnLabel}>In numbers</p>
                    <ul className="space-y-3">
                        {quantitative.map((item, i) => {
                            const { stat, rest } = splitLeadingStat(item);
                            return (
                                <li key={i} className="flex items-baseline gap-2.5">
                                    {stat && (
                                        <span className="shrink-0 text-[19px] font-bold leading-none text-emerald-400">
                                            {stat}
                                        </span>
                                    )}
                                    <span className={`leading-snug ${stat
                                        ? `text-[12.5px] ${isLight ? 'text-slate-600' : 'text-white/55'}`
                                        : `text-[13.5px] font-medium ${isLight ? 'text-slate-700' : 'text-white/75'}`
                                        }`}>
                                        {rest}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
            {qualitative.length > 0 && (
                <div className={`rounded-xl border p-4 ${isLight ? 'border-slate-200 bg-white' : 'border-white/[0.07] bg-white/[0.02]'}`}>
                    <p className={columnLabel}>In their words</p>
                    <ul className="space-y-3">
                        {qualitative.map((item, i) => (
                            <li key={i} className="flex items-start gap-2.5">
                                <Check size={14} className="mt-0.5 shrink-0 text-emerald-400" />
                                <span className={`text-[13px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/70'}`}>
                                    {item}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}

function PromisesCard({ promises, isLight }: { promises: CoachPromise[]; isLight: boolean }) {
    const [done, setDone] = useState<Record<number, boolean>>({});
    const doneCount = promises.filter((_, i) => done[i]).length;
    const allDone = doneCount === promises.length;

    return (
        <div className={`rounded-xl border ${isLight ? 'border-slate-200 bg-white' : 'border-white/[0.07] bg-white/[0.02]'}`}>
            <ul className={`divide-y ${isLight ? 'divide-slate-100' : 'divide-white/[0.05]'}`}>
                {promises.map((p, i) => {
                    const isDone = !!done[i];
                    const due = formatDueDate(p.dueDate);
                    return (
                        <li key={i} className="flex items-center gap-3 px-4 py-3">
                            <button
                                type="button"
                                role="checkbox"
                                aria-checked={isDone}
                                aria-label={`Mark "${p.text}" as ${isDone ? 'not done' : 'done'}`}
                                onClick={() => setDone(prev => ({ ...prev, [i]: !prev[i] }))}
                                className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${isDone
                                    ? 'border-emerald-500 bg-emerald-500 text-white'
                                    : isLight
                                        ? 'border-slate-300 hover:border-emerald-400'
                                        : 'border-white/20 hover:border-emerald-400/70'
                                    }`}>
                                {isDone && <Check size={12} strokeWidth={3} />}
                            </button>
                            <p className={`min-w-0 flex-1 text-[13.5px] leading-relaxed transition-colors ${isDone
                                ? `line-through ${isLight ? 'text-slate-400' : 'text-white/30'}`
                                : isLight ? 'text-slate-700' : 'text-slate-300'
                                }`}>
                                {p.text}
                                {p.owner?.trim() && (
                                    <span className={`font-normal ${isLight ? 'text-slate-400' : 'text-white/35'}`}> · {p.owner}</span>
                                )}
                            </p>
                            {due && (
                                <span className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${isLight
                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                    : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                                    }`}>
                                    <Calendar size={10} />
                                    Due {due}
                                </span>
                            )}
                        </li>
                    );
                })}
            </ul>
            <div className={`flex items-center justify-between border-t px-4 py-2.5 ${isLight ? 'border-slate-100' : 'border-white/[0.05]'}`}>
                <span className={`flex items-center gap-1.5 text-[11.5px] font-medium ${allDone
                    ? 'text-emerald-400'
                    : isLight ? 'text-slate-400' : 'text-white/35'
                    }`}>
                    <ListChecks size={13} />
                    {doneCount} of {promises.length} done
                </span>
            </div>
        </div>
    );
}

// ── Game Plan ───────────────────────────────────────────────────────────────

export default function GamePlan({ summary, date, participants, isLight, onPractice }: GamePlanProps) {
    const playbook = summary.nextCallPlaybook;
    const goal = playbook?.callGoal?.trim() || undefined;
    const recap = playbook?.openingRecap?.trim() || undefined;
    const questions = (playbook?.questionsToAsk ?? []).filter(q => coachQuestionText(q).trim());
    const openLoops = (summary.openLoops ?? []).filter(l => l?.concern?.trim());
    const quantitative = (playbook?.valueAndROI?.quantitative ?? []).map(s => s?.trim() ?? '').filter(Boolean);
    const qualitative = (playbook?.valueAndROI?.qualitative ?? []).map(s => s?.trim() ?? '').filter(Boolean);

    // Promises come from the shared helper (structured field, legacy action
    // items fallback) so UI, copy and PDF all agree.
    const promises = coachPromises(summary);

    // Goal card: the deal gaps the questions close, taken verbatim.
    const closes = Array.from(new Set(questions
        .map(q => (typeof q === 'string' ? '' : q?.gap?.trim() ?? ''))
        .filter(Boolean)))
        .slice(0, 4);

    type SectionDef = {
        key: string;
        title: string;
        hint?: string;
        right?: ReactNode;
        body: ReactNode;
    };
    // Fixed section sequence — identical for every call type. A section whose
    // data is missing shows a quiet placeholder instead of disappearing, so
    // the plan's shape (and numbering) never changes.
    const hasRecap = !!recap;
    const hasQuestions = questions.length > 0;
    const hasLoops = openLoops.length > 0;
    const hasValue = quantitative.length > 0 || qualitative.length > 0;
    const hasPromises = promises.length > 0;

    const sections: SectionDef[] = [
        {
            key: 'open',
            title: 'Open with',
            hint: 'a 30-second recap in their words',
            body: hasRecap
                ? <OpenWithCard recap={recap} isLight={isLight} />
                : <EmptySectionNote text="No recap was captured — open with your own summary of where you left off." isLight={isLight} />,
        },
        {
            key: 'questions',
            title: 'Ask these',
            hint: 'each one closes a gap in the deal',
            body: hasQuestions
                ? <QuestionsCard questions={questions} isLight={isLight} />
                : <EmptySectionNote text="No gap questions were captured on this call." isLight={isLight} />,
        },
        {
            key: 'loops',
            title: 'Close the open loops',
            hint: "concerns they raised that aren't settled yet",
            body: hasLoops
                ? <OpenLoopsGrid loops={openLoops} isLight={isLight} onPractice={onPractice} />
                : <EmptySectionNote text="No open loops — everything they raised was settled on the call." isLight={isLight} />,
        },
        {
            key: 'value',
            title: 'Reinforce the value',
            hint: 'numbers they already agreed with',
            body: hasValue
                ? <ValueCard quantitative={quantitative} qualitative={qualitative} isLight={isLight} />
                : <EmptySectionNote text="No agreed numbers or customer quotes were captured." isLight={isLight} />,
        },
    ];

    if (hasPromises) {
        const earliest = promises
            .map(p => (p.dueDate?.trim() ? new Date(p.dueDate) : null))
            .filter((d): d is Date => !!d && !isNaN(d.getTime()))
            .sort((a, b) => a.getTime() - b.getTime())[0];
        const hint = earliest
            ? `send these before ${earliest.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
            : 'commitments you made on the call';
        sections.push({
            key: 'promises',
            title: 'Promises you made',
            hint,
            body: <PromisesCard promises={promises} isLight={isLight} />,
        });
    } else {
        sections.push({
            key: 'promises',
            title: 'Promises you made',
            hint: 'commitments you made on the call',
            body: <EmptySectionNote text="No commitments were made on this call." isLight={isLight} />,
        });
    }

    const hasGoal = !!goal;
    if (!hasGoal && !hasRecap && !hasQuestions && !hasLoops && !hasValue && !hasPromises) return null;

    // Header meta: date · time · participant names (self excluded).
    const metaParts: string[] = [];
    const parsedDate = new Date(date);
    if (!isNaN(parsedDate.getTime())) {
        metaParts.push(parsedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }));
        metaParts.push(parsedDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
    }
    const participantNames = (participants ?? [])
        .filter(p => p && !p.self)
        .map(p => (p.name || p.email || '').trim())
        .filter(Boolean);
    if (participantNames.length > 0) metaParts.push(participantNames.join(', '));

    return (
        <section id="coach-game-plan" className="mb-10">
            <div className={`overflow-hidden rounded-2xl border ${isLight
                ? 'border-slate-200/80 bg-white shadow-[0_20px_60px_-25px_rgba(30,58,138,0.15)]'
                : 'border-white/[0.07] bg-gray-800/20'
                }`}>
                <div className="p-6 sm:p-7">
                    {/* Header */}
                    <div className={`flex items-center gap-3.5 border-b pb-5 ${isLight ? 'border-slate-100' : 'border-white/[0.06]'}`}>
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${isLight
                            ? 'border-blue-100 bg-blue-50'
                            : 'border-blue-500/25 bg-blue-500/15'
                            }`}>
                            <Compass size={18} className={isLight ? 'text-blue-600' : 'text-blue-300'} />
                        </div>
                        <div className="min-w-0">
                            <h3 className={`text-[19px] font-bold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                                {GAME_PLAN_TITLE}
                            </h3>
                            <p className={`mt-0.5 truncate text-[12px] ${isLight ? 'text-slate-400' : 'text-white/35'}`}>
                                Built from this call to move the deal forward
                            </p>
                        </div>
                    </div>

                    {/* Goal */}
                    {goal && (
                        <div className="mt-5">
                            <GoalCard goal={goal} closes={closes} isLight={isLight} />
                        </div>
                    )}

                    {/* Call-type sections */}
                    {sections.map((s, i) => (
                        <section
                            key={s.key}
                            className={i === 0 ? 'mt-6' : `mt-7 border-t pt-7 ${isLight ? 'border-slate-100' : 'border-white/[0.05]'}`}
                        >
                            <SectionHeader index={i + 1} title={s.title} hint={s.hint} right={s.right} isLight={isLight} />
                            {s.body}
                        </section>
                    ))}
                </div>
            </div>
        </section>
    );
}

function OpenLoopsGrid({ loops, isLight, onPractice }: {
    loops: NonNullable<MeetingDetailedSummary['openLoops']>;
    isLight: boolean;
    onPractice?: (prompt: string) => void;
}) {
    return (
        <div className="grid gap-3 md:grid-cols-2">
            {loops.map((loop, i) => (
                <OpenLoopCard
                    key={i}
                    concern={loop.concern.trim()}
                    suggestedAnswer={loop.suggestedAnswer?.trim() || undefined}
                    isLight={isLight}
                    onPractice={onPractice}
                />
            ))}
        </div>
    );
}