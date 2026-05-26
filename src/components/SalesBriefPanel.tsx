import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
    X, ExternalLink, RefreshCw, Copy, Check, Building2,
    Users, TrendingUp, DollarSign, Layers, Rocket,
    Newspaper, UserCheck, Linkedin, Target, Map, Star,
    ChevronRight, AlertCircle, WifiOff, Trophy, Zap,
    GitBranch, Briefcase
} from 'lucide-react';
import { useResolvedTheme } from '../hooks/useResolvedTheme';

const GENERIC_DOMAINS = new Set([
    'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com',
    'aol.com', 'protonmail.com', 'mail.com', 'live.com', 'me.com', 'msn.com',
]);
function extractCompanyFromEmail(email: string): string | null {
    const domain = email.split('@')[1]?.toLowerCase();
    if (!domain || GENERIC_DOMAINS.has(domain)) return null;
    const parts = domain.split('.');
    const slug = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    return slug.charAt(0).toUpperCase() + slug.slice(1);
}

interface SalesBriefPanelProps {
    eventData: any;
    onClose: () => void;
}

interface CompanyIntel {
    companyName: string;
    website: string | null;
    foundedYear: number | null;
    companyAge: number | null;
    founders: string[] | null;
    headquarters: string | null;
    employeeCount: string | null;
    industry: string | null;
    revenue: string | null;
    valuation: string | null;
    fundingStage: string | null;
    latestFundingNews: string | null;
    investors: string[] | null;
    keyProducts: string[] | null;
    competitors: string[] | null;
    recentNews: Array<{ headline: string; date: string | null }> | null;
    leadershipChanges: Array<{ name: string; role: string; date: string | null }> | null;
    linkedinUrl: string | null;
    businessModel: string | null;
    geographicPresence: string[] | null;
    topCustomers: string[] | null;
    _newsSnippets?: Array<{ title: string; url: string; date: string | null }>;
}

// ─── Skeleton pulse block ─────────────────────────────────────────────────────
const Skeleton: React.FC<{ w?: string; h?: string; className?: string; isLight?: boolean }> = ({
    w = 'w-full', h = 'h-3', className = '', isLight = false
}) => (
    <div className={`${w} ${h} rounded-md animate-pulse ${isLight ? 'bg-slate-200' : 'bg-white/[0.07]'} ${className}`} />
);

// ─── Single field row ─────────────────────────────────────────────────────────
const Field: React.FC<{
    icon: React.ReactNode;
    label: string;
    value: React.ReactNode;
    isLight: boolean;
    loading?: boolean;
    accent?: boolean;
}> = ({ icon, label, value, isLight, loading, accent }) => (
    <div className="flex items-start gap-3 py-2.5 group">
        <div className={[
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md',
            isLight ? 'bg-slate-100 text-slate-500' : 'bg-white/[0.06] text-slate-400',
        ].join(' ')}>
            {icon}
        </div>
        <div className="flex-1 min-w-0">
            <p className={['text-[10px] font-semibold uppercase tracking-widest mb-0.5',
                isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                {label}
            </p>
            {loading ? (
                <Skeleton w="w-3/4" h="h-3.5" isLight={isLight} />
            ) : (
                <div className={['text-[13px] leading-snug font-medium',
                    accent
                        ? 'text-blue-400'
                        : isLight ? 'text-slate-800' : 'text-slate-200',
                ].join(' ')}>
                    {value}
                </div>
            )}
        </div>
    </div>
);

// ─── Pill list ─────────────────────────────────────────────────────────────────
const PillList: React.FC<{ items: string[]; isLight: boolean; color?: string }> = ({
    items, isLight, color = ''
}) => (
    <div className="flex flex-wrap gap-1.5 mt-0.5">
        {items.map((item, i) => (
            <span key={i} className={[
                'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border',
                color || (isLight
                    ? 'bg-slate-100 border-slate-200/80 text-slate-600'
                    : 'bg-white/[0.05] border-white/[0.08] text-slate-300'),
            ].join(' ')}>
                {item}
            </span>
        ))}
    </div>
);

// ─── Section header ────────────────────────────────────────────────────────────
const SectionHeader: React.FC<{ title: string; isLight: boolean }> = ({ title, isLight }) => (
    <div className={['flex items-center gap-2 pt-4 pb-1 mb-1 border-b',
        isLight ? 'border-slate-200/60' : 'border-white/[0.06]'].join(' ')}>
        <span className={['text-[10px] font-bold uppercase tracking-[0.12em]',
            isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
            {title}
        </span>
    </div>
);

// ─── Skeleton layout for full panel ───────────────────────────────────────────
const PanelSkeleton: React.FC<{ isLight: boolean }> = ({ isLight }) => (
    <div className="space-y-1 px-6 py-4">
        {/* Logo + company header */}
        <div className="flex items-center gap-4 pb-4 mb-2">
            <div className={['w-14 h-14 rounded-xl shrink-0 animate-pulse',
                isLight ? 'bg-slate-200' : 'bg-white/[0.08]'].join(' ')} />
            <div className="flex-1 space-y-2">
                <Skeleton w="w-2/3" h="h-5" isLight={isLight} />
                <Skeleton w="w-1/2" h="h-3" isLight={isLight} />
            </div>
            <div className="flex gap-4 shrink-0">
                {[0, 1, 2].map(i => (
                    <div key={i} className="text-center space-y-1.5">
                        <Skeleton w="w-10" h="h-4" isLight={isLight} />
                        <Skeleton w="w-10" h="h-2.5" isLight={isLight} />
                    </div>
                ))}
            </div>
        </div>

        {/* Two columns of field skeletons */}
        <div className="grid grid-cols-2 gap-x-6">
            {Array.from({ length: 10 }).map((_, i) => (
                <div key={i} className="flex items-start gap-3 py-2.5">
                    <div className={['w-6 h-6 rounded-md shrink-0 animate-pulse',
                        isLight ? 'bg-slate-200' : 'bg-white/[0.07]'].join(' ')} />
                    <div className="flex-1 space-y-1.5 pt-0.5">
                        <Skeleton w="w-1/3" h="h-2" isLight={isLight} />
                        <Skeleton w={i % 3 === 0 ? 'w-full' : 'w-2/3'} h="h-3.5" isLight={isLight} />
                    </div>
                </div>
            ))}
        </div>

        {/* News skeletons */}
        <SectionHeader title="Recent News" isLight={isLight} />
        {[0, 1].map(i => (
            <div key={i} className="flex gap-3 py-2.5 items-start">
                <div className={['w-6 h-6 rounded-md shrink-0 mt-0.5 animate-pulse',
                    isLight ? 'bg-slate-200' : 'bg-white/[0.07]'].join(' ')} />
                <div className="flex-1 space-y-1.5 pt-0.5">
                    <Skeleton w="w-full" h="h-3.5" isLight={isLight} />
                    <Skeleton w="w-1/4" h="h-2.5" isLight={isLight} />
                </div>
            </div>
        ))}
    </div>
);

// ─── Loading stage messages ───────────────────────────────────────────────────
const LOADING_STAGES = [
    { icon: '🔍', text: 'Searching company data...' },
    { icon: '📰', text: 'Fetching latest news...' },
    { icon: '💰', text: 'Pulling funding intelligence...' },
    { icon: '🧠', text: 'Structuring insights...' },
];

// ─── Main component ────────────────────────────────────────────────────────────
const SalesBriefPanel: React.FC<SalesBriefPanelProps> = ({ eventData, onClose }) => {
    const isLight = useResolvedTheme() === 'light';
    const [intel, setIntel] = useState<CompanyIntel | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [loadingStage, setLoadingStage] = useState(0);
    const [hasTavily, setHasTavily] = useState<boolean | null>(null);
    const [isCopied, setIsCopied] = useState(false);

    const copyToClipboard = () => {
        if (!intel) return;
        const v = (x: any) => (x && x !== 'null' && x !== 'N/A') ? x : null;
        const lines: string[] = [];

        const add = (label: string, value: any) => {
            if (value) lines.push(`${label}: ${value}`);
        };
        const addList = (label: string, items: any[] | null | undefined) => {
            if (items?.length) lines.push(`${label}: ${items.join(', ')}`);
        };
        const section = (title: string) => {
            lines.push('');
            lines.push(`── ${title} ──`);
        };

        // Header
        lines.push(`${v(intel.companyName) || companyName}`);
        if (v(intel.website)) lines.push(intel.website!.replace(/^https?:\/\//, '').split('/')[0]);
        lines.push('');

        section('Company Profile');
        add('Industry', v(intel.industry));
        add('Founded', v(intel.foundedYear));
        add('Age', v(intel.companyAge) ? `${intel.companyAge} years` : null);
        add('Employees', v(intel.employeeCount));
        add('Headquarters', v(intel.headquarters));
        add('Revenue', v(intel.revenue));
        add('Valuation', v(intel.valuation));
        add('Funding Stage', v(intel.fundingStage));
        add('Latest Funding', v(intel.latestFundingNews));
        add('Business Model', v(intel.businessModel));
        addList('Founders', v(intel.founders) ? intel.founders : null);
        addList('Investors', v(intel.investors) ? intel.investors : null);

        section('Products & Market');
        addList('Key Products / Services', v(intel.keyProducts) ? intel.keyProducts : null);
        addList('Competitors', v(intel.competitors) ? intel.competitors : null);
        addList('Geographic Presence', v(intel.geographicPresence) ? intel.geographicPresence : null);
        addList('Top Customers', v(intel.topCustomers) ? intel.topCustomers : null);

        if (v(intel.recentNews) && intel.recentNews!.length) {
            section('Recent News');
            intel.recentNews!.slice(0, 3).forEach(n => {
                lines.push(`• ${n.headline}${n.date ? ` (${n.date})` : ''}`);
            });
        }

        if (v(intel.leadershipChanges) && intel.leadershipChanges!.length) {
            section('Leadership Changes');
            intel.leadershipChanges!.slice(0, 2).forEach(l => {
                lines.push(`• ${l.name} appointed as ${l.role}${l.date ? ` (${l.date})` : ''}`);
            });
        }

        if (v(intel.linkedinUrl)) {
            section('LinkedIn');
            lines.push(intel.linkedinUrl!);
        }

        navigator.clipboard.writeText(lines.filter((l, i) => !(l === '' && lines[i - 1] === '')).join('\n'))
            .then(() => {
                setIsCopied(true);
                setTimeout(() => setIsCopied(false), 2000);
            })
            .catch(console.error);
    };

    // Derive company name & domain from event attendees
    const { companyName, domain } = React.useMemo(() => {
        const attendees: Array<{ email: string; name?: string }> = eventData.attendees || [];
        const organizer: string = eventData.organizer || '';
        const orgDomain = organizer.split('@')[1]?.toLowerCase() || '';

        // Find first external attendee with a non-generic domain
        const external = attendees.filter(a => {
            const d = a.email.split('@')[1]?.toLowerCase() || '';
            return d && d !== orgDomain;
        });

        for (const att of external) {
            const name = extractCompanyFromEmail(att.email);
            if (name) {
                const d = att.email.split('@')[1];
                return { companyName: name, domain: d };
            }
        }

        // Fallback: try to extract from meeting title
        const titleMatch = eventData.title?.match(/(?:with|@|–|-)\s+([A-Z][a-zA-Z0-9\s]+)/);
        if (titleMatch) return { companyName: titleMatch[1].trim(), domain: undefined };

        return { companyName: null, domain: undefined };
    }, [eventData]);

    // Cycle loading stage messages
    useEffect(() => {
        if (!loading) return;
        const t = setInterval(() => {
            setLoadingStage(s => (s + 1) % LOADING_STAGES.length);
        }, 1800);
        return () => clearInterval(t);
    }, [loading]);

    const fetchIntel = useCallback(async () => {
        if (!companyName) {
            setError('Could not identify the prospect company from this meeting\'s attendees.');
            setLoading(false);
            return;
        }

        setLoading(true);
        setError(null);
        setIntel(null);

        try {
            // Check Tavily key first
            const creds = await window.electronAPI.getStoredCredentials();
            const tavily = !!creds?.hasTavilyKey;
            setHasTavily(tavily);

            if (!tavily) {
                setError('no_tavily_key');
                setLoading(false);
                return;
            }

            const result = await window.electronAPI?.fetchCompanyIntel({ companyName, domain });
            if (result.success && result.intel) {
                setIntel(result.intel);
            } else {
                setError(result.error || 'Failed to fetch company intelligence.');
            }
        } catch (e: any) {
            setError(e.message || 'Unexpected error');
        } finally {
            setLoading(false);
        }
    }, [companyName, domain]);

    useEffect(() => { fetchIntel(); }, [fetchIntel]);

    const openUrl = (url: string) => {
        if (!url) return;
        // Normalise missing scheme, then validate — only http/https are allowed.
        // This prevents javascript:, file:, and other dangerous schemes from
        // being handed to shell.openExternal via the IPC open-external handler.
        const normalised = /^https?:\/\//i.test(url) ? url : `https://${url}`;
        try {
            const { protocol } = new URL(normalised);
            if (protocol !== 'https:' && protocol !== 'http:') return;
        } catch {
            return; // unparseable — skip silently
        }
        window.open(normalised, '_blank');
    };

    const val = (v: any) => v && v !== 'null' && v !== 'N/A' ? v : null;

    // ── render ────────────────────────────────────────────────────────────────
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={['fixed inset-0 z-[300] flex items-center justify-center p-4',
                isLight ? 'bg-black/25' : 'bg-black/60'].join(' ')}
            onClick={onClose}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 12 }}
                transition={{ duration: 0.28, type: 'spring', damping: 28, stiffness: 340 }}
                onClick={e => e.stopPropagation()}
                className={[
                    'relative w-full max-w-[660px] max-h-[88vh] rounded-2xl overflow-hidden flex flex-col',
                    isLight
                        ? 'bg-white border border-slate-200/80 shadow-[0_24px_64px_rgba(0,0,0,0.16)]'
                        : 'bg-[#0f1117] border border-white/[0.08] shadow-[0_24px_64px_rgba(0,0,0,0.6)] ring-1 ring-white/[0.03]',
                ].join(' ')}
            >
                {/* ── Top bar ── */}
                <div className={['flex items-center justify-between px-5 py-3.5 border-b shrink-0',
                    isLight ? 'border-slate-200/60 bg-slate-50/80' : 'border-white/[0.06] bg-white/[0.02]'].join(' ')}>
                    <div className="flex items-center gap-2.5">
                        <div className={['flex h-7 w-7 items-center justify-center rounded-lg',
                            isLight ? 'bg-blue-50 text-blue-600' : 'bg-blue-500/15 text-blue-400'].join(' ')}>
                            <Briefcase size={13} strokeWidth={2.3} />
                        </div>
                        <div>
                            <p className="text-[13px] font-semibold text-text-primary leading-none">Sales Brief</p>
                            <p className={['text-[10px] mt-0.5 truncate max-w-[280px]',
                                isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                                Key company intelligence at a glance.
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        {intel && (
                            <>
                                <button
                                    onClick={fetchIntel}
                                    title="Refresh"
                                    className={['p-1.5 rounded-lg transition-colors',
                                        isLight ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-100' : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.07]'].join(' ')}
                                >
                                    <RefreshCw size={13} />
                                </button>
                                <button
                                    onClick={copyToClipboard}
                                    title="Copy brief"
                                    className={['flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all',
                                        isCopied
                                            ? (isLight ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25')
                                            : (isLight ? 'text-slate-500 hover:text-slate-700 hover:bg-slate-100 border border-transparent' : 'text-slate-400 hover:text-slate-200 hover:bg-white/[0.07] border border-transparent')
                                    ].join(' ')}
                                >
                                    {isCopied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                                </button>
                            </>
                        )}
                        <button
                            onClick={onClose}
                            className={['p-1.5 rounded-lg transition-colors',
                                isLight ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100' : 'text-slate-500 hover:text-slate-200 hover:bg-white/[0.07]'].join(' ')}
                        >
                            <X size={14} />
                        </button>
                    </div>
                </div>

                {/* ── Scrollable body ── */}
                <div className="flex-1 overflow-y-auto custom-scrollbar">
                    <AnimatePresence mode="wait">

                        {/* ── Loading state ── */}
                        {loading && (
                            <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                                <PanelSkeleton isLight={isLight} />
                                {/* Loading stage pill */}
                                <div className="flex justify-center pb-6">
                                    <motion.div
                                        key={loadingStage}
                                        initial={{ opacity: 0, y: 6 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -6 }}
                                        className={['inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-medium border',
                                            isLight ? 'bg-blue-50 border-blue-100 text-blue-500' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'].join(' ')}
                                    >
                                        <span>{LOADING_STAGES[loadingStage].icon}</span>
                                        <span>{LOADING_STAGES[loadingStage].text}</span>
                                    </motion.div>
                                </div>
                            </motion.div>
                        )}

                        {/* ── Error: no Tavily key ── */}
                        {!loading && error === 'no_tavily_key' && (
                            <motion.div key="no-key" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-16 px-8 gap-4 text-center">
                                <div className={['w-12 h-12 rounded-2xl flex items-center justify-center',
                                    isLight ? 'bg-amber-50' : 'bg-amber-500/10'].join(' ')}>
                                    <WifiOff size={22} className="text-amber-500" />
                                </div>
                                <div>
                                    <p className="text-[14px] font-semibold text-text-primary mb-1">Tavily API key required</p>
                                    <p className={['text-[12px] leading-relaxed max-w-xs',
                                        isLight ? 'text-slate-500' : 'text-slate-400'].join(' ')}>
                                        Sales Brief uses Tavily to fetch live company data. Add your key in{' '}
                                        <span className="font-semibold text-text-primary">Settings → AI Providers</span>.
                                    </p>
                                </div>
                            </motion.div>
                        )}

                        {/* ── Error: no company found ── */}
                        {!loading && error && error !== 'no_tavily_key' && (
                            <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center py-16 px-8 gap-4 text-center">
                                <div className={['w-12 h-12 rounded-2xl flex items-center justify-center',
                                    isLight ? 'bg-red-50' : 'bg-red-500/10'].join(' ')}>
                                    <AlertCircle size={22} className="text-red-400" />
                                </div>
                                <div>
                                    <p className="text-[14px] font-semibold text-text-primary mb-1">Could not load brief</p>
                                    <p className={['text-[12px] leading-relaxed max-w-xs',
                                        isLight ? 'text-slate-500' : 'text-slate-400'].join(' ')}>
                                        {error}
                                    </p>
                                </div>
                                <button
                                    onClick={fetchIntel}
                                    className={['flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-semibold transition-colors',
                                        isLight ? 'bg-slate-100 text-slate-700 hover:bg-slate-200' : 'bg-white/[0.07] text-slate-200 hover:bg-white/[0.12]'].join(' ')}
                                >
                                    <RefreshCw size={12} /> Try again
                                </button>
                            </motion.div>
                        )}

                        {/* ── Intel loaded ── */}
                        {!loading && !error && intel && (
                            <motion.div
                                key="intel"
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.3 }}
                                className="px-5 pb-6"
                            >
                                {/* ── Company header card ── */}
                                <div className={['flex items-center gap-4 px-5 py-4 mx-0 mt-4 mb-2 rounded-xl border',
                                    isLight ? 'bg-slate-50 border-slate-200/70' : 'bg-white/[0.03] border-white/[0.06]'].join(' ')}>
                                    {/* Logo placeholder */}
                                    <div className={['flex h-12 w-12 shrink-0 items-center justify-center rounded-xl text-xl font-bold border',
                                        isLight ? 'bg-white border-slate-200 text-slate-700 shadow-sm' : 'bg-white/[0.07] border-white/[0.1] text-white'].join(' ')}>
                                        {(val(intel.companyName) || companyName || '?').charAt(0).toUpperCase()}
                                    </div>
                                    {/* Name + website */}
                                    <div className="flex-1 min-w-0">
                                        <p className="text-[16px] font-bold text-text-primary leading-tight truncate">
                                            {val(intel.companyName) || companyName}
                                        </p>
                                        {val(intel.website) && (
                                            <button
                                                onClick={() => openUrl(intel.website!)}
                                                className={['flex items-center gap-1 text-[11px] font-medium mt-0.5 transition-colors',
                                                    isLight ? 'text-blue-500 hover:text-blue-700' : 'text-blue-400 hover:text-blue-300'].join(' ')}
                                            >
                                                {intel.website!.replace(/^https?:\/\//, '').split('/')[0]}
                                                <ExternalLink size={9} />
                                            </button>
                                        )}
                                    </div>
                                    {/* Stat pills */}
                                    <div className="flex items-center gap-5 shrink-0">
                                        {val(intel.companyAge) && (
                                            <div className="text-center">
                                                <p className="text-[15px] font-bold text-text-primary">{intel.companyAge}</p>
                                                <p className={['text-[9px] uppercase tracking-wider font-semibold',
                                                    isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>Years Old</p>
                                            </div>
                                        )}
                                        {val(intel.employeeCount) && (
                                            <div className="text-center">
                                                <p className="text-[15px] font-bold text-text-primary">{intel.employeeCount}</p>
                                                <p className={['text-[9px] uppercase tracking-wider font-semibold',
                                                    isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>Employees</p>
                                            </div>
                                        )}
                                        {val(intel.headquarters) && (
                                            <div className="text-center max-w-[100px]">
                                                <p className={['text-[11px] font-semibold leading-tight text-center',
                                                    isLight ? 'text-slate-700' : 'text-slate-300'].join(' ')}>
                                                    {intel.headquarters!.split(',').slice(-2).join(',').trim()}
                                                </p>
                                                <p className={['text-[9px] uppercase tracking-wider font-semibold',
                                                    isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>HQ</p>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* ── Two-column grid ── */}
                                <div className="grid grid-cols-2 gap-x-6">
                                    {/* LEFT COLUMN */}
                                    <div className={['border-r pr-4',
                                        isLight ? 'border-slate-100' : 'border-white/[0.04]'].join(' ')}>
                                        <SectionHeader title="Company Profile" isLight={isLight} />
                                        <Field icon={<Layers size={12} />} label="Industry / Category" isLight={isLight}
                                            value={val(intel.industry) || <span className="opacity-40">—</span>} />
                                        <Field icon={<DollarSign size={12} />} label="Revenue / Turnover" isLight={isLight}
                                            value={val(intel.revenue) || <span className="opacity-40">Not available</span>} />
                                        <Field icon={<TrendingUp size={12} />} label="Valuation" isLight={isLight}
                                            value={val(intel.valuation) || <span className="opacity-40">Not available</span>} />
                                        <Field icon={<Rocket size={12} />} label="Funding Stage" isLight={isLight}
                                            value={val(intel.fundingStage) || <span className="opacity-40">—</span>} />
                                        <Field icon={<GitBranch size={12} />} label="Latest Funding" isLight={isLight}
                                            value={val(intel.latestFundingNews) || <span className="opacity-40">—</span>} />
                                        {val(intel.investors) && intel.investors!.length > 0 && (
                                            <Field icon={<Star size={12} />} label="Investors" isLight={isLight}
                                                value={<PillList items={intel.investors!.slice(0, 4)} isLight={isLight} />} />
                                        )}
                                        {val(intel.founders) && intel.founders!.length > 0 && (
                                            <Field icon={<Users size={12} />} label="Founders" isLight={isLight}
                                                value={intel.founders!.join(', ')} />
                                        )}
                                    </div>

                                    {/* RIGHT COLUMN */}
                                    <div className="pl-2">
                                        <SectionHeader title="Products & Market" isLight={isLight} />
                                        {val(intel.keyProducts) && intel.keyProducts!.length > 0 && (
                                            <Field icon={<Zap size={12} />} label="Key Products / Services" isLight={isLight}
                                                value={<PillList items={intel.keyProducts!.slice(0, 5)} isLight={isLight}
                                                    color={isLight ? 'bg-blue-50 border-blue-100 text-blue-600' : 'bg-blue-500/10 border-blue-500/20 text-blue-400'} />} />
                                        )}
                                        {val(intel.competitors) && intel.competitors!.length > 0 && (
                                            <Field icon={<Target size={12} />} label="Competitors" isLight={isLight}
                                                value={<PillList items={intel.competitors!.slice(0, 5)} isLight={isLight}
                                                    color={isLight ? 'bg-orange-50 border-orange-100 text-orange-600' : 'bg-orange-500/10 border-orange-500/20 text-orange-400'} />} />
                                        )}
                                        <Field icon={<Building2 size={12} />} label="Business Model" isLight={isLight}
                                            value={val(intel.businessModel) || <span className="opacity-40">—</span>} />
                                        {val(intel.geographicPresence) && intel.geographicPresence!.length > 0 && (
                                            <Field icon={<Map size={12} />} label="Geographic Presence" isLight={isLight}
                                                value={<PillList items={intel.geographicPresence!} isLight={isLight} />} />
                                        )}
                                        {val(intel.topCustomers) && intel.topCustomers!.length > 0 && (
                                            <Field icon={<Trophy size={12} />} label="Top Customers" isLight={isLight}
                                                value={<PillList items={intel.topCustomers!.slice(0, 4)} isLight={isLight}
                                                    color={isLight ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'} />} />
                                        )}
                                    </div>
                                </div>

                                {/* ── Recent News ── */}
                                {val(intel.recentNews) && intel.recentNews!.length > 0 && (
                                    <>
                                        <SectionHeader title="Recent News / Announcements" isLight={isLight} />
                                        <div className="space-y-0.5 mt-1">
                                            {intel.recentNews!.slice(0, 3).map((n, i) => {
                                                const snippet = intel._newsSnippets?.[i];
                                                return (
                                                    <button
                                                        key={i}
                                                        onClick={() => snippet?.url && openUrl(snippet.url)}
                                                        className={[
                                                            'w-full flex items-start gap-3 px-3 py-2.5 rounded-xl text-left transition-colors group',
                                                            isLight ? 'hover:bg-slate-50' : 'hover:bg-white/[0.04]',
                                                            snippet?.url ? 'cursor-pointer' : 'cursor-default',
                                                        ].join(' ')}
                                                    >
                                                        <div className={['flex h-6 w-6 shrink-0 mt-0.5 items-center justify-center rounded-md',
                                                            isLight ? 'bg-slate-100 text-slate-400' : 'bg-white/[0.06] text-slate-500'].join(' ')}>
                                                            <Newspaper size={11} />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <p className={['text-[12px] font-medium leading-snug',
                                                                isLight ? 'text-slate-700' : 'text-slate-300'].join(' ')}>
                                                                {n.headline}
                                                            </p>
                                                            {n.date && (
                                                                <p className={['text-[10px] mt-0.5',
                                                                    isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                                                                    {n.date}
                                                                </p>
                                                            )}
                                                        </div>
                                                        {snippet?.url && (
                                                            <ChevronRight size={13} className={[
                                                                'shrink-0 mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity',
                                                                isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')} />
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </>
                                )}

                                {/* ── Leadership Changes ── */}
                                {val(intel.leadershipChanges) && intel.leadershipChanges!.length > 0 && (
                                    <>
                                        <SectionHeader title="Recent Leadership Changes" isLight={isLight} />
                                        <div className="space-y-0.5 mt-1">
                                            {intel.leadershipChanges!.slice(0, 2).map((l, i) => (
                                                <div key={i} className="flex items-start gap-3 px-3 py-2.5">
                                                    <div className={['flex h-6 w-6 shrink-0 mt-0.5 items-center justify-center rounded-md',
                                                        isLight ? 'bg-slate-100 text-slate-400' : 'bg-white/[0.06] text-slate-500'].join(' ')}>
                                                        <UserCheck size={11} />
                                                    </div>
                                                    <div>
                                                        <p className={['text-[12px] font-medium',
                                                            isLight ? 'text-slate-700' : 'text-slate-300'].join(' ')}>
                                                            {l.name}
                                                            <span className={['ml-1.5 text-[11px] font-normal',
                                                                isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                                                                appointed as {l.role}
                                                            </span>
                                                        </p>
                                                        {l.date && (
                                                            <p className={['text-[10px] mt-0.5',
                                                                isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                                                                {l.date}
                                                            </p>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}

                                {/* ── LinkedIn ── */}
                                {val(intel.linkedinUrl) && (
                                    <>
                                        <SectionHeader title="LinkedIn Company Profile" isLight={isLight} />
                                        <button
                                            onClick={() => openUrl(intel.linkedinUrl!)}
                                            className={['flex items-center gap-2.5 px-3 py-2.5 rounded-xl w-full text-left transition-colors mt-1',
                                                isLight ? 'hover:bg-slate-50' : 'hover:bg-white/[0.04]'].join(' ')}
                                        >
                                            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[#0A66C2]/15 text-[#0A66C2]">
                                                <Linkedin size={11} />
                                            </div>
                                            <span className={['text-[12px] font-medium',
                                                isLight ? 'text-blue-600' : 'text-blue-400'].join(' ')}>
                                                View on LinkedIn
                                            </span>
                                            <ExternalLink size={10} className={isLight ? 'text-blue-400' : 'text-blue-500'} />
                                        </button>
                                    </>
                                )}

                                {/* ── Footer ── */}
                                <div className={['flex items-center justify-between mt-5 pt-3 border-t',
                                    isLight ? 'border-slate-100' : 'border-white/[0.05]'].join(' ')}>
                                    <div className="flex items-center gap-1.5">
                                        <div className={['w-1.5 h-1.5 rounded-full',
                                            isLight ? 'bg-blue-400' : 'bg-blue-500'].join(' ')} />
                                        <span className={['text-[10px] font-medium',
                                            isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                                            AI-generated intelligence
                                        </span>
                                        <span className={isLight ? 'text-slate-300' : 'text-slate-600'}>·</span>
                                        <span className={['text-[10px]', isLight ? 'text-slate-400' : 'text-slate-500'].join(' ')}>
                                            Powered by GoDojo
                                        </span>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </motion.div>
        </motion.div>
    );
};

export default SalesBriefPanel;