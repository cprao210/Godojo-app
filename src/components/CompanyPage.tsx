import React, { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
    Building2, Calendar, Clock, Users, TriangleAlert, CircleCheck, ListChecks,
    MessageCircleQuestion, Target, TrendingUp, ChevronRight, Copy, Check, Flame,
} from 'lucide-react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';
import {
    Account, AccountMeeting, BANT_FIELDS, MEDDICC_FIELDS, PIPELINE_STAGES, QualStatus, RolledUpField, stageIndex,
} from '../utils/accountUtils';

interface CompanyPageProps {
    account: Account;
    onOpenMeeting: (meeting: AccountMeeting) => void;
}

const formatDate = (iso: string) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

const relativeDays = (days: number) => (days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`);

const STATUS_STYLE: Record<QualStatus, { label: string; dot: string; text: string }> = {
    clear: { label: 'Clear', dot: 'bg-emerald-400', text: 'text-emerald-400' },
    partial: { label: 'Partial', dot: 'bg-amber-400', text: 'text-amber-400' },
    missing: { label: 'Missing', dot: 'bg-rose-400', text: 'text-rose-400' },
};

function healthMeta(score: number) {
    if (score >= 75) return { label: 'Strong', color: '#34d399' };
    if (score >= 50) return { label: 'Building', color: '#fbbf24' };
    if (score >= 25) return { label: 'Early', color: '#fb923c' };
    return { label: 'At risk', color: '#f87171' };
}

const HealthRing: React.FC<{ score: number }> = ({ score }) => {
    const r = 26;
    const circ = 2 * Math.PI * r;
    const { label, color } = healthMeta(score);
    return (
        <div className="flex items-center gap-3">
            <div className="relative w-16 h-16 shrink-0">
                <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
                    <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="5" className="text-border-subtle" />
                    <motion.circle
                        cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round"
                        strokeDasharray={circ}
                        initial={{ strokeDashoffset: circ }}
                        animate={{ strokeDashoffset: circ - (score / 100) * circ }}
                        transition={{ duration: 0.8, ease: 'easeOut' }}
                    />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center text-[15px] font-bold text-text-primary">{score}</div>
            </div>
            <div>
                <div className="text-[11px] uppercase tracking-wider text-text-tertiary font-semibold">Deal health</div>
                <div className="text-[14px] font-semibold" style={{ color }}>{label}</div>
            </div>
        </div>
    );
};

const Card: React.FC<{ title: string; icon: React.ReactNode; children: React.ReactNode; className?: string; action?: React.ReactNode }> = ({ title, icon, children, className = '', action }) => (
    <section className={`rounded-xl border border-border-subtle bg-bg-item-surface p-4 ${className}`}>
        <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-text-secondary">
                {icon}
                <h3 className="text-[12px] font-semibold uppercase tracking-wider">{title}</h3>
            </div>
            {action}
        </div>
        {children}
    </section>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="text-[12px] text-text-tertiary italic">{children}</p>
);

const BulletList: React.FC<{ items: string[] }> = ({ items }) => (
    <ul className="space-y-1.5">
        {items.map((item, i) => (
            <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-text-secondary">
                <span className="mt-[7px] h-1 w-1 rounded-full bg-text-tertiary shrink-0" />
                <span>{item}</span>
            </li>
        ))}
    </ul>
);

const QualRow: React.FC<{ label: string; field: RolledUpField }> = ({ label, field }) => {
    const s = STATUS_STYLE[field.status];
    return (
        <div className="py-2 border-b border-border-subtle last:border-b-0">
            <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-text-primary">{label}</span>
                <span className={`flex items-center gap-1.5 text-[11px] font-semibold ${s.text}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                    {s.label}
                </span>
            </div>
            {field.detail && <p className="mt-0.5 text-[12px] leading-snug text-text-tertiary">{field.detail}</p>}
        </div>
    );
};

const StageStepper: React.FC<{ stage: string }> = ({ stage }) => {
    const current = stageIndex(stage);
    const lost = /lost/i.test(stage);
    return (
        <div className="flex items-center gap-1">
            {PIPELINE_STAGES.map((s, i) => {
                const reached = current >= i;
                const isCurrent = current === i;
                const label = i === PIPELINE_STAGES.length - 1 && /closed/i.test(stage) ? stage : s;
                const color = lost && isCurrent ? 'bg-rose-500' : reached ? 'bg-blue-500' : 'bg-border-muted';
                return (
                    <div key={s} className="flex-1 min-w-0">
                        <div className={`h-1.5 rounded-full ${color} ${isCurrent ? 'shadow-[0_0_8px_rgba(59,130,246,0.6)]' : ''}`} />
                        <div className={`mt-1.5 text-[10px] truncate ${isCurrent ? 'font-semibold text-text-primary' : 'text-text-tertiary'}`}>{label}</div>
                    </div>
                );
            })}
        </div>
    );
};

function buildAccountBrief(a: Account): string {
    const lines: string[] = [
        `ACCOUNT: ${a.name}`,
        `Stage: ${a.stage} | Deal health: ${a.healthScore}/100 | Meetings: ${a.meetings.length} | Last touch: ${formatDate(a.lastTouch)}`,
        '',
    ];
    if (a.stageSummary) lines.push(`Where it stands: ${a.stageSummary}`, '');
    if (a.risks.length) lines.push('Risks:', ...a.risks.map(r => `- ${r.text}`), '');
    if (a.nextSteps.length) lines.push('Next steps:', ...a.nextSteps.map(s => `- ${s}`), '');
    if (a.questionsToAsk.length) lines.push('Questions for next call:', ...a.questionsToAsk.map(q => `- ${q}`), '');
    if (a.stakeholders.length) lines.push('Stakeholders:', ...a.stakeholders.map(s => `- ${s.name}${s.email ? ` <${s.email}>` : ''}`), '');
    return lines.join('\n').trim();
}

const CompanyPage: React.FC<CompanyPageProps> = ({ account, onOpenMeeting }) => {
    const isLight = useResolvedTheme() === 'light';
    const [copied, setCopied] = useState(false);
    const brief = useMemo(() => buildAccountBrief(account), [account]);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(brief);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch (e) {
            console.error('[CompanyPage] Copy failed:', e);
        }
    };

    const isCold = !/closed/i.test(account.stage) && account.daysSinceLastTouch > 21;

    return (
        <div className="h-full overflow-y-auto custom-scrollbar bg-bg-main">
            <div className="max-w-4xl mx-auto px-8 py-6 space-y-4">

                {/* Header */}
                <header className="flex items-start justify-between gap-6">
                    <div className="flex items-start gap-3 min-w-0">
                        <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-[20px] font-bold ${isLight ? 'bg-blue-50 text-blue-600' : 'bg-blue-500/15 text-blue-300'}`}>
                            {account.name.charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-[22px] font-semibold tracking-tight text-text-primary truncate">{account.name}</h1>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-tertiary">
                                <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2 py-0.5 font-semibold text-blue-400">{account.stage}</span>
                                <span className="inline-flex items-center gap-1"><Calendar size={12} />{account.meetings.length} meeting{account.meetings.length !== 1 ? 's' : ''}</span>
                                <span className="inline-flex items-center gap-1"><Users size={12} />{account.stakeholders.length} contact{account.stakeholders.length !== 1 ? 's' : ''}</span>
                                <span className={`inline-flex items-center gap-1 ${isCold ? 'text-rose-400 font-medium' : ''}`}>
                                    {isCold ? <Flame size={12} /> : <Clock size={12} />}Last touch {relativeDays(account.daysSinceLastTouch).toLowerCase()}
                                </span>
                                <span>First met {formatDate(account.firstTouch)}</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex items-center gap-4 shrink-0">
                        <HealthRing score={account.healthScore} />
                    </div>
                </header>

                {/* Pipeline + status */}
                <Card
                    title="Deal status"
                    icon={<TrendingUp size={14} />}
                    action={
                        <button
                            onClick={handleCopy}
                            className="flex items-center gap-1.5 rounded-lg border border-border-muted px-2.5 py-1 text-[11px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-component transition-colors"
                        >
                            {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                            {copied ? 'Copied' : 'Copy account brief'}
                        </button>
                    }
                >
                    <StageStepper stage={account.stage} />
                    {(account.stageSummary || account.overview) && (
                        <div className="mt-4 space-y-2">
                            {account.stageSummary && <p className="text-[14px] font-medium leading-relaxed text-text-primary">{account.stageSummary}</p>}
                            {account.overview && <p className="text-[13px] leading-relaxed text-text-secondary">{account.overview}</p>}
                        </div>
                    )}
                </Card>

                <div className="grid grid-cols-2 gap-4">
                    {/* Risks */}
                    <Card title="Risks & gaps" icon={<TriangleAlert size={14} />}>
                        {account.risks.length === 0 ? (
                            <p className="flex items-center gap-2 text-[13px] text-emerald-400"><CircleCheck size={14} />No major risks detected.</p>
                        ) : (
                            <ul className="space-y-2">
                                {account.risks.map((r, i) => (
                                    <li key={i} className="flex gap-2 text-[13px] leading-snug text-text-secondary">
                                        <span className={`mt-[6px] h-1.5 w-1.5 rounded-full shrink-0 ${r.level === 'high' ? 'bg-rose-400' : 'bg-amber-400'}`} />
                                        <span>{r.text}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </Card>

                    {/* Next steps */}
                    <Card title="Next steps" icon={<ListChecks size={14} />}>
                        {account.nextSteps.length ? <BulletList items={account.nextSteps} /> : <Empty>No next steps captured yet.</Empty>}
                    </Card>
                </div>

                {/* Qualification */}
                <div className="grid grid-cols-2 gap-4">
                    <Card title="BANT" icon={<Target size={14} />}>
                        {BANT_FIELDS.map(f => <QualRow key={f.key} label={f.label} field={account.bant[f.key]} />)}
                    </Card>
                    <Card title="MEDDICC" icon={<Target size={14} />}>
                        {MEDDICC_FIELDS.map(f => <QualRow key={f.key} label={f.label} field={account.meddicc[f.key]} />)}
                    </Card>
                </div>

                <div className="grid grid-cols-2 gap-4">
                    {/* Stakeholders */}
                    <Card title="Buying committee" icon={<Users size={14} />}>
                        {account.stakeholders.length === 0 ? (
                            <Empty>No contacts identified yet.</Empty>
                        ) : (
                            <ul className="space-y-2">
                                {account.stakeholders.map(s => (
                                    <li key={s.email || s.name} className="flex items-center gap-2.5">
                                        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-component text-[11px] font-semibold text-text-secondary">
                                            {s.name.charAt(0).toUpperCase()}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[13px] font-medium text-text-primary truncate">{s.name}</div>
                                            {s.email && <div className="text-[11px] text-text-tertiary truncate">{s.email}</div>}
                                        </div>
                                        <span className="text-[11px] text-text-tertiary shrink-0">{s.meetings} mtg{s.meetings !== 1 ? 's' : ''}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                        {(account.meddicc.economicBuyer.detail || account.meddicc.champion.detail) && (
                            <div className="mt-3 pt-3 border-t border-border-subtle space-y-1 text-[12px] text-text-tertiary">
                                {account.meddicc.economicBuyer.detail && <p><span className="font-semibold text-text-secondary">Economic buyer: </span>{account.meddicc.economicBuyer.detail}</p>}
                                {account.meddicc.champion.detail && <p><span className="font-semibold text-text-secondary">Champion: </span>{account.meddicc.champion.detail}</p>}
                            </div>
                        )}
                    </Card>

                    {/* Pain & value */}
                    <Card title="Pain & business impact" icon={<Flame size={14} />}>
                        {account.painPoints.length === 0 && account.businessImpact.length === 0 && !account.meddicc.identifyPain.detail ? (
                            <Empty>No pain points captured yet.</Empty>
                        ) : (
                            <div className="space-y-3">
                                {account.meddicc.identifyPain.detail && <p className="text-[13px] leading-relaxed text-text-primary">{account.meddicc.identifyPain.detail}</p>}
                                {account.painPoints.length > 0 && <BulletList items={account.painPoints} />}
                                {account.businessImpact.length > 0 && (
                                    <div>
                                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-400">Expected impact</div>
                                        <BulletList items={account.businessImpact} />
                                    </div>
                                )}
                            </div>
                        )}
                        {account.meddicc.competition.detail && (
                            <div className="mt-3 pt-3 border-t border-border-subtle text-[12px] text-text-tertiary">
                                <span className="font-semibold text-text-secondary">Competition: </span>{account.meddicc.competition.detail}
                            </div>
                        )}
                    </Card>
                </div>

                {/* Next call prep */}
                {(account.openingRecap || account.questionsToAsk.length > 0) && (
                    <Card title="Prep for next call" icon={<MessageCircleQuestion size={14} />}>
                        {account.openingRecap && <p className="mb-3 text-[13px] leading-relaxed text-text-primary">{account.openingRecap}</p>}
                        {account.questionsToAsk.length > 0 && <BulletList items={account.questionsToAsk} />}
                    </Card>
                )}

                {/* Meeting history */}
                <Card title="Meeting history" icon={<Building2 size={14} />}>
                    <ol className="relative">
                        {account.meetings.map((m, i) => (
                            <li key={m.id}>
                                <button
                                    onClick={() => onOpenMeeting(m)}
                                    className="group w-full flex items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-bg-component transition-colors"
                                >
                                    <div className="flex flex-col items-center pt-1 self-stretch">
                                        <span className={`h-2 w-2 rounded-full ${i === 0 ? 'bg-blue-500' : 'bg-border-muted'}`} />
                                        {i < account.meetings.length - 1 && <span className="mt-1 w-px flex-1 bg-border-subtle" />}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[13px] font-semibold text-text-primary truncate">{m.title}</span>
                                            {m.detailedSummary?.dealStatus?.stage && !/unknown/i.test(m.detailedSummary.dealStatus.stage) && (
                                                <span className="shrink-0 rounded-full bg-bg-component px-2 py-0.5 text-[10px] font-medium text-text-secondary">{m.detailedSummary.dealStatus.stage}</span>
                                            )}
                                        </div>
                                        <div className="text-[11px] text-text-tertiary">{formatDate(m.date)}{m.duration ? ` · ${m.duration}` : ''}</div>
                                        {(m.detailedSummary?.dealStatus?.summary || m.detailedSummary?.overview) && (
                                            <p className="mt-1 text-[12px] leading-snug text-text-secondary line-clamp-2">
                                                {m.detailedSummary?.dealStatus?.summary || m.detailedSummary?.overview}
                                            </p>
                                        )}
                                    </div>
                                    <ChevronRight size={14} className="mt-1 shrink-0 text-text-tertiary group-hover:text-text-secondary" />
                                </button>
                            </li>
                        ))}
                    </ol>
                </Card>
            </div>
        </div>
    );
};

export default CompanyPage;
