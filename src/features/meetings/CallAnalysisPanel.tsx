import { useState } from 'react';
import type { ReactNode } from 'react';
import { BarChart2, Check, CheckSquare, ChevronDown, ChevronRight, ChevronUp, Quote, Shield, Sparkles, TrendingUp, Zap } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { BANTField, DealTrigger, LiveAnalysisData, MEDDICField, Meeting, Objection, Signal } from '@/types';
import { fieldDisplay } from '@/lib/bantMeddic';
import { partitionObjections, splitRepFollowUps } from '@/lib/objections';
import { formatCallTime } from '@/lib/liveAnalysisV2';
import { EmptySectionNote } from './coachShared';
import CoachSectionNav from './CoachSectionNav';
import { analysisSectionFlags, visibleAnalysisSections } from '@/lib/analysisSections';

/**
 * Call Analysis — the post-call intelligence tab on Meeting Details.
 *
 * Same visual language as the Coach tab (numbered section headers, roomy
 * rounded-xl cards, 13–15px type) instead of the compact overlay accordion.
 * Presentation only: every value comes straight from `liveAnalysis`. The
 * floating overlay keeps using LiveAnalysisContent and is untouched.
 */

type Props = {
    analysisData: LiveAnalysisData;
    isLight: boolean;
    /** Sticky header height — keeps the nav rail and scrolled sections clear of it. */
    stickyTop: number;
    /** Re-discovery trigger for the section rail on refetch/regeneration. */
    meeting: Meeting;
};

type Status = 'confirmed' | 'partial' | 'missing' | '';

const MEDDIC_KEYS = ['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const;
const BANT_KEYS = ['budget', 'authority', 'need', 'timeline'] as const;

const titleCase = (key: string) => key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// ── Theme tokens ────────────────────────────────────────────────────────────

const card = (isLight: boolean) =>
    isLight ? 'border-slate-200 bg-white' : 'border-white/[0.07] bg-white/[0.02]';

const bodyText = (isLight: boolean) => (isLight ? 'text-slate-700' : 'text-slate-300');
const mutedText = (isLight: boolean) => (isLight ? 'text-slate-400' : 'text-white/35');

const STATUS_META: Record<'confirmed' | 'partial' | 'missing', { label: string; dot: string; pill: [string, string]; card: [string, string] }> = {
    confirmed: {
        label: 'Confirmed',
        dot: 'bg-emerald-500',
        pill: ['border-emerald-200 bg-emerald-50 text-emerald-700', 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'],
        card: ['border-emerald-200 bg-emerald-50/40', 'border-emerald-500/20 bg-emerald-500/[0.04]'],
    },
    partial: {
        label: 'Partial',
        dot: 'bg-amber-500',
        pill: ['border-amber-200 bg-amber-50 text-amber-700', 'border-amber-500/25 bg-amber-500/10 text-amber-300'],
        card: ['border-amber-200 bg-amber-50/40', 'border-amber-500/20 bg-amber-500/[0.04]'],
    },
    missing: {
        label: 'Missing',
        dot: 'bg-slate-300 dark:bg-slate-600',
        pill: ['border-slate-200 bg-slate-50 text-slate-500', 'border-white/10 bg-white/[0.04] text-white/45'],
        card: ['border-slate-200 bg-white', 'border-white/[0.07] bg-white/[0.02]'],
    },
};

const statusMeta = (s: Status) => STATUS_META[s === 'confirmed' || s === 'partial' ? s : 'missing'];

// ── Layout pieces ───────────────────────────────────────────────────────────

function SectionHeader({ index, icon, title, hint, right, isLight }: {
    index: number;
    icon: ReactNode;
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
                <span className={isLight ? 'text-slate-400' : 'text-white/40'}>{icon}</span>
                <h4 className={`shrink-0 text-[15px] font-semibold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                    {title}
                </h4>
                {hint && (
                    <span className={`hidden min-w-0 truncate text-[12px] sm:inline ${mutedText(isLight)}`}>{hint}</span>
                )}
            </div>
            {right}
        </div>
    );
}

function CountPill({ children, tone, isLight }: { children: ReactNode; tone: 'good' | 'warn' | 'bad' | 'neutral'; isLight: boolean }) {
    const map = {
        good: ['border-emerald-200 bg-emerald-50 text-emerald-700', 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'],
        warn: ['border-amber-200 bg-amber-50 text-amber-700', 'border-amber-500/25 bg-amber-500/10 text-amber-300'],
        bad: ['border-red-200 bg-red-50 text-red-700', 'border-red-500/25 bg-red-500/10 text-red-300'],
        neutral: ['border-slate-200 bg-slate-50 text-slate-600', 'border-white/10 bg-white/[0.05] text-white/55'],
    } as const;
    return (
        <span className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-bold ${map[tone][isLight ? 0 : 1]}`}>
            {children}
        </span>
    );
}

const toneForRatio = (found: number, total: number): 'good' | 'warn' | 'bad' => {
    const r = total === 0 ? 0 : found / total;
    return r >= 0.7 ? 'good' : r >= 0.4 ? 'warn' : 'bad';
};

// ── Overview tiles ──────────────────────────────────────────────────────────

function OverviewTile({ label, value, sub, progress, tone, isLight }: {
    label: string;
    value: string;
    sub: string;
    progress?: number;
    tone: 'good' | 'warn' | 'bad' | 'neutral';
    isLight: boolean;
}) {
    const bar = { good: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', neutral: 'bg-blue-500' }[tone];
    return (
        <div className={`rounded-xl border p-4 sm:p-5 ${card(isLight)}`}>
            <p className={`text-[10px] font-bold uppercase tracking-[0.14em] ${mutedText(isLight)}`}>{label}</p>
            <p className={`mt-2 text-[28px] font-semibold leading-none tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>
                {value}
            </p>
            <p className={`mt-1.5 text-[12px] ${isLight ? 'text-slate-500' : 'text-white/45'}`}>{sub}</p>
            {progress !== undefined && (
                <div className={`mt-3 h-1.5 overflow-hidden rounded-full ${isLight ? 'bg-slate-100' : 'bg-white/[0.07]'}`}>
                    <div className={`h-full rounded-full transition-all ${bar}`} style={{ width: `${Math.round(progress * 100)}%` }} />
                </div>
            )}
        </div>
    );
}

// ── BANT / MEDDICC field card ───────────────────────────────────────────────

function FieldCard({ label, field, isLight }: { label: string; field: BANTField | MEDDICField; isLight: boolean }) {
    const { body, evidence, showDisclosure } = fieldDisplay(field);
    const [open, setOpen] = useState(false);
    const meta = statusMeta(field.status);
    const refs = field.evidence_refs;

    return (
        <div className={`flex h-full flex-col rounded-xl border p-4 sm:p-5 ${meta.card[isLight ? 0 : 1]}`}>
            <div className="mb-3 flex items-center justify-between gap-3">
                <h5 className={`text-[14px] font-semibold tracking-tight ${isLight ? 'text-slate-900' : 'text-white'}`}>{label}</h5>
                <span className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wide ${meta.pill[isLight ? 0 : 1]}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${meta.dot}`} />
                    {meta.label}
                </span>
            </div>

            {body !== '' ? (
                <p className={`text-[13.5px] leading-relaxed ${bodyText(isLight)}`}>{body}</p>
            ) : field.status === 'confirmed' ? null : (
                <p className={`text-[13px] italic ${mutedText(isLight)}`}>Not captured on this call</p>
            )}

            {showDisclosure && (
                <div className="mt-3">
                    <button
                        type="button"
                        onClick={() => setOpen(o => !o)}
                        aria-expanded={open}
                        className={`flex items-center gap-1 text-[11.5px] font-semibold transition-colors ${isLight ? 'text-slate-500 hover:text-slate-800' : 'text-white/40 hover:text-white/70'}`}
                    >
                        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                        Evidence ({evidence.length})
                    </button>
                    <AnimatePresence initial={false}>
                        {open && (
                            <motion.ul
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                                className="overflow-hidden"
                            >
                                <div className={`mt-2 space-y-2 border-l-2 pl-3 ${isLight ? 'border-slate-200' : 'border-white/10'}`}>
                                    {evidence.map((e, i) => {
                                        const at = formatCallTime(refs?.[i]?.t_start_ms);
                                        return (
                                            <li key={i} className={`list-none text-[12.5px] leading-relaxed ${isLight ? 'text-slate-500' : 'text-white/50'}`}>
                                                {/* {at && (
                                                    <span className={`mr-1.5 font-mono text-[10.5px] ${mutedText(isLight)}`}>{at}</span>
                                                )} */}
                                                {e}
                                            </li>
                                        );
                                    })}
                                </div>
                            </motion.ul>
                        )}
                    </AnimatePresence>
                </div>
            )}

            {field.suggested_question && field.status !== 'confirmed' && (
                <div className={`mt-3 rounded-lg border p-3 ${isLight ? 'border-blue-200 bg-blue-50' : 'border-blue-500/20 bg-blue-500/[0.08]'}`}>
                    <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-blue-600' : 'text-blue-300'}`}>
                        Ask next time
                    </p>
                    <p className={`text-[13px] leading-relaxed ${isLight ? 'text-blue-900' : 'text-blue-100/90'}`}>
                        {field.suggested_question}
                    </p>
                </div>
            )}
        </div>
    );
}

// ── Signals ─────────────────────────────────────────────────────────────────

const SIGNAL_TYPE_STYLE: Record<string, [string, string]> = {
    buying_intent: ['bg-emerald-100 text-emerald-700 border-emerald-200', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25'],
    aspiration: ['bg-blue-100 text-blue-700 border-blue-200', 'bg-blue-500/15 text-blue-300 border-blue-500/25'],
    engagement: ['bg-cyan-100 text-cyan-700 border-cyan-200', 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25'],
    validation_seeking: ['bg-violet-100 text-violet-700 border-violet-200', 'bg-violet-500/15 text-violet-300 border-violet-500/25'],
    authority_signal: ['bg-emerald-100 text-emerald-700 border-emerald-200', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25'],
    frustration: ['bg-amber-100 text-amber-700 border-amber-200', 'bg-amber-500/15 text-amber-300 border-amber-500/25'],
    risk: ['bg-red-100 text-red-700 border-red-200', 'bg-red-500/15 text-red-300 border-red-500/25'],
    urgency: ['bg-orange-100 text-orange-700 border-orange-200', 'bg-orange-500/15 text-orange-300 border-orange-500/25'],
    competitor_signal: ['bg-red-100 text-red-700 border-red-200', 'bg-red-500/15 text-red-300 border-red-500/25'],
    stall_signal: ['bg-slate-100 text-slate-600 border-slate-200', 'bg-zinc-500/15 text-zinc-300 border-zinc-500/25'],
    cost: ['bg-orange-100 text-orange-700 border-orange-200', 'bg-orange-500/15 text-orange-300 border-orange-500/25'],
    process_signal: ['bg-indigo-100 text-indigo-700 border-indigo-200', 'bg-indigo-500/15 text-indigo-300 border-indigo-500/25'],
    timeline: ['bg-purple-100 text-purple-700 border-purple-200', 'bg-purple-500/15 text-purple-300 border-purple-500/25'],
};

const signalTypeClass = (type: string, isLight: boolean) => {
    const pair = SIGNAL_TYPE_STYLE[type];
    if (!pair) return isLight ? 'bg-slate-100 text-slate-500 border-slate-200' : 'bg-white/10 text-white/50 border-white/10';
    return pair[isLight ? 0 : 1];
};

const signalAccent = (s: Signal) => {
    if (s.category === 'negative' && s.intensity === 'high') return { bar: 'bg-red-500', label: 'High risk' };
    if (s.category === 'negative') return { bar: 'bg-amber-400', label: 'Watch' };
    if (s.category === 'positive') return { bar: 'bg-emerald-500', label: 'Positive' };
    return { bar: 'bg-slate-300 dark:bg-white/20', label: 'Neutral' };
};

function SignalCard({ signal, isLight }: { signal: Signal; isLight: boolean }) {
    const accent = signalAccent(signal);
    return (
        <div className={`flex h-full overflow-hidden rounded-xl border ${card(isLight)}`}>
            <div className={`w-1 shrink-0 ${accent.bar}`} />
            <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                        {signal.signal_type.slice(0, 2).map(type => (
                            <span key={type} className={`rounded-md border px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${signalTypeClass(type, isLight)}`}>
                                {type.replace(/_/g, ' ')}
                            </span>
                        ))}
                    </div>
                    <span className={`text-[11px] font-medium capitalize ${mutedText(isLight)}`}>
                        {accent.label} · {signal.intensity}
                    </span>
                </div>
                <div className="flex items-start gap-2.5">
                    <Quote size={14} className={`mt-1 shrink-0 ${isLight ? 'text-slate-300' : 'text-white/20'}`} />
                    <p className={`text-[14px] italic leading-relaxed ${bodyText(isLight)}`}>{signal.quote}</p>
                </div>
                {signal.ask_now && (
                    <div className={`mt-3 rounded-lg border p-3 ${isLight ? 'border-blue-200 bg-blue-50' : 'border-blue-500/20 bg-blue-500/[0.08]'}`}>
                        <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-blue-600' : 'text-blue-300'}`}>
                            Ask
                        </p>
                        <p className={`text-[13px] leading-relaxed ${isLight ? 'text-blue-900' : 'text-blue-100/90'}`}>{signal.ask_now}</p>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── Objections ──────────────────────────────────────────────────────────────

const HANDLED_LABEL: Record<string, string> = {
    resolved: 'Resolved',
    partially: 'Partly answered',
    unresolved: 'Unresolved',
};

function ObjectionCard({ obj, checked, onToggle, isLight }: {
    obj: Objection;
    checked: boolean;
    onToggle: () => void;
    isLight: boolean;
}) {
    const isFollowUp = obj.type === 'ae_deferral';
    const muted = checked || Boolean(obj.resolved);
    const label = isFollowUp ? 'Follow-up' : (obj.handled && HANDLED_LABEL[obj.handled]) || 'Objection';

    const shell = muted
        ? (isLight ? 'border-slate-100 bg-slate-50 opacity-60' : 'border-white/[0.04] bg-white/[0.01] opacity-60')
        : isFollowUp
            ? (isLight ? 'border-amber-200 bg-amber-50/60 hover:bg-amber-50' : 'border-amber-500/20 bg-amber-500/[0.05] hover:bg-amber-500/[0.08]')
            : (isLight ? 'border-slate-200 bg-white hover:bg-slate-50' : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]');

    const tag = isFollowUp
        ? (isLight ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-amber-500/25 bg-amber-500/10 text-amber-300')
        : obj.handled === 'resolved'
            ? (isLight ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300')
            : obj.handled === 'unresolved'
                ? (isLight ? 'border-red-200 bg-red-50 text-red-700' : 'border-red-500/25 bg-red-500/10 text-red-300')
                : (isLight ? 'border-slate-200 bg-slate-50 text-slate-600' : 'border-white/10 bg-white/[0.05] text-white/55');

    return (
        <motion.button
            type="button"
            layout
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ duration: 0.15 }}
            onClick={onToggle}
            aria-pressed={muted}
            className={`flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors sm:p-5 ${shell}`}
        >
            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${muted
                ? 'border-emerald-500 bg-emerald-500/80'
                : isLight ? 'border-slate-300' : 'border-white/25'
                }`}>
                {muted && <Check size={12} className="text-white" strokeWidth={3} />}
            </span>
            <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded-md border px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${tag}`}>{label}</span>
                    {(obj.category_label || obj.topic) && (
                        <span className={`truncate text-[12px] ${mutedText(isLight)}`}>{obj.category_label || obj.topic}</span>
                    )}
                    <span className={`ml-auto text-[11.5px] capitalize ${mutedText(isLight)}`}>{obj.owner}</span>
                </div>
                <p className={`text-[14px] leading-relaxed ${muted ? 'line-through' : ''} ${muted ? (isLight ? 'text-slate-400' : 'text-white/30') : bodyText(isLight)}`}>
                    {obj.quote}
                </p>
                {!muted && obj.type === 'customer_question' && obj.suggested_answer && (
                    <div className={`mt-3 rounded-lg border p-3 ${isLight ? 'border-emerald-200 bg-emerald-50' : 'border-emerald-500/20 bg-emerald-500/[0.08]'}`}>
                        <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`}>
                            Try saying
                        </p>
                        <p className={`text-[13px] leading-relaxed ${isLight ? 'text-emerald-800' : 'text-emerald-100/90'}`}>
                            {obj.suggested_answer}
                        </p>
                    </div>
                )}
                {obj.rep_response && (
                    <p className={`mt-3 text-[12.5px] italic leading-relaxed ${isLight ? 'text-slate-500' : 'text-white/45'}`}>
                        You said: “{obj.rep_response}”
                    </p>
                )}
            </div>
        </motion.button>
    );
}

function Collapsible({ label, count, defaultOpen, isLight, children }: {
    label: string;
    count: number;
    defaultOpen: boolean;
    isLight: boolean;
    children: ReactNode;
}) {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                className={`flex w-full items-center justify-between rounded-lg px-1 py-2 text-[12px] font-bold uppercase tracking-[0.12em] transition-colors ${isLight ? 'text-slate-500 hover:text-slate-800' : 'text-white/40 hover:text-white/70'}`}
            >
                <span>{label} · {count}</span>
                {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
            {open && <div className="mt-2 space-y-3">{children}</div>}
        </div>
    );
}

// ── Deal alerts ─────────────────────────────────────────────────────────────

const TRIGGER_META: Record<DealTrigger, { label: string; card: [string, string]; accent: [string, string] }> = {
    pricing_objection: { label: 'Pricing Objection', card: ['border-red-200 bg-red-50/60', 'border-red-500/20 bg-red-500/[0.06]'], accent: ['text-red-600', 'text-red-300'] },
    discount_request: { label: 'Discount Request', card: ['border-orange-200 bg-orange-50/60', 'border-orange-500/20 bg-orange-500/[0.06]'], accent: ['text-orange-600', 'text-orange-300'] },
    competitor_comparison: { label: 'Competitor Compare', card: ['border-yellow-200 bg-yellow-50/60', 'border-yellow-500/20 bg-yellow-500/[0.06]'], accent: ['text-yellow-700', 'text-yellow-300'] },
    procurement_pressure: { label: 'Procurement Pressure', card: ['border-violet-200 bg-violet-50/60', 'border-violet-500/20 bg-violet-500/[0.06]'], accent: ['text-violet-600', 'text-violet-300'] },
    budget_concern: { label: 'Budget Concern', card: ['border-orange-200 bg-orange-50/60', 'border-orange-500/20 bg-orange-500/[0.06]'], accent: ['text-orange-600', 'text-orange-300'] },
    closing_signal: { label: 'Closing Signal', card: ['border-emerald-200 bg-emerald-50/60', 'border-emerald-500/20 bg-emerald-500/[0.06]'], accent: ['text-emerald-600', 'text-emerald-300'] },
};

function DealAlertCard({ alert, isLight }: { alert: NonNullable<LiveAnalysisData['dealOptimizer']>[number]; isLight: boolean }) {
    const meta = TRIGGER_META[alert.trigger] ?? TRIGGER_META.pricing_objection;
    const i = isLight ? 0 : 1;
    return (
        <div className={`rounded-xl border p-4 sm:p-5 ${meta.card[i]}`}>
            <div className="mb-3 flex items-center justify-between gap-2">
                <span className={`text-[11px] font-bold uppercase tracking-[0.14em] ${meta.accent[i]}`}>{meta.label}</span>
                <span className={`text-[11.5px] capitalize ${mutedText(isLight)}`}>{alert.intensity} intensity</span>
            </div>
            <p className={`text-[15px] font-semibold leading-snug ${isLight ? 'text-slate-900' : 'text-white'}`}>{alert.headline}</p>
            <p className={`mt-2 text-[13.5px] italic leading-relaxed ${isLight ? 'text-slate-500' : 'text-white/50'}`}>“{alert.quote}”</p>

            {(alert.moves ?? []).length > 0 && (
                <ol className="mt-4 space-y-2.5">
                    {alert.moves.map((move, n) => (
                        <li key={n} className="flex items-start gap-3">
                            <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${isLight ? 'bg-white text-slate-700 shadow-sm' : 'bg-white/10 text-white/80'}`}>
                                {n + 1}
                            </span>
                            <p className={`text-[13.5px] leading-relaxed ${bodyText(isLight)}`}>{move}</p>
                        </li>
                    ))}
                </ol>
            )}

            {alert.anchor && (
                <div className={`mt-4 flex items-start gap-2.5 rounded-lg border p-3 ${isLight ? 'border-white bg-white/80' : 'border-white/[0.07] bg-white/[0.04]'}`}>
                    <Sparkles size={14} className={`mt-0.5 shrink-0 ${meta.accent[i]}`} />
                    <p className={`text-[13px] leading-relaxed ${meta.accent[i]}`}>{alert.anchor}</p>
                </div>
            )}
        </div>
    );
}

// ── Main panel ──────────────────────────────────────────────────────────────

export default function CallAnalysisPanel({ analysisData, isLight, stickyTop, meeting }: Props) {
    const meddicFound = MEDDIC_KEYS.filter(k => analysisData.meddic[k]?.status === 'confirmed').length;
    const bantFound = BANT_KEYS.filter(k => analysisData.bant[k]?.status === 'confirmed').length;

    const signals = analysisData.signals ?? [];
    const positiveSignals = signals.filter(s => s.category === 'positive').length;
    const riskSignals = signals.filter(s => s.category === 'negative').length;

    const { objections: prospectObjections, followUps } = splitRepFollowUps(analysisData.objections ?? []);
    const { active, resolved } = partitionObjections(prospectObjections);

    const dealAlerts = analysisData.dealOptimizer ?? [];

    const [checked, setChecked] = useState<Set<string>>(new Set());
    const toggle = (key: string) =>
        setChecked(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
        });

    const renderObjection = (obj: Objection) => {
        const key = obj.id ?? obj.quote;
        return <ObjectionCard key={key} obj={obj} checked={checked.has(key)} onToggle={() => toggle(key)} isLight={isLight} />;
    };

    // One source of truth for "is this section on screen" — the rail below lists exactly these.
    const { signals: hasSignals, objections: showObjections, dealAlerts: hasDealAlerts } = analysisSectionFlags(analysisData);
    const navSections = visibleAnalysisSections(analysisData);

    // Section numbering follows what is actually rendered, like the Coach tab.
    let n = 0;
    const next = () => ++n;

    return (
        // Two columns like the Coach and Transcript tabs: analysis on the
        // left, sticky section navigation on the right.
        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(260px,300px)]">
            <div className="min-w-0 space-y-10">
                {/* Overview */}
                <div id="analysis-overview" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                    <OverviewTile label="MEDDICC" value={`${meddicFound}/7`} sub="criteria confirmed"
                        progress={meddicFound / 7} tone={toneForRatio(meddicFound, 7)} isLight={isLight} />
                    <OverviewTile label="BANT" value={`${bantFound}/4`} sub="qualifiers confirmed"
                        progress={bantFound / 4} tone={toneForRatio(bantFound, 4)} isLight={isLight} />
                    <OverviewTile label="Signals" value={String(signals.length)}
                        sub={signals.length === 0 ? 'none detected' : `${positiveSignals} positive · ${riskSignals} risk`}
                        tone={riskSignals > positiveSignals ? 'bad' : positiveSignals > 0 ? 'good' : 'neutral'} isLight={isLight} />
                    <OverviewTile label="Objections" value={String(active.length)}
                        sub={active.length === 0 ? 'nothing open' : `open${resolved.length ? ` · ${resolved.length} resolved` : ''}`}
                        tone={active.length === 0 ? 'good' : active.length > 2 ? 'bad' : 'warn'} isLight={isLight} />
                </div>

                {/* MEDDICC */}
                <section id="analysis-meddicc">
                    <SectionHeader index={next()} icon={<Shield size={15} />} title="MEDDICC"
                        hint="Qualification across seven criteria"
                        right={<CountPill tone={toneForRatio(meddicFound, 7)} isLight={isLight}>{meddicFound}/7 confirmed</CountPill>}
                        isLight={isLight} />
                    <div className="grid gap-3 md:grid-cols-2">
                        {MEDDIC_KEYS.map(key => (
                            <FieldCard key={key} label={titleCase(key)} field={analysisData.meddic[key]} isLight={isLight} />
                        ))}
                    </div>
                </section>

                {/* BANT */}
                <section id="analysis-bant">
                    <SectionHeader index={next()} icon={<BarChart2 size={15} />} title="BANT"
                        hint="Budget, authority, need, timeline"
                        right={<CountPill tone={toneForRatio(bantFound, 4)} isLight={isLight}>{bantFound}/4 confirmed</CountPill>}
                        isLight={isLight} />
                    <div className="grid gap-3 md:grid-cols-2">
                        {BANT_KEYS.map(key => (
                            <FieldCard key={key} label={titleCase(key)} field={analysisData.bant[key]} isLight={isLight} />
                        ))}
                    </div>
                </section>

                {/* Buying signals */}
                {hasSignals && (
                    <section id="analysis-signals">
                        <SectionHeader index={next()} icon={<Zap size={15} />} title="Buying signals"
                            hint="What the prospect said, and what to ask"
                            right={<CountPill tone={riskSignals > positiveSignals ? 'bad' : positiveSignals > 0 ? 'good' : 'neutral'} isLight={isLight}>{signals.length}</CountPill>}
                            isLight={isLight} />
                        <div className="grid gap-3 md:grid-cols-2">
                            {signals.map(s => <SignalCard key={s.id ?? s.quote} signal={s} isLight={isLight} />)}
                        </div>
                    </section>
                )}

                {/* Objections */}
                {showObjections && (
                    <section id="analysis-objections">
                        <SectionHeader index={next()} icon={<CheckSquare size={15} />} title="Objections"
                            hint="Tap a card to mark it handled"
                            right={<CountPill tone={active.length === 0 ? 'good' : 'warn'} isLight={isLight}>{active.length} open</CountPill>}
                            isLight={isLight} />
                        <div className="space-y-3">
                            {analysisData.objections.length === 0 && (
                                <EmptySectionNote isLight={isLight} text="Objection detection is off for internal meetings." />
                            )}
                            {analysisData.objections.length > 0 && prospectObjections.length === 0 && (
                                <EmptySectionNote isLight={isLight} text="No objections from the prospect on this call." />
                            )}
                            <AnimatePresence initial={false}>{active.map(renderObjection)}</AnimatePresence>
                            {resolved.length > 0 && (
                                <Collapsible label="Resolved" count={resolved.length} defaultOpen={false} isLight={isLight}>
                                    <AnimatePresence initial={false}>{resolved.map(renderObjection)}</AnimatePresence>
                                </Collapsible>
                            )}
                            {followUps.length > 0 && (
                                <Collapsible label="Your follow-ups" count={followUps.length} defaultOpen isLight={isLight}>
                                    <AnimatePresence initial={false}>{followUps.map(renderObjection)}</AnimatePresence>
                                </Collapsible>
                            )}
                        </div>
                    </section>
                )}

                {/* Deal alerts */}
                {hasDealAlerts && (
                    <section id="analysis-deal-alerts">
                        <SectionHeader index={next()} icon={<TrendingUp size={15} />} title="Deal alerts"
                            hint="Negotiation triggers and suggested moves"
                            right={<CountPill tone="warn" isLight={isLight}>{dealAlerts.length}</CountPill>}
                            isLight={isLight} />
                        <div className="grid gap-3 lg:grid-cols-2">
                            {dealAlerts.map(a => <DealAlertCard key={a.id ?? a.quote} alert={a} isLight={isLight} />)}
                        </div>
                    </section>
                )}
            </div>
            <CoachSectionNav
                isLight={isLight}
                stickyTop={stickyTop}
                meeting={meeting}
                sections={navSections}
                title="Analysis sections"
            />
        </div>
    );
}