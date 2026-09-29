import React, { useState } from 'react';
import { Shield, BarChart2, AlertTriangle, Zap, CheckSquare, ChevronDown, ChevronRight, ChevronUp, TrendingUp, Sparkles, ThumbsUp, ThumbsDown } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { useResolvedTheme } from '@/hooks';
import { FieldRowProps, LiveAnalysisContentProps, SectionToggleProps, DealTrigger, Objection } from '@/types';
import { partitionObjections, splitRepFollowUps } from '@/lib/objections';
import { fieldDisplay, fieldText } from '@/lib/bantMeddic';
import { formatCallTime } from '@/lib/liveAnalysisV2';

// ─── Status helpers — overlay (dark glass) variants ────────────────────────
const statusDot = (status: string) => {
    if (status === 'confirmed') return 'bg-emerald-400';
    if (status === 'partial') return 'bg-amber-400';
    return 'bg-white/20';
};

const statusRing = (status: string) => {
    if (status === 'confirmed') return 'border-emerald-500/30 bg-emerald-500/5';
    if (status === 'partial') return 'border-amber-500/30 bg-amber-500/5';
    return 'border-white/[0.06] bg-white/[0.02]';
};

const emojiColor = (status: string) => {
    if (status === 'confirmed') return 'text-emerald-400';
    if (status === 'partial') return 'text-amber-400';
    return 'text-white/20';
};

// ─── Status helpers — analysis tab (theme-aware) variants ──────────────────
const statusDotThemed = (status: string) => {
    if (status === 'confirmed') return 'bg-emerald-500';
    if (status === 'partial') return 'bg-amber-500';
    return 'bg-slate-300 dark:bg-slate-600';
};

const statusRingThemed = (status: string, isLight: boolean) => {
    if (status === 'confirmed') return isLight
        ? 'border-emerald-200 bg-emerald-50'
        : 'border-emerald-500/25 bg-emerald-500/5';
    if (status === 'partial') return isLight
        ? 'border-amber-200 bg-amber-50'
        : 'border-amber-500/25 bg-amber-500/5';
    return isLight
        ? 'border-slate-200 bg-slate-50'
        : 'border-white/[0.06] bg-white/[0.02]';
};

const emojiColorThemed = (status: string, isLight: boolean) => {
    if (status === 'confirmed') return isLight ? 'text-emerald-600' : 'text-emerald-400';
    if (status === 'partial') return isLight ? 'text-amber-600' : 'text-amber-400';
    return isLight ? 'text-slate-300' : 'text-white/20';
};

const signalTypeColor = (type: string) => {
    const map: Record<string, string> = {
        buying_intent: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
        aspiration: 'bg-blue-500/15 text-blue-400 border-blue-500/25',
        engagement: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25',
        validation_seeking: 'bg-violet-500/15 text-violet-400 border-violet-500/25',
        authority_signal: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
        frustration: 'bg-amber-500/15 text-amber-400 border-amber-500/25',
        risk: 'bg-red-500/15 text-red-400 border-red-500/25',
        urgency: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        competitor_signal: 'bg-red-500/15 text-red-300 border-red-500/20',
        stall_signal: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25',
        cost: 'bg-orange-500/15 text-orange-400 border-orange-500/25',
        process_signal: 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25',
        timeline: 'bg-purple-500/15 text-purple-400 border-purple-500/25',
    };
    return map[type] || 'bg-white/10 text-white/50 border-white/10';
};

const signalTypeColorThemed = (type: string, isLight: boolean) => {
    const map: Record<string, [string, string]> = {
        buying_intent: ['bg-emerald-100 text-emerald-700 border-emerald-200', 'bg-emerald-500/15 text-emerald-400 border-emerald-500/25'],
        aspiration: ['bg-blue-100 text-blue-700 border-blue-200', 'bg-blue-500/15 text-blue-400 border-blue-500/25'],
        engagement: ['bg-cyan-100 text-cyan-700 border-cyan-200', 'bg-cyan-500/15 text-cyan-400 border-cyan-500/25'],
        validation_seeking: ['bg-violet-100 text-violet-700 border-violet-200', 'bg-violet-500/15 text-violet-400 border-violet-500/25'],
        authority_signal: ['bg-emerald-100 text-emerald-600 border-emerald-200', 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20'],
        frustration: ['bg-amber-100 text-amber-700 border-amber-200', 'bg-amber-500/15 text-amber-400 border-amber-500/25'],
        risk: ['bg-red-100 text-red-700 border-red-200', 'bg-red-500/15 text-red-400 border-red-500/25'],
        urgency: ['bg-orange-100 text-orange-700 border-orange-200', 'bg-orange-500/15 text-orange-400 border-orange-500/25'],
        competitor_signal: ['bg-red-100 text-red-600 border-red-200', 'bg-red-500/15 text-red-300 border-red-500/20'],
        stall_signal: ['bg-slate-100 text-slate-600 border-slate-200', 'bg-zinc-500/15 text-zinc-400 border-zinc-500/25'],
        cost: ['bg-orange-100 text-orange-700 border-orange-200', 'bg-orange-500/15 text-orange-400 border-orange-500/25'],
        process_signal: ['bg-indigo-100 text-indigo-700 border-indigo-200', 'bg-indigo-500/15 text-indigo-400 border-indigo-500/25'],
        timeline: ['bg-purple-100 text-purple-700 border-purple-200', 'bg-purple-500/15 text-purple-400 border-purple-500/25'],
    };
    const pair = map[type];
    if (!pair) return isLight ? 'bg-slate-100 text-slate-500 border-slate-200' : 'bg-white/10 text-white/50 border-white/10';
    return isLight ? pair[0] : pair[1];
};

// ─── SectionToggle ─────────────────────────────────────────────────────────
const SectionToggle: React.FC<SectionToggleProps> = ({
    icon, title, badge, badgeColor = 'bg-white/10 text-white/50',
    children, defaultOpen = false, themed = false, isLight = false,
}) => {
    const [open, setOpen] = useState(defaultOpen);

    if (themed) {
        return (
            <div className="mb-1">
                <button
                    onClick={() => setOpen(v => !v)}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 transition-colors group rounded-lg ${isLight ? 'hover:bg-slate-100' : 'hover:bg-white/[0.03]'
                        }`}
                >
                    <span className={`transition-colors ${isLight ? 'text-slate-400 group-hover:text-slate-600' : 'text-white/40 group-hover:text-white/60'}`}>
                        {icon}
                    </span>
                    <span className={`text-[11px] font-bold uppercase tracking-[0.12em] flex-1 text-left transition-colors ${isLight ? 'text-slate-500 group-hover:text-slate-700' : 'text-white/50 group-hover:text-white/70'
                        }`}>
                        {title}
                    </span>
                    {badge && (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor}`}>
                            {badge}
                        </span>
                    )}
                    <span className={`transition-colors ${isLight ? 'text-slate-300 group-hover:text-slate-500' : 'text-white/20 group-hover:text-white/40'}`}>
                        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </span>
                </button>
                <AnimatePresence initial={false}>
                    {open && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                            className="overflow-hidden"
                        >
                            <div className="px-4 pb-2">{children}</div>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        );
    }

    // Original overlay variant
    return (
        <div className="mb-1">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2.5 px-4 py-2 hover:bg-white/[0.03] transition-colors group"
            >
                <span className="text-white/40 group-hover:text-white/60 transition-colors">{icon}</span>
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-white/50 group-hover:text-white/70 transition-colors flex-1 text-left">
                    {title}
                </span>
                {badge && (
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${badgeColor}`}>
                        {badge}
                    </span>
                )}
                <span className="text-white/20 group-hover:text-white/40 transition-colors">
                    {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </span>
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                        className="overflow-hidden"
                    >
                        <div className="px-4 pb-2">{children}</div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── Evidence disclosure ───────────────────────────────────────────────────
// The supporting statements behind a field's assessment, collapsed by default.
// One component for both FieldRow variants: two copies of this drifting apart
// is exactly the failure the bantMeddic accessors exist to prevent.
const EvidenceDisclosure: React.FC<{
    items: string[];
    open: boolean;
    onToggle: () => void;
    isLight: boolean;
    /** v2: where each item was said (parallel to `items`) — rendered as a call-time chip. */
    refs?: Array<{ t_start_ms?: number }>;
}> = ({ items, open, onToggle, isLight, refs }) => (
    <>
        <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className={`flex items-center gap-1 mt-1 text-[10px] font-semibold tracking-wide transition-colors ${
                isLight ? 'text-slate-400 hover:text-slate-600' : 'text-white/30 hover:text-white/55'
            }`}
        >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            Evidence ({items.length})
        </button>
        <AnimatePresence initial={false}>
            {open && (
                <motion.ul
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className={`overflow-hidden list-disc pl-4 mt-1 space-y-0.5 text-[11px] leading-relaxed ${
                        isLight ? 'text-slate-500' : 'text-white/45'
                    }`}
                >
                    {items.map((e, i) => {
                        const at = formatCallTime(refs?.[i]?.t_start_ms);
                        return (
                            <li key={i}>
                                {at && (
                                    <span className={`mr-1 font-mono text-[9px] ${isLight ? 'text-slate-400' : 'text-white/30'}`}>{at}</span>
                                )}
                                {e}
                            </li>
                        );
                    })}
                </motion.ul>
            )}
        </AnimatePresence>
    </>
);

// ─── FieldRow ──────────────────────────────────────────────────────────────
// v2: a short badge for fields the latest tick changed. Downgrades and corrections read
// differently from upgrades so a rep notices a grade being withdrawn.
const changeBadge = (kind?: string): { text: string; cls: string } | null => {
    if (!kind) return null;
    if (kind === 'downgrade' || kind === 'correction') {
        return { text: kind === 'correction' ? 'Corrected' : 'Withdrawn', cls: 'bg-amber-500/15 text-amber-300' };
    }
    return { text: 'Updated', cls: 'bg-emerald-500/15 text-emerald-300' };
};

const FeedbackButtons: React.FC<{ path: string; onFeedback: (path: string, value: 1 | -1) => void }> = ({ path, onFeedback }) => {
    const [sent, setSent] = useState<1 | -1 | null>(null);
    const send = (v: 1 | -1) => {
        setSent(v);
        onFeedback(path, v);
    };
    return (
        <span className="flex items-center gap-0.5 ml-1">
            <button
                type="button"
                title="This grade is right"
                aria-label="This grade is right"
                onClick={() => send(1)}
                className={`p-0.5 rounded transition-colors ${sent === 1 ? 'text-emerald-300' : 'text-white/20 hover:text-white/55'}`}
            >
                <ThumbsUp size={10} />
            </button>
            <button
                type="button"
                title="This grade is wrong"
                aria-label="This grade is wrong"
                onClick={() => send(-1)}
                className={`p-0.5 rounded transition-colors ${sent === -1 ? 'text-rose-300' : 'text-white/20 hover:text-white/55'}`}
            >
                <ThumbsDown size={10} />
            </button>
        </span>
    );
};

const FieldRow: React.FC<FieldRowProps> = ({ label, field, themed = false, isLight = false, path, changeKind, onFeedback }) => {
    // `body` is the backend's assessment of the field — its summary — falling
    // back to the evidence on rows saved before summaries existed. The evidence
    // list is reference material, so it sits behind the disclosure.
    const { body, evidence, showDisclosure } = fieldDisplay(field);
    // Local and per-row: 11 independent rows, and the call sites key by the
    // stable field key, so an expanded row survives a live tick rather than
    // snapping shut under the poll.
    const [evidenceOpen, setEvidenceOpen] = useState(false);

    if (themed) {
        return (
            <div className={`rounded-xl border px-3 py-2 mb-1.5 last:mb-0 ${statusRingThemed(field.status, isLight)}`}>
                <div className="flex items-center justify-between mb-0.5">
                    <span className={`text-[9px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-slate-400' : 'text-white/30'}`}>
                        {label}
                    </span>
                    <div className="flex items-center gap-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full ${statusDotThemed(field.status)}`} />
                        <span className={`text-[10px] font-bold capitalize ${emojiColorThemed(field.status, isLight)}`}>
                            {field.status || 'missing'}
                        </span>
                    </div>
                </div>
                {body !== "" && (
                    <p className={`text-[12px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/65'}`}>
                        {body}
                    </p>
                )}
                {showDisclosure && (
                    <EvidenceDisclosure
                        items={evidence}
                        open={evidenceOpen}
                        onToggle={() => setEvidenceOpen(o => !o)}
                        isLight={isLight}
                    />
                )}
                {/* "Ask this" only for genuinely open fields — the backend contract
                    (and normalizeUploadAnalysis) guarantee confirmed fields carry no
                    question; this guard also covers legacy rows where the field is
                    undefined (which `!== ""` used to render as an empty ask-this). */}
                {field.suggested_question && field.status !== 'confirmed' ? (
                    <div className="flex items-start gap-1.5">
                        <span className="text-[9px] font-bold text-blue-500 uppercase tracking-wider mt-[2px] shrink-0">Ask this</span>
                        <p className={`text-[11px] leading-relaxed ${isLight ? 'text-blue-600' : 'text-blue-300/80'}`}>
                            {field.suggested_question}
                        </p>
                    </div>
                ) : field.status === "confirmed" ? null : (
                    <p className={`text-[12px] italic ${isLight ? 'text-slate-400' : 'text-white/25'}`}>
                        Not yet captured — listen for clues
                    </p>
                )}
            </div>
        );
    }

    // Original overlay variant
    const badge = changeBadge(changeKind);
    return (
        <div className={`rounded-xl border px-3 py-2 mb-1.5 last:mb-0 ${statusRing(field.status)} ${badge ? 'ring-1 ring-white/15' : ''}`}>
            <div className="flex items-center justify-between mb-0.5">
                <span className="flex items-center gap-1.5">
                    <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-white/30">{label}</span>
                    {badge && (
                        <span className={`px-1.5 py-[1px] rounded text-[8px] font-bold uppercase tracking-wider ${badge.cls}`}>
                            {badge.text}
                        </span>
                    )}
                </span>
                <div className="flex items-center gap-1.5">
                    <div className={`w-1.5 h-1.5 rounded-full ${statusDot(field.status)}`} />
                    <span className={`text-[10px] font-bold capitalize ${emojiColor(field.status)}`}>
                        {field.status || 'missing'}
                    </span>
                    {path && onFeedback && field.status && field.status !== 'missing' && (
                        <FeedbackButtons path={path} onFeedback={onFeedback} />
                    )}
                </div>
            </div>
            {body !== "" && (
                <p className="text-[12px] text-white/65 leading-normal">{body}</p>
            )}
            {showDisclosure && (
                <EvidenceDisclosure
                    items={evidence}
                    open={evidenceOpen}
                    onToggle={() => setEvidenceOpen(o => !o)}
                    isLight={false}
                    refs={field.evidence_refs}
                />
            )}
            {field.suggested_question && field.status !== 'confirmed' ? (
                <div className="flex items-start gap-1.5">
                    <span className="text-[9px] font-bold text-blue-400/70 uppercase tracking-wider mt-[2px] shrink-0">Ask this</span>
                    <p className="text-[11px] text-blue-300/80 leading-relaxed">{field.suggested_question}</p>
                </div>
            ) : field.status === "confirmed" ? null : (
                <p className="text-[12px] text-white/25 italic">
                    Not yet captured
                </p>
            )}
        </div>
    );
};

// ─── Main component ────────────────────────────────────────────────────────
// Memoized: this is the largest subtree in the live overlay (every MEDDICC/BANT
// field, the signal lists, the objection cards) and it sits inside a panel that
// stays mounted for the whole call. Its four props change only when a new
// analysis lands or the user switches tabs, but it used to be reconciled by every
// unrelated dock render — including, before the audio-level feed landed, ~40 per
// second while anyone was speaking.
export const LiveAnalysisContent: React.FC<LiveAnalysisContentProps> = React.memo(({
    analysisData,
    // aiInsight,
    hideBar = null,
    calledFromAnalysisTab = false,
    activeTab,
    changedFields,
    onFieldFeedback,
}) => {
    // Only consume theme hook when rendered in analysis tab context.
    // Overlay callers always render dark-glass regardless of system theme.
    const resolvedTheme = useResolvedTheme();
    const isLight = calledFromAnalysisTab && resolvedTheme === 'light';

    const meddicFound = Object.values(analysisData.meddic).filter(f => f.status === 'confirmed').length;
    const bantConfirmed = Object.values(analysisData.bant).filter(f => f.status === 'confirmed').length;
    const bantPct = Math.round((bantConfirmed / 4) * 100);

    const missingSignals = [
        ...(analysisData.meddic.competition.status === 'missing'
            ? [{ title: 'Competitor Presence', desc: 'No direct confirmation on other vendors.', icon: '!' }]
            : []),
        ...(analysisData.meddic.champion.status !== 'confirmed'
            ? [{ title: 'Internal Champion', desc: fieldText(analysisData.meddic.champion) || 'Champion not confirmed — need internal sponsor.', icon: '?' }]
            : []),
        ...(analysisData.meddic.decision_process.status === 'missing'
            ? [{ title: 'Decision Process', desc: 'Buying process not mapped — need legal/procurement timeline.', icon: '!' }]
            : []),
        ...(analysisData.meddic.metrics.status === 'missing'
            ? [{ title: 'Quantified Metrics', desc: 'No ROI or KPIs established yet.', icon: '?' }]
            : []),
        ...analysisData.signals
            .filter(s => s.signal_type.includes('risk') || s.signal_type.includes('frustration'))
            .map(s => ({ title: 'Risk Signal', desc: s.ask_now, icon: '⚠' })),
    ];

    const [checkedObjections, setCheckedObjections] = useState<Set<string>>(new Set());
    const toggleObjection = (id: string) => {
        setCheckedObjections(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    // The objection list is now owned by the fast objection-handler tick, so cards
    // arrive and move between groups every few seconds. Split it once here: still-open
    // objections lead, ones the endpoint reported as `resolved` drop into a collapsed
    // group below (they stay in the array so they still reach the post-call summary).
    // The rep's own deferrals ("let me check and get back to you") are follow-ups they owe,
    // not the prospect's objections — they get their own group and never count in the badge.
    const { objections: prospectObjections, followUps: repFollowUps } =
        splitRepFollowUps(analysisData.objections);
    const { active: activeObjections, resolved: resolvedObjectionList } =
        partitionObjections(prospectObjections);
    const [resolvedOpen, setResolvedOpen] = useState(false);
    const [followUpsOpen, setFollowUpsOpen] = useState(true);

    // One card renderer for both call sites — the overlay tab and the analysis-tab
    // accordion previously carried near-identical copies of this markup, and the
    // resolved group would have made that three copies. The theme ternaries collapse
    // to the overlay's dark values when `calledFromAnalysisTab` is false.
    const renderObjectionCard = (obj: Objection) => {
        const key = obj.id ?? obj.quote;
        const isChecked = checkedObjections.has(key);
        const isResolved = Boolean(obj.resolved);
        // A resolved objection reads the same as a manually ticked one.
        const isMuted = isChecked || isResolved;

        const cardClass = calledFromAnalysisTab
            ? isMuted
                ? isLight ? 'border-slate-100 bg-slate-50 opacity-50' : 'border-white/[0.04] bg-white/[0.01] opacity-50'
                : obj.type === 'ae_deferral'
                    ? isLight ? 'border-amber-200 bg-amber-50 hover:bg-amber-100' : 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/8'
                    : isLight ? 'border-slate-200 bg-white hover:bg-slate-50' : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]'
            : isMuted
                ? 'border-white/[0.04] bg-white/[0.01] opacity-50'
                : obj.type === 'ae_deferral'
                    ? 'border-amber-500/20 bg-amber-500/5 hover:bg-amber-500/8'
                    : 'border-white/[0.07] bg-white/[0.02] hover:bg-white/[0.04]';

        const checkboxClass = isMuted
            ? 'bg-emerald-500/80 border-emerald-500'
            : calledFromAnalysisTab
                ? isLight ? 'border-slate-300 bg-transparent' : 'border-white/20 bg-transparent'
                : 'border-white/20 bg-transparent';

        const quoteClass = isMuted
            ? calledFromAnalysisTab
                ? isLight ? 'line-through text-slate-300' : 'line-through text-white/25'
                : 'line-through text-white/25'
            : calledFromAnalysisTab
                ? isLight ? 'text-slate-700' : 'text-white/65'
                : 'text-white/65';

        const tagClass = obj.type === 'ae_deferral'
            ? 'text-amber-600 bg-amber-50 border-amber-200'
            : calledFromAnalysisTab
                ? isLight ? 'text-slate-500 bg-slate-50 border-slate-200' : 'text-white/30 bg-white/5 border-white/10'
                : 'text-white/30 bg-white/5 border-white/10';

        const ownerClass = calledFromAnalysisTab
            ? isLight ? 'text-slate-400' : 'text-white/20'
            : 'text-white/20';

        return (
            <motion.button
                key={key}
                layout
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -4 }}
                transition={{ duration: 0.15 }}
                onClick={() => toggleObjection(key)}
                className={`w-full flex items-start gap-2.5 px-3 py-2 rounded-xl border text-left transition-all duration-200 ${cardClass}`}
            >
                <div className={`mt-0.5 w-4 h-4 rounded shrink-0 flex items-center justify-center border transition-all ${checkboxClass}`}>
                    {isMuted && (
                        <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                            <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <p className={`text-[12px] leading-relaxed transition-all ${quoteClass}`}>
                        {obj.quote}
                    </p>
                    {/* Suggested answer — only for customer questions */}
                    {!isMuted && obj.type === 'customer_question' && obj.suggested_answer && (
                        <div className="flex items-start gap-1.5 rounded-md py-1.5">
                            <p className={`text-[11px] leading-snug ${calledFromAnalysisTab ? (isLight ? 'text-blue-700' : 'text-blue-300/80') : 'text-blue-300/80'}`}>
                                {obj.suggested_answer}
                            </p>
                        </div>
                    )}
                    {/* End-of-call analysis only: how the rep actually answered it on the call */}
                    {obj.rep_response && (
                        <p className={`text-[11px] leading-snug italic mt-0.5 ${calledFromAnalysisTab ? (isLight ? 'text-slate-500' : 'text-white/40') : 'text-white/40'}`}>
                            Rep: “{obj.rep_response}”
                        </p>
                    )}
                    <div className="flex items-center justify-between gap-1.5 mt-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${tagClass}`}>
                                {/* "Objection", not "Open question": the panel lists pushback only,
                                    and calling it a question made it read like a Q&A log. */}
                                {obj.type === 'ae_deferral'
                                    ? 'Follow-up'
                                    : obj.handled === 'resolved'
                                        ? 'Resolved'
                                        : obj.handled === 'partially'
                                            ? 'Partly answered'
                                            : obj.handled === 'unresolved'
                                                ? 'Unresolved'
                                                : 'Objection'}
                            </span>
                            {obj.topic && !obj.category_label && (
                                <span className={`text-[9px] truncate ${ownerClass}`}>{obj.topic}</span>
                            )}
                            {/* Semantic category from the backend objection classifier */}
                            {obj.category_label && (
                                <span className={`text-[9px] truncate ${ownerClass}`}>{obj.category_label}</span>
                            )}
                        </div>
                        <span className={`text-[9px] capitalize shrink-0 ${ownerClass}`}>{obj.owner}</span>
                    </div>
                </div>
            </motion.button>
        );
    };

    // "Your follow-ups": the rep's own promises, listed under the objections but never as one.
    const renderFollowUps = (headerTone: string, listClass: string) => {
        if (repFollowUps.length === 0) return null;
        return (
            <div className="pt-1">
                <button
                    onClick={() => setFollowUpsOpen(o => !o)}
                    className={`w-full flex items-center justify-between px-1 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${headerTone}`}
                >
                    <span>Your follow-ups · {repFollowUps.length}</span>
                    {followUpsOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                </button>
                {followUpsOpen && (
                    <div className={listClass}>
                        <AnimatePresence initial={false}>
                            {repFollowUps.map(renderObjectionCard)}
                        </AnimatePresence>
                    </div>
                )}
            </div>
        );
    };

    const [dismissedSignals, setDismissedSignals] = useState<Set<string>>(new Set());
    const dismissSignal = (id: string) => {
        setDismissedSignals(prev => { const n = new Set(prev); n.add(id); return n; });
    };

    const restoreSignal = (id: string) => {
        setDismissedSignals(prev => {
            const n = new Set(prev);
            n.delete(id);
            if (n.size === 0) setDismissedDrawerOpen(false);
            return n;
        });
    };

    const [dismissedDrawerOpen, setDismissedDrawerOpen] = useState(false);

    // ── Divider ──────────────────────────────────────────────────────────────
    const Divider = () => (
        <div className={`h-px mx-4 ${isLight ? 'bg-slate-200' : 'bg-white/[0.04]'}`} />
    );

    // ── Badge color helpers ──────────────────────────────────────────────────
    const meddicBadge = (found: number) => {
        if (found >= 5) return isLight
            ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        if (found >= 3) return isLight
            ? 'bg-amber-100 text-amber-700 border border-amber-200'
            : 'bg-amber-500/15 text-amber-400 border border-amber-500/25';
        return isLight
            ? 'bg-red-100 text-red-700 border border-red-200'
            : 'bg-red-500/15 text-red-400 border border-red-500/25';
    };

    const bantBadge = (pct: number) => {
        if (pct >= 75) return isLight
            ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
            : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        if (pct >= 50) return isLight
            ? 'bg-amber-100 text-amber-700 border border-amber-200'
            : 'bg-amber-500/15 text-amber-400 border border-amber-500/25';
        return isLight
            ? 'bg-red-100 text-red-700 border border-red-200'
            : 'bg-red-500/15 text-red-400 border border-red-500/25';
    };

    const signalsBadge = () => {
        if (analysisData.signals.some(s => s.category === 'negative' && s.intensity === 'high'))
            return isLight
                ? 'bg-red-100 text-red-700 border border-red-200'
                : 'bg-red-500/15 text-red-400 border border-red-500/25';
        if (analysisData.signals.some(s => s.category === 'positive'))
            return isLight
                ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        return isLight
            ? 'bg-blue-100 text-blue-700 border border-blue-200'
            : 'bg-blue-500/15 text-blue-400 border border-blue-500/25';
    };

    const objectionsBadge = isLight
        ? 'bg-slate-100 text-slate-600 border border-slate-200'
        : 'bg-white/10 text-white/40';

    const dealAlertBadge = isLight
        ? 'bg-amber-100 text-amber-700 border border-amber-200'
        : 'bg-amber-500/15 text-amber-400';

    // ── Shared signal list renderer ───────────────────────────────────────────
    // Used in both the tabbed overlay (activeTab='signals') and the accordion
    // (calledFromAnalysisTab) so dismiss/restore state is shared.
    const renderSignalList = (paddingCls = 'pt-1 pb-1') => {
        const activeSignals = analysisData.signals.filter(s => !dismissedSignals.has(s.id ?? s.quote));
        const archivedSignals = analysisData.signals.filter(s => dismissedSignals.has(s.id ?? s.quote));

        const stripe = (cat: string, intensity: string) => {
            if (cat === 'negative' && intensity === 'high') return 'bg-red-500';
            if (cat === 'negative') return 'bg-amber-400';
            if (cat === 'positive') return 'bg-emerald-400';
            return 'bg-white/20';
        };
        const intensityDot = (cat: string, intensity: string) => {
            if (cat === 'negative' && intensity === 'high') return 'bg-red-500';
            if (cat === 'negative') return 'bg-amber-400';
            return 'bg-white/20';
        };

        return (
            <div className={paddingCls}>
                {/* ── Active signals ── */}
                {activeSignals.length === 0 && (
                    <p className="text-[12px] text-white/30 text-center py-10">No signals detected yet</p>
                )}

                <AnimatePresence initial={false}>
                    {activeSignals.map(signal => (
                        <motion.div
                            key={signal.id ?? signal.quote}
                            initial={{ opacity: 0, height: 'auto' }}
                            animate={{ opacity: 1, height: 'auto' }}
                            exit={{ opacity: 0, height: 0, overflow: 'hidden' }}
                            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                            className="border-b border-white/[0.04] last:border-b-0"
                        >
                            <div className="flex items-start gap-2 pt-2 px-4 group">
                                <div className={`w-0.5 self-stretch rounded-full shrink-0 mt-0.5 ${stripe(signal.category, signal.intensity)}`} />
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center justify-between gap-1 mb-1">
                                        <div className="flex flex-wrap gap-1.5">
                                            {signal.signal_type.slice(0, 2).map((type, j) => (
                                                <span
                                                    key={j}
                                                    className={`text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded border ${calledFromAnalysisTab
                                                        ? signalTypeColorThemed(type, isLight)
                                                        : signalTypeColor(type)
                                                        }`}
                                                >
                                                    {type.replace(/_/g, ' ')}
                                                </span>
                                            ))}
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <div className={`w-1.5 h-1.5 rounded-full ${intensityDot(signal.category, signal.intensity)}`} />
                                            <span className={`text-[10px] capitalize ${calledFromAnalysisTab ? (isLight ? 'text-slate-400' : 'text-white/25') : 'text-white/25'}`}>
                                                {signal.intensity}
                                            </span>
                                            {/* Dismiss button — appears on hover */}
                                            <button
                                                onClick={() => dismissSignal(signal.id ?? signal.quote)}
                                                title="Dismiss signal"
                                                className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 w-4 h-4 rounded flex items-center justify-center hover:bg-white/10"
                                                style={{ color: 'rgba(255,255,255,0.25)' }}
                                            >
                                                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                                    <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                                </svg>
                                            </button>
                                        </div>
                                    </div>
                                    <p className={`text-[12.5px] italic ${calledFromAnalysisTab ? (isLight ? 'text-slate-600' : 'text-white/60') : 'text-white/60'}`}>
                                        "{signal.quote}"
                                    </p>
                                </div>
                            </div>
                            {/* Ask now — always visible */}
                            {signal.ask_now && (
                                <div className="flex items-center gap-1 mt-0.5 pb-2.5 pl-5">
                                    <span className={`text-[11px] font-bold uppercase tracking-wider shrink-0 ${calledFromAnalysisTab ? (isLight ? 'text-blue-500' : 'text-blue-400/60') : 'text-blue-400/60'}`}>
                                        Ask
                                    </span>
                                    <p className={`text-[12px] leading-snug ${calledFromAnalysisTab ? (isLight ? 'text-blue-600' : 'text-blue-300/70') : 'text-blue-300/70'}`}>
                                        {signal.ask_now}
                                    </p>
                                </div>
                            )}
                        </motion.div>
                    ))}
                </AnimatePresence>

                {/* ── Dismissed drawer ── */}
                {archivedSignals.length > 0 && (
                    <div className="mt-2 mx-3">
                        <button
                            onClick={() => setDismissedDrawerOpen(v => !v)}
                            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg transition-colors hover:bg-white/[0.04]"
                            style={{ border: '1px solid rgba(255,255,255,0.06)' }}
                        >
                            <span className="text-[10px] font-bold uppercase tracking-wider text-white/25 flex-1 text-left">
                                Dismissed
                            </span>
                            <span
                                className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)' }}
                            >
                                {archivedSignals.length}
                            </span>
                            <span className="text-white/20">
                                {dismissedDrawerOpen
                                    ? <ChevronUp size={11} />
                                    : <ChevronDown size={11} />}
                            </span>
                        </button>

                        <AnimatePresence initial={false}>
                            {dismissedDrawerOpen && (
                                <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                                    className="overflow-hidden"
                                >
                                    <div className="pt-1 pb-2 space-y-0">
                                        {archivedSignals.map(signal => (
                                            <div
                                                key={signal.id ?? signal.quote}
                                                className="flex items-start gap-2 px-3 py-2 opacity-60 hover:opacity-80 transition-opacity"
                                            >
                                                <div className={`w-0.5 self-stretch rounded-full shrink-0 mt-0.5 ${stripe(signal.category, signal.intensity)}`} />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-[12.5px] italic text-white/50 line-clamp-1">
                                                        "{signal.quote}"
                                                    </p>
                                                    {signal.ask_now && (
                                                        <p className="text-[11px] text-blue-300/50 mt-0.5">{signal.ask_now}</p>
                                                    )}
                                                </div>
                                                {/* Restore button */}
                                                <button
                                                    onClick={() => restoreSignal(signal.id ?? signal.quote)}
                                                    title="Restore signal"
                                                    className="shrink-0 text-[9px] font-bold uppercase tracking-wider text-white/30 hover:text-white/60 transition-colors px-1.5 py-1 rounded hover:bg-white/[0.06] mt-0.5"
                                                >
                                                    ↩
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                )}
            </div>
        );
    };

    // ── Deal Optimizer renderer ───────────────────────────────────────────────────
    const TRIGGER_META: Record<DealTrigger, { label: string; color: string; bg: string; border: string }> = {
        pricing_objection: { label: 'Pricing Objection', color: '#f87171', bg: 'rgba(239,68,68,0.10)', border: 'rgba(239,68,68,0.20)' },
        discount_request: { label: 'Discount Request', color: '#fb923c', bg: 'rgba(249,115,22,0.10)', border: 'rgba(249,115,22,0.22)' },
        competitor_comparison: { label: 'Competitor Compare', color: '#facc15', bg: 'rgba(234,179,8,0.10)', border: 'rgba(234,179,8,0.20)' },
        procurement_pressure: { label: 'Procurement Pressure', color: '#a78bfa', bg: 'rgba(139,92,246,0.10)', border: 'rgba(139,92,246,0.22)' },
        budget_concern: { label: 'Budget Concern', color: '#fb923c', bg: 'rgba(249,115,22,0.10)', border: 'rgba(249,115,22,0.20)' },
        closing_signal: { label: 'Closing Signal', color: '#34d399', bg: 'rgba(52,211,153,0.10)', border: 'rgba(52,211,153,0.22)' },
    };

    const renderDealOptimizer = () => {
        const alerts = analysisData.dealOptimizer ?? [];
        if (alerts.length === 0) {
            return (
                <div className="flex flex-col items-center justify-center py-14 px-6 gap-3">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.18)' }}>
                        <TrendingUp size={18} className="text-amber-400/70" strokeWidth={1.8} />
                    </div>
                    <p className="text-[12px] text-white/30 text-center max-w-[200px] leading-relaxed">
                        No negotiation triggers detected yet. Alerts appear when pricing, discounts, or competitor pressure surfaces.
                    </p>
                </div>
            );
        }

        return (
            <div className="px-3 pt-2 pb-4 space-y-2">
                <AnimatePresence initial={false}>
                    {alerts.map((alert) => {
                        const meta = TRIGGER_META[alert.trigger] ?? TRIGGER_META.pricing_objection;
                        return (
                            <motion.div
                                key={alert.id ?? alert.quote}
                                initial={{ opacity: 0, y: -4 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                                className="rounded-xl border p-3"
                                style={{ background: meta.bg, borderColor: meta.border }}
                            >
                                {/* Trigger badge + intensity */}
                                <div className="flex items-center justify-between gap-2 mb-2">
                                    <span
                                        className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                                        style={{ color: meta.color, background: meta.bg, border: `1px solid ${meta.border}` }}
                                    >
                                        {meta.label}
                                    </span>
                                    <span className="text-[9px] capitalize text-white/25">{alert.intensity}</span>
                                </div>

                                {/* Quote */}
                                <p className="text-[11.5px] italic text-white/55 mb-2 leading-snug">
                                    "{alert.quote}"
                                </p>

                                {/* Headline */}
                                <p className="text-[11px] font-semibold text-white/70 mb-2">{alert.headline}</p>

                                {/* Moves */}
                                <div className="space-y-1.5 mb-2">
                                    {(alert.moves ?? []).map((move, i) => (
                                        <div key={i} className="flex items-start gap-2">
                                            <span
                                                className="text-[9px] font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                                                style={{ background: 'rgba(255,255,255,0.07)', color: meta.color }}
                                            >
                                                {i + 1}
                                            </span>
                                            <p className="text-[11px] text-white/60 leading-snug">{move}</p>
                                        </div>
                                    ))}
                                </div>

                                {/* Anchor */}
                                {alert.anchor && (
                                    <div
                                        className="flex items-start gap-2 rounded-lg px-2.5 py-2"
                                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)' }}
                                    >
                                        <Sparkles size={9} className="shrink-0 mt-0.5" style={{ color: meta.color }} />
                                        <p className="text-[11px] leading-snug" style={{ color: meta.color }}>
                                            {alert.anchor}
                                        </p>
                                    </div>
                                )}
                            </motion.div>
                        );
                    })}
                </AnimatePresence>
            </div>
        );
    };

    // ── Tabbed overlay render (FloatingIntelligencePanel context) ─────────────
    // When activeTab is provided we render one section at a time, always fully
    // expanded — no accordion, no scrolling across sections.
    if (activeTab !== undefined) {
        const tabContent = () => {
            switch (activeTab) {
                case 'meddicc':
                    return (
                        <div className="px-3 pt-2 pb-4 space-y-1.5">
                            {(['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                    field={analysisData.meddic[key]}
                                    themed={false}
                                    isLight={false}
                                    path={`meddic.${key}`}
                                    changeKind={changedFields?.[`meddic.${key}`]}
                                    onFeedback={onFieldFeedback}
                                />
                            ))}
                        </div>
                    );
                case 'bant':
                    return (
                        <div className="px-3 pt-2 pb-4 space-y-1.5">
                            {(['budget', 'authority', 'need', 'timeline'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.charAt(0).toUpperCase() + key.slice(1)}
                                    field={analysisData.bant[key]}
                                    themed={false}
                                    isLight={false}
                                    path={`bant.${key}`}
                                    changeKind={changedFields?.[`bant.${key}`]}
                                    onFeedback={onFieldFeedback}
                                />
                            ))}
                        </div>
                    );
                case 'signals':
                    return renderSignalList('pt-1 pb-1');
                case 'objections':
                    if (analysisData.objections.length === 0) {
                        return (
                            <div className="flex flex-col items-center justify-center h-full py-16 gap-2">
                                <p className="text-[12px] text-white/30">
                                    {analysisData.objectionDetectionOff === 'internal'
                                        ? 'Objection detection is off for internal meetings.'
                                        : 'Listening for objections…'}
                                </p>
                            </div>
                        );
                    }
                    return (
                        <div className="px-3 pt-2 pb-4 space-y-1.5">
                            {prospectObjections.length === 0 && (
                                <p className="px-1 py-1 text-[11px] text-white/30">No objections from the prospect yet.</p>
                            )}
                            <AnimatePresence initial={false}>
                                {activeObjections.map(renderObjectionCard)}
                            </AnimatePresence>
                            {resolvedObjectionList.length > 0 && (
                                <div className="pt-1">
                                    <button
                                        onClick={() => setResolvedOpen(o => !o)}
                                        className="w-full flex items-center justify-between px-1 py-1.5 text-[10px] font-bold uppercase tracking-wider text-white/25 hover:text-white/40 transition-colors"
                                    >
                                        <span>Resolved · {resolvedObjectionList.length}</span>
                                        {resolvedOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                    </button>
                                    {resolvedOpen && (
                                        <div className="space-y-1.5 pt-1">
                                            <AnimatePresence initial={false}>
                                                {resolvedObjectionList.map(renderObjectionCard)}
                                            </AnimatePresence>
                                        </div>
                                    )}
                                </div>
                            )}
                            {renderFollowUps('text-white/25 hover:text-white/40', 'space-y-1.5 pt-1')}
                        </div>
                    );
                case 'deal_optimizer':
                    return renderDealOptimizer()
            }
        };

        return (
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar no-drag">
                {tabContent()}
            </div>
        );
    }

    return (
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar pb-6 no-drag">

            {/* ── MEDDICC ──────────────────────────────────────────────────── */}
            {hideBar !== 'MEDDICC Details' && (
                <>
                    <SectionToggle
                        icon={<Shield size={13} />}
                        title="MEDDICC Details"
                        badge={`${meddicFound}/7 Found`}
                        badgeColor={meddicBadge(meddicFound)}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-1.5 mt-1">
                            {(['metrics', 'economic_buyer', 'decision_criteria', 'decision_process', 'identify_pain', 'champion', 'competition'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                                    field={analysisData.meddic[key]}
                                    themed={calledFromAnalysisTab}
                                    isLight={isLight}
                                />
                            ))}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── BANT ─────────────────────────────────────────────────────── */}
            {hideBar !== 'BANT Details' && (
                <>
                    <SectionToggle
                        icon={<BarChart2 size={13} />}
                        title="BANT Details"
                        badge={`${bantConfirmed}/4 Found`}
                        badgeColor={bantBadge(bantPct)}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-1.5 mt-1">
                            {(['budget', 'authority', 'need', 'timeline'] as const).map(key => (
                                <FieldRow
                                    key={key}
                                    label={key.charAt(0).toUpperCase() + key.slice(1)}
                                    field={analysisData.bant[key]}
                                    themed={calledFromAnalysisTab}
                                    isLight={isLight}
                                />
                            ))}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── Missing Signals ───────────────────────────────────────────── */}
            {missingSignals.length > 0 && hideBar !== 'Missing Details' && (
                <>
                    <Divider />
                    <SectionToggle
                        icon={<AlertTriangle size={13} />}
                        title="What I'm Missing"
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-1.5 mt-1">
                            {missingSignals.map((signal, i) => {
                                const cardClass = calledFromAnalysisTab
                                    ? signal.icon === '!'
                                        ? isLight
                                            ? 'border-red-200 bg-red-50'
                                            : 'border-red-500/25 bg-red-500/5'
                                        : isLight
                                            ? 'border-slate-200 bg-slate-50'
                                            : 'border-white/[0.08] bg-white/[0.02]'
                                    : signal.icon === '!'
                                        ? 'border-red-500/25 bg-red-500/5'
                                        : 'border-white/[0.08] bg-white/[0.02]';

                                const iconClass = calledFromAnalysisTab
                                    ? signal.icon === '!'
                                        ? 'bg-red-100 text-red-600'
                                        : isLight ? 'bg-slate-200 text-slate-500' : 'bg-white/10 text-white/40'
                                    : signal.icon === '!'
                                        ? 'bg-red-500/20 text-red-400'
                                        : 'bg-white/10 text-white/40';

                                return (
                                    <motion.div
                                        key={i}
                                        initial={{ opacity: 0, x: -4 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        transition={{ delay: i * 0.06 }}
                                        className={`rounded-xl border px-3.5 py-3 ${cardClass}`}
                                    >
                                        <div className="flex items-start gap-2.5">
                                            <span className={`text-[10px] font-bold w-4 h-4 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${iconClass}`}>
                                                {signal.icon}
                                            </span>
                                            <div>
                                                <p className={`text-[12px] font-semibold mb-0.5 ${calledFromAnalysisTab ? (isLight ? 'text-slate-700' : 'text-white/70') : 'text-white/70'}`}>
                                                    {signal.title}
                                                </p>
                                                <p className={`text-[11px] leading-relaxed ${calledFromAnalysisTab ? (isLight ? 'text-slate-500' : 'text-white/40') : 'text-white/40'}`}>
                                                    {signal.desc}
                                                </p>
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── Buying Signals ────────────────────────────────────────────── */}
            {analysisData.signals.length > 0 && hideBar !== 'Buying Signals' && (
                <>
                    <SectionToggle
                        icon={<Zap size={13} />}
                        title="Buying Signals"
                        badge={`${Math.max(0, analysisData.signals.length - dismissedSignals.size)}`}
                        badgeColor={signalsBadge()}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        {renderSignalList('mt-1 -mx-4')}
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── Objections ────────────────────────────────────────────────── */}
            {(analysisData.objections.length > 0 || analysisData.objectionDetectionOff === 'internal') && hideBar !== 'Objections' && (
                <>
                    <SectionToggle
                        icon={<CheckSquare size={13} />}
                        title="Objections"
                        badge={`${activeObjections.length}`}
                        badgeColor={objectionsBadge}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        <div className="space-y-2 mt-1">
                            {analysisData.objectionDetectionOff === 'internal' && analysisData.objections.length === 0 && (
                                <p className={`px-1 py-1 text-[11px] ${calledFromAnalysisTab && isLight ? 'text-slate-500' : 'text-white/30'}`}>
                                    Objection detection is off for internal meetings.
                                </p>
                            )}
                            <AnimatePresence initial={false}>
                                {activeObjections.map(renderObjectionCard)}
                            </AnimatePresence>
                            {resolvedObjectionList.length > 0 && (
                                <div className="pt-1">
                                    <button
                                        onClick={() => setResolvedOpen(o => !o)}
                                        className={`w-full flex items-center justify-between px-1 py-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors ${calledFromAnalysisTab
                                            ? (isLight ? 'text-slate-400 hover:text-slate-600' : 'text-white/25 hover:text-white/40')
                                            : 'text-white/25 hover:text-white/40'}`}
                                    >
                                        <span>Resolved · {resolvedObjectionList.length}</span>
                                        {resolvedOpen ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                    </button>
                                    {resolvedOpen && (
                                        <div className="space-y-2 pt-1">
                                            <AnimatePresence initial={false}>
                                                {resolvedObjectionList.map(renderObjectionCard)}
                                            </AnimatePresence>
                                        </div>
                                    )}
                                </div>
                            )}
                            {renderFollowUps(
                                calledFromAnalysisTab
                                    ? (isLight ? 'text-slate-400 hover:text-slate-600' : 'text-white/25 hover:text-white/40')
                                    : 'text-white/25 hover:text-white/40',
                                'space-y-2 pt-1',
                            )}
                        </div>
                    </SectionToggle>
                    <Divider />
                </>
            )}

            {/* ── Deal Alert (negotiation triggers) ── */}
            {(analysisData.dealOptimizer?.length ?? 0) > 0 && hideBar !== 'Deal Alert' && (
                <>
                    <SectionToggle
                        icon={<TrendingUp size={13} />}
                        title="Deal Alert"
                        badge={`${analysisData.dealOptimizer!.length}`}
                        badgeColor={dealAlertBadge}
                        themed={calledFromAnalysisTab}
                        isLight={isLight}
                    >
                        {renderDealOptimizer()}
                    </SectionToggle>
                    <Divider />
                </>
            )}
        </div>
    );
});

LiveAnalysisContent.displayName = 'LiveAnalysisContent';