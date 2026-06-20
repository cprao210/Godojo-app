// ============================================================================
// DebugConsole.tsx
//
// Developer-only debug panel. Never rendered in production.
//
// variant="drawer"  (default) — slide-in drawer from the right, used by
//                               DebugToggleFAB / the main debug shortcut.
// variant="panel"  — compact floating panel (400×640) rendered inline in
//                    the overlay window alongside the dock.
//
// All hooks, helpers, and log-row rendering are shared between both variants.
// Only the outer shell / layout differs.
// ============================================================================

import React, {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    AlertCircle,
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    Bug,
    ChevronDown,
    CircleCheck,
    Copy,
    Info,
    Layers,
    Pause,
    Play,
    Search,
    Server,
    Terminal,
    Trash2,
    X,
} from 'lucide-react';
import type { LogEntry, LogLevel } from '../../lib/logger/types';
import { logger } from '../../lib/logger/frontend.logger';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';

// ── Note: IS_DEV guard intentionally removed — this panel is a developer tool
// that must remain accessible in production builds via the keyboard shortcut. ─

// ── Constants ─────────────────────────────────────────────────────────────────
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

// Drawer variant — uses Tailwind classes + isLight flag
const LEVEL_CONFIG_DRAWER: Record<LogLevel, { label: string; color: string; bgColor: string; borderColor: string; icon: React.ReactNode }> = {
    debug: { label: 'DBG', color: 'text-slate-400', bgColor: 'bg-slate-500/10', borderColor: 'border-slate-500/20', icon: <Layers size={10} /> },
    info: { label: 'INF', color: 'text-sky-400', bgColor: 'bg-sky-500/10', borderColor: 'border-sky-500/20', icon: <Info size={10} /> },
    warn: { label: 'WRN', color: 'text-amber-400', bgColor: 'bg-amber-500/10', borderColor: 'border-amber-500/20', icon: <AlertTriangle size={10} /> },
    error: { label: 'ERR', color: 'text-red-400', bgColor: 'bg-red-500/10', borderColor: 'border-red-500/20', icon: <AlertCircle size={10} /> },
};

// Panel variant — inline styles, always dark
const PANEL_LEVEL_COLOR: Record<LogLevel, string> = {
    debug: 'rgba(148,163,184,0.7)',
    info: '#38bdf8',
    warn: '#fbbf24',
    error: '#f87171',
};
const PANEL_LEVEL_BG: Record<LogLevel, string> = {
    debug: 'rgba(148,163,184,0.06)',
    info: 'rgba(56,189,248,0.07)',
    warn: 'rgba(251,191,36,0.07)',
    error: 'rgba(248,113,113,0.08)',
};
const PANEL_LEVEL_BORDER: Record<LogLevel, string> = {
    debug: 'rgba(148,163,184,0.15)',
    info: 'rgba(56,189,248,0.2)',
    warn: 'rgba(251,191,36,0.2)',
    error: 'rgba(248,113,113,0.2)',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatTimestamp(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms3 = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms3}`;
}

function metaString(metadata: unknown): string {
    if (metadata === undefined || metadata === null) return '';
    if (metadata instanceof Error) return `${metadata.message}\n${metadata.stack ?? ''}`;
    try { return JSON.stringify(metadata, null, 2); } catch { return String(metadata); }
}

function tryParseJSON(msg: string): { parsed: unknown; isObject: boolean } {
    const trimmed = msg.trim();
    const jsonMatch = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!jsonMatch) return { parsed: msg, isObject: false };
    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed === 'object' && parsed !== null) return { parsed, isObject: true };
    } catch { /* fall through */ }
    return { parsed: msg, isObject: false };
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function useFrontendLogs(): [LogEntry[], () => void] {
    const [entries, setEntries] = useState<LogEntry[]>(() => logger.getEntries());
    useEffect(() => {
        const unsub = logger.subscribe(all => setEntries([...all]));
        return unsub;
    }, []);
    const clear = useCallback(() => { logger.clear(); }, []);
    return [entries, clear];
}

function useBackendLogs(enabled: boolean): [LogEntry[], () => void] {
    const [entries, setEntries] = useState<LogEntry[]>([]);
    useEffect(() => {
        if (!enabled) return;
        window.electronAPI?.debugGetBackendLogs?.()
            .then(logs => setEntries(logs ?? []))
            .catch(() => { });
        const unsub = window.electronAPI?.onBackendLogsPush?.((newEntries: LogEntry[]) => {
            if (newEntries.length === 0) { setEntries([]); return; }
            setEntries(prev => {
                const combined = [...prev, ...newEntries];
                return combined.length > 5000 ? combined.slice(-5000) : combined;
            });
        });
        return () => { unsub?.(); };
    }, [enabled]);
    const clear = useCallback(() => {
        setEntries([]);
        window.electronAPI?.debugClearBackendLogs?.().catch(() => { });
    }, []);
    return [entries, clear];
}

// ── JSON tree (panel variant — Chrome-DevTools-style) ─────────────────────────

const JsonNode: React.FC<{ data: unknown; depth?: number; label?: string; isLight?: boolean }> = ({ data, depth = 0, label, isLight = false }) => {
    const [open, setOpen] = useState(depth < 1);
    const isObj = typeof data === 'object' && data !== null;
    const isArr = Array.isArray(data);
    const keys = isObj ? Object.keys(data as object) : [];
    const indent = depth * 12;

    if (!isObj) {
        const color = isLight
            ? typeof data === 'string' ? '#16a34a'
                : typeof data === 'number' ? '#2563eb'
                    : typeof data === 'boolean' ? '#9333ea'
                        : data === null ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.6)'
            : typeof data === 'string' ? '#86efac'
                : typeof data === 'number' ? '#93c5fd'
                    : typeof data === 'boolean' ? '#f9a8d4'
                        : data === null ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.7)';
        const labelColor = isLight ? 'rgba(109,40,217,0.9)' : 'rgba(167,139,250,0.9)';
        return (
            <span className="font-mono text-[10px]" style={{ marginLeft: indent }}>
                {label !== undefined && <span style={{ color: labelColor }}>{label}: </span>}
                <span style={{ color }}>{JSON.stringify(data)}</span>
            </span>
        );
    }

    const preview = isArr
        ? `Array(${keys.length})`
        : `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? '…' : ''}}`;

    const chevronColor = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.4)';
    const labelColor = isLight ? 'rgba(109,40,217,0.9)' : 'rgba(167,139,250,0.9)';
    const previewColor = isLight ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.35)';
    const borderColor = isLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)';

    return (
        <div style={{ marginLeft: indent }} className="font-mono text-[10px] select-text">
            <button
                onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
                className="flex items-center gap-1 hover:opacity-80 transition-opacity w-full text-left"
            >
                <ChevronDown size={9} style={{ color: chevronColor, transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 150ms ease', flexShrink: 0 }} />
                {label !== undefined && <span style={{ color: labelColor }}>{label}:&nbsp;</span>}
                <span style={{ color: previewColor }}>{preview}</span>
            </button>
            {open && (
                <div className="border-l mt-0.5 mb-0.5" style={{ borderColor, marginLeft: 4, paddingLeft: 6 }}>
                    {keys.map(k => (
                        <div key={k} className="py-px">
                            <JsonNode data={(data as Record<string, unknown>)[k]} depth={depth + 1} label={isArr ? `[${k}]` : k} isLight={isLight} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// ── LogMessage — plain text or expandable JSON (panel variant) ────────────────

const LogMessage: React.FC<{ message: string }> = ({ message }) => {
    const { parsed, isObject } = useMemo(() => tryParseJSON(message), [message]);

    if (isObject) {
        return (
            <div className="mt-0.5 rounded-md px-2 py-1.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                <JsonNode data={parsed} depth={0} />
            </div>
        );
    }

    const jsonMatch = message.match(/^(.*?)(\{[\s\S]*\}|\[[\s\S]*\])(.*)$/s);
    if (jsonMatch) {
        const [, prefix, jsonPart, suffix] = jsonMatch;
        try {
            const jsonParsed = JSON.parse(jsonPart);
            if (typeof jsonParsed === 'object' && jsonParsed !== null) {
                return (
                    <div>
                        {prefix && <span className="text-[11px] font-mono leading-relaxed break-all" style={{ color: 'rgba(255,255,255,0.82)' }}>{prefix}</span>}
                        <div className="mt-1 rounded-md px-2 py-1.5" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
                            <JsonNode data={jsonParsed} depth={0} />
                        </div>
                        {suffix && <span className="text-[11px] font-mono leading-relaxed break-all" style={{ color: 'rgba(255,255,255,0.82)' }}>{suffix}</span>}
                    </div>
                );
            }
        } catch { /* fall through */ }
    }

    return <span className="text-[11px] font-mono leading-relaxed break-all" style={{ color: 'rgba(255,255,255,0.82)' }}>{message}</span>;
};

// ── DrawerLogMessage — theme-aware message renderer for the drawer variant ────
// Mirrors LogMessage but adapts to light/dark and never clips object trees.

const DrawerLogMessage: React.FC<{ message: string; isLight: boolean }> = ({ message, isLight }) => {
    const { parsed, isObject } = useMemo(() => tryParseJSON(message), [message]);

    const textColor = isLight ? 'text-slate-700' : 'text-white/80';
    const jsonBg = isLight ? 'bg-slate-100' : undefined;
    const jsonStyle = isLight
        ? { border: '1px solid rgba(0,0,0,0.08)' }
        : { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' };

    if (isObject) {
        return (
            <div className={`mt-0.5 rounded-md px-2 py-1.5 overflow-x-auto ${jsonBg ?? ''}`} style={jsonStyle}>
                <JsonNode data={parsed} depth={0} isLight={isLight} />
            </div>
        );
    }

    const jsonMatch = message.match(/^(.*?)(\{[\s\S]*\}|\[[\s\S]*\])(.*)$/s);
    if (jsonMatch) {
        const [, prefix, jsonPart, suffix] = jsonMatch;
        try {
            const jsonParsed = JSON.parse(jsonPart);
            if (typeof jsonParsed === 'object' && jsonParsed !== null) {
                return (
                    <div>
                        {prefix && <span className={`text-[11px] font-mono leading-relaxed break-all ${textColor}`}>{prefix}</span>}
                        <div className={`mt-1 rounded-md px-2 py-1.5 overflow-x-auto ${jsonBg ?? ''}`} style={jsonStyle}>
                            <JsonNode data={jsonParsed} depth={0} isLight={isLight} />
                        </div>
                        {suffix && <span className={`text-[11px] font-mono leading-relaxed break-all ${textColor}`}>{suffix}</span>}
                    </div>
                );
            }
        } catch { /* fall through */ }
    }

    return <span className={`break-words ${textColor}`}>{message}</span>;
};

// ── DrawerLogRow — single log row for the drawer variant ─────────────────────

interface DrawerLogRowProps { entry: LogEntry; isLight: boolean; }

const DrawerLogRow = React.memo<DrawerLogRowProps>(({ entry, isLight }) => {
    const [expanded, setExpanded] = useState(false);
    const [copied, setCopied] = useState(false);
    const cfg = LEVEL_CONFIG_DRAWER[entry.level];
    const hasMeta = entry.metadata !== undefined && entry.metadata !== null;

    const handleCopy = useCallback(async (e: React.MouseEvent) => {
        e.stopPropagation();
        const text = `[${formatTimestamp(entry.timestamp)}] [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}` +
            (hasMeta ? `\n${metaString(entry.metadata)}` : '');
        await navigator.clipboard.writeText(text).catch(() => { });
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [entry, hasMeta]);

    return (
        <div className={['group font-mono text-[11px] leading-relaxed border-b px-3 py-1.5 cursor-default select-text',
            isLight ? 'border-slate-100 hover:bg-slate-50' : 'border-white/[0.04] hover:bg-white/[0.025]'].join(' ')}>
            <div className="flex items-start gap-2">
                <span className={`shrink-0 mt-0.5 ${isLight ? 'text-slate-400' : 'text-white/25'} w-[88px]`}>
                    {formatTimestamp(entry.timestamp)}
                </span>
                <span className={['shrink-0 mt-0.5 w-[30px] text-center rounded px-0.5 border text-[9px] font-bold tracking-wider', cfg.bgColor, cfg.color, cfg.borderColor].join(' ')}>
                    {cfg.label}
                </span>
                <span className={`shrink-0 mt-0.5 w-[130px] truncate ${isLight ? 'text-violet-600' : 'text-violet-400'}`} title={entry.source}>
                    {entry.source}
                </span>
                <div className="flex-1 min-w-0 overflow-hidden">
                    <div className="flex items-start justify-between gap-1">
                        {/* Plain-text messages get line-clamp; object/JSON messages are never clipped */}
                        <div className={`flex-1 min-w-0 overflow-x-auto ${expanded ? '' : (tryParseJSON(entry.message).isObject ? '' : 'line-clamp-2')}`}>
                            <DrawerLogMessage message={entry.message} isLight={isLight} />
                        </div>
                        <div className="shrink-0 mt-0.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={handleCopy} title="Copy log"
                                className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${isLight ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-200' : 'text-white/30 hover:text-white/70 hover:bg-white/[0.08]'}`}>
                                {copied ? <CircleCheck size={10} className="text-emerald-400" /> : <Copy size={10} />}
                            </button>
                            {hasMeta && (
                                <button onClick={() => setExpanded(p => !p)} title="Expand metadata"
                                    className={`w-5 h-5 flex items-center justify-center rounded transition-colors ${isLight ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-200' : 'text-white/30 hover:text-white/70 hover:bg-white/[0.08]'}`}>
                                    <ChevronDown size={11} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                                </button>
                            )}
                        </div>
                    </div>
                    {expanded && hasMeta && (
                        <div className={`mt-1.5 rounded-md px-2 py-1.5 overflow-x-auto ${isLight ? 'bg-slate-100 border border-slate-200' : 'border border-white/[0.06]'}`}
                            style={isLight ? {} : { background: 'rgba(255,255,255,0.03)' }}>
                            {entry.metadata instanceof Error ? (
                                <pre className={`text-[10px] whitespace-pre-wrap break-all leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/50'}`}>
                                    {metaString(entry.metadata)}
                                </pre>
                            ) : (
                                <JsonNode data={entry.metadata} depth={0} isLight={isLight} />
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
});
DrawerLogRow.displayName = 'DrawerLogRow';

// ── PanelLogRow — single log row for the panel variant ───────────────────────

interface PanelLogRowProps { entry: LogEntry; index: number; onCopy: (entry: LogEntry, i: number) => void; copiedIndex: number | null; }

const PanelLogRow = React.memo<PanelLogRowProps>(({ entry, index, onCopy, copiedIndex }) => (
    <div
        className="group relative flex flex-col px-3 pt-2 pb-2"
        style={{ background: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
    >
        <div className="flex items-center justify-between gap-2 mb-1.5">
            <div className="flex justify-between items-center gap-2 w-full">
                <div className="flex items-center gap-2">
                    <span className="shrink-0 text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded"
                        style={{ color: PANEL_LEVEL_COLOR[entry.level], background: PANEL_LEVEL_BG[entry.level], border: `1px solid ${PANEL_LEVEL_BORDER[entry.level]}`, minWidth: 34, textAlign: 'center' }}>
                        {entry.level === 'debug' ? 'DBG' : entry.level === 'info' ? 'INF' : entry.level === 'warn' ? 'WRN' : 'ERR'}
                    </span>
                    <span className="shrink-0 text-[10px] tabular-nums font-mono" style={{ color: 'rgba(255,255,255,0.28)' }}>
                        {formatTimestamp(entry.timestamp)}
                    </span>
                </div>
                {entry.source && (
                    <>
                        <span style={{ color: 'rgba(255,255,255,0.12)', fontSize: 9, flexShrink: 0 }}>·</span>
                        <span className="text-[10px] font-mono truncate" style={{ color: 'rgba(167,139,250,0.85)' }} title={entry.source}>{entry.source}</span>
                    </>
                )}
            </div>
            <button onClick={e => { e.stopPropagation(); onCopy(entry, index); }} title="Copy this log"
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded transition-all opacity-0 group-hover:opacity-100"
                style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)' }}>
                {copiedIndex === index ? <CircleCheck size={8} className="text-emerald-400" /> : <Copy size={8} className="text-white/30" />}
            </button>
        </div>
        <div className="pl-1">
            <LogMessage message={entry.message} />
        </div>
    </div>
));
PanelLogRow.displayName = 'PanelLogRow';

// ── DrawerLogPane — log list + toolbar for the drawer variant ─────────────────

interface DrawerLogPaneProps { entries: LogEntry[]; onClear: () => void; isLight: boolean; }

const DrawerLogPane: React.FC<DrawerLogPaneProps> = ({ entries, onClear, isLight }) => {
    const [filter, setFilter] = useState('');
    const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
    const [autoScroll, setAutoScroll] = useState(true);
    const [copied, setCopied] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const isUserScrollingRef = useRef(false);

    const visible = useMemo(() => {
        const q = filter.toLowerCase().trim();
        return entries.filter(e => {
            if (levelFilter !== 'all' && e.level !== levelFilter) return false;
            if (!q) return true;
            return e.message.toLowerCase().includes(q) || e.source.toLowerCase().includes(q) || e.level.includes(q);
        });
    }, [entries, filter, levelFilter]);

    useLayoutEffect(() => {
        if (!autoScroll || !scrollRef.current) return;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [visible, autoScroll]);

    const handleScroll = useCallback(() => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        if (scrollHeight - scrollTop - clientHeight < 60 && isUserScrollingRef.current) {
            setAutoScroll(true);
            isUserScrollingRef.current = false;
        }
    }, []);

    const handleWheel = useCallback(() => {
        isUserScrollingRef.current = true;
        setAutoScroll(false);
    }, []);

    const handleCopy = useCallback(async () => {
        const text = visible.map(e =>
            `[${formatTimestamp(e.timestamp)}] [${e.level.toUpperCase()}] [${e.source}] ${e.metadata ? '' : e.message}` +
            (e.metadata ? `\n  ${metaString(e.metadata)}` : '')
        ).join('\n');
        await navigator.clipboard.writeText(text).catch(() => { });
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [visible]);

    const levelCounts = useMemo(() => {
        const counts: Record<string, number> = { all: entries.length };
        for (const e of entries) counts[e.level] = (counts[e.level] ?? 0) + 1;
        return counts;
    }, [entries]);

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Toolbar */}
            <div className={`shrink-0 flex items-center gap-2 px-3 py-2 border-b ${isLight ? 'border-slate-200 bg-slate-50' : 'border-white/[0.06] bg-white/[0.02]'}`}>
                <div className="relative flex-1 min-w-0">
                    <Search size={12} className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${isLight ? 'text-slate-400' : 'text-white/30'}`} />
                    <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
                        placeholder="Filter logs… (source, level, message)"
                        className={['w-full pl-7 pr-3 py-1.5 text-[11px] rounded-lg border outline-none font-mono',
                            isLight ? 'bg-white border-slate-200 text-slate-700 placeholder-slate-400 focus:border-violet-400'
                                : 'bg-white/[0.04] border-white/[0.08] text-white/80 placeholder-white/25 focus:border-violet-500/50'].join(' ')} />
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    {(['all', ...LOG_LEVELS] as const).map(l => {
                        const isActive = levelFilter === l;
                        const count = levelCounts[l] ?? 0;
                        const cfg = l !== 'all' ? LEVEL_CONFIG_DRAWER[l] : null;
                        return (
                            <button key={l} onClick={() => setLevelFilter(l)}
                                className={['flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold border transition-all',
                                    isActive ? l === 'all' ? isLight ? 'bg-slate-200 border-slate-300 text-slate-700' : 'bg-white/10 border-white/20 text-white' : `${cfg?.bgColor} ${cfg?.borderColor} ${cfg?.color}`
                                        : isLight ? 'border-transparent text-slate-400 hover:text-slate-600' : 'border-transparent text-white/30 hover:text-white/60'].join(' ')}>
                                {l === 'all' ? 'ALL' : l.toUpperCase()}
                                <span className={`text-[9px] ${isActive ? '' : isLight ? 'text-slate-400' : 'text-white/25'}`}>{count}</span>
                            </button>
                        );
                    })}
                </div>
                {/* <button onClick={() => setAutoScroll(p => !p)} title={autoScroll ? 'Pause auto-scroll' : 'Resume auto-scroll'}
                    className={['shrink-0 h-7 w-7 flex items-center justify-center rounded-lg border transition-all',
                        autoScroll ? isLight ? 'bg-emerald-50 border-emerald-200 text-emerald-600' : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                            : isLight ? 'border-slate-200 text-slate-400 hover:text-slate-600' : 'border-white/10 text-white/30 hover:text-white/60'].join(' ')}>
                    {autoScroll ? <Pause size={11} /> : <Play size={11} />}
                </button> */}
                <button
                    onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
                    title="Jump to top"
                    className={['shrink-0 h-7 w-7 flex items-center justify-center rounded-lg border transition-all',
                        isLight ? 'border-slate-200 text-slate-400 hover:text-slate-600 hover:border-slate-300'
                            : 'border-white/10 text-white/30 hover:text-white/60 hover:border-white/20'].join(' ')}>
                    <ArrowUp size={11} />
                </button>
                <button
                    onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; setAutoScroll(true); }}
                    title="Jump to bottom"
                    className={['shrink-0 h-7 w-7 flex items-center justify-center rounded-lg border transition-all',
                        isLight ? 'border-slate-200 text-slate-400 hover:text-slate-600 hover:border-slate-300'
                            : 'border-white/10 text-white/30 hover:text-white/60 hover:border-white/20'].join(' ')}>
                    <ArrowDown size={11} />
                </button>
                <button onClick={handleCopy} title="Copy visible logs"
                    className={['shrink-0 h-7 w-7 flex items-center justify-center rounded-lg border transition-all',
                        isLight ? 'border-slate-200 text-slate-400 hover:text-slate-600 hover:border-slate-300'
                            : 'border-white/10 text-white/30 hover:text-white/60 hover:border-white/20'].join(' ')}>
                    {copied ? <CircleCheck size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
                <button onClick={onClear} title="Clear logs"
                    className={['shrink-0 h-7 w-7 flex items-center justify-center rounded-lg border transition-all',
                        isLight ? 'border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200'
                            : 'border-white/10 text-white/30 hover:text-red-400 hover:border-red-500/30'].join(' ')}>
                    <Trash2 size={11} />
                </button>
            </div>
            {/* Count */}
            <div className={`shrink-0 px-3 py-1 text-[10px] font-mono border-b ${isLight ? 'border-slate-100 text-slate-400 bg-slate-50' : 'border-white/[0.04] text-white/25 bg-transparent'}`}>
                {visible.length} / {entries.length} entries{filter && ` matching "${filter}"`}{levelFilter !== 'all' && ` · level=${levelFilter}`}
            </div>
            {/* List */}
            <div ref={scrollRef} onScroll={handleScroll} onWheel={handleWheel} className="flex-1 overflow-y-auto min-h-0 custom-scrollbar">
                {visible.length === 0 ? (
                    <div className={`flex flex-col items-center justify-center h-full gap-3 ${isLight ? 'text-slate-400' : 'text-white/20'}`}>
                        <Terminal size={28} strokeWidth={1.2} />
                        <p className="text-[12px]">{entries.length === 0 ? 'No logs yet' : 'No matches for current filter'}</p>
                    </div>
                ) : (
                    visible.map(entry => <DrawerLogRow key={entry.id} entry={entry} isLight={isLight} />)
                )}
            </div>
        </div>
    );
};

// ── PanelLogPane — log list + toolbar for the panel variant ───────────────────

interface PanelLogPaneProps { entries: LogEntry[]; onClear: () => void; }

const PanelLogPane: React.FC<PanelLogPaneProps> = ({ entries, onClear }) => {
    const [search, setSearch] = useState('');
    const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all');
    const [autoScroll, setAutoScroll] = useState(true);
    const [copied, setCopied] = useState(false);
    const [copiedRowIndex, setCopiedRowIndex] = useState<number | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const userScrolling = useRef(false);

    const visible = useMemo(() => {
        const q = search.toLowerCase().trim();
        return entries.filter(e => {
            if (levelFilter !== 'all' && e.level !== levelFilter) return false;
            if (!q) return true;
            return e.message.toLowerCase().includes(q) || e.source?.toLowerCase().includes(q) || e.level.includes(q);
        });
    }, [entries, search, levelFilter]);

    useEffect(() => {
        if (!autoScroll || !scrollRef.current) return;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [visible, autoScroll]);

    const levelCounts = useMemo(() => {
        const c: Record<string, number> = { all: entries.length };
        for (const e of entries) c[e.level] = (c[e.level] ?? 0) + 1;
        return c;
    }, [entries]);

    const handleCopyAll = useCallback(async () => {
        const text = visible.map(e =>
            `[${formatTimestamp(e.timestamp)}] [${e.level.toUpperCase()}] [${e.source}] ${e.message}` +
            (e.metadata ? `\n  ${metaString(e.metadata)}` : '')
        ).join('\n');
        await navigator.clipboard.writeText(text).catch(() => { });
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
    }, [visible]);

    const handleCopyRow = useCallback(async (e: LogEntry, i: number) => {
        const text = `[${formatTimestamp(e.timestamp)}] [${e.level.toUpperCase()}] ${e.source ? `[${e.source}] ` : ''}${e.message}`;
        await navigator.clipboard.writeText(text).catch(() => { });
        setCopiedRowIndex(i);
        setTimeout(() => setCopiedRowIndex(null), 1500);
    }, []);

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Toolbar */}
            <div className="shrink-0 flex items-center gap-1.5 px-3 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <div className="relative flex-1 min-w-0">
                    <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-white/25" />
                    <input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter logs…"
                        className="w-full pl-6 pr-2 py-1 text-[10px] rounded-lg font-mono outline-none"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.7)' }} />
                </div>
                <button onClick={handleCopyAll} title="Copy all visible logs"
                    className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-colors"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    {copied ? <CircleCheck size={9} className="text-emerald-400" /> : <Copy size={9} className="text-white/30" />}
                </button>
                <button
                    onClick={() => { if (scrollRef.current) scrollRef.current.scrollTop = 0; }}
                    title="Jump to top"
                    className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-colors"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <ArrowUp size={9} className="text-white/30" />
                </button>
                <button
                    onClick={() => { if (scrollRef.current) { scrollRef.current.scrollTop = scrollRef.current.scrollHeight; setAutoScroll(true); } }}
                    title="Jump to bottom"
                    className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-colors"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <ArrowDown size={9} className="text-white/30" />
                </button>
                <button onClick={onClear} title="Clear logs"
                    className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg transition-colors hover:border-red-500/30"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                    <Trash2 size={9} className="text-white/30" />
                </button>
            </div>
            {/* Level pills */}
            <div className="shrink-0 flex items-center gap-1 px-3 py-1.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                {(['all', 'debug', 'info', 'warn', 'error'] as const).map(lvl => {
                    const active = levelFilter === lvl;
                    const count = levelCounts[lvl] ?? 0;
                    return (
                        <button key={lvl} onClick={() => setLevelFilter(lvl)}
                            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider transition-all"
                            style={{
                                color: active ? '#fff' : 'rgba(255,255,255,0.25)',
                                background: active ? (lvl === 'all' ? 'rgba(139,92,246,0.2)' : PANEL_LEVEL_BG[lvl as LogLevel]) : 'transparent',
                                border: active ? `1px solid ${lvl === 'all' ? 'rgba(139,92,246,0.3)' : PANEL_LEVEL_BORDER[lvl as LogLevel]}` : '1px solid transparent',
                            }}>
                            {lvl} <span style={{ opacity: 0.5 }}>{count}</span>
                        </button>
                    );
                })}
                <span className="ml-auto text-[9px] font-mono" style={{ color: 'rgba(255,255,255,0.2)' }}>{visible.length}/{entries.length}</span>
            </div>
            {/* List */}
            <div ref={scrollRef}
                onWheel={() => { userScrolling.current = true; setAutoScroll(false); }}
                onScroll={() => {
                    if (!scrollRef.current || !userScrolling.current) return;
                    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
                    if (scrollHeight - scrollTop - clientHeight < 60) { setAutoScroll(true); userScrolling.current = false; }
                }}
                className="flex-1 overflow-y-auto min-h-0"
                style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.08) transparent' }}>
                {visible.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full gap-2" style={{ color: 'rgba(255,255,255,0.2)' }}>
                        <Terminal size={22} strokeWidth={1.2} />
                        <span className="text-[11px]">{entries.length === 0 ? 'No logs yet' : 'No matches'}</span>
                    </div>
                ) : visible.map((entry, i) => (
                    <PanelLogRow key={entry.id ?? i} entry={entry} index={i} onCopy={handleCopyRow} copiedIndex={copiedRowIndex} />
                ))}
            </div>
        </div>
    );
};

// ── Public API ────────────────────────────────────────────────────────────────

export type DebugConsoleVariant = 'drawer' | 'panel';

export interface DebugConsoleProps {
    /** 'drawer' — slide-in right drawer (default). 'panel' — compact floating box. */
    variant?: DebugConsoleVariant;
    // ── drawer-only props ──
    isOpen?: boolean;
    onClose?: () => void;
    // ── panel-only props ──
    /** CSS opacity applied to the panel shell (panel variant only). */
    opacity?: number;
}

export const DebugConsole: React.FC<DebugConsoleProps> = ({
    variant = 'drawer',
    isOpen,
    onClose,
    opacity,
}) => {
    const isLight = useResolvedTheme() === 'light';
    const [frontendEntries, clearFrontend] = useFrontendLogs();
    const [activeTab, setActiveTab] = useState<'frontend' | 'backend'>('frontend');
    const [backendMounted, setBackendMounted] = useState(false);
    const [backendEntries, clearBackend] = useBackendLogs(backendMounted);

    const tabs = [
        { id: 'frontend' as const, label: 'Frontend', icon: <Terminal size={12} />, count: frontendEntries.length, errorCount: frontendEntries.filter(e => e.level === 'error').length },
        { id: 'backend' as const, label: 'Backend', icon: <Server size={12} />, count: backendEntries.length, errorCount: backendEntries.filter(e => e.level === 'error').length },
    ];

    const handleTabClick = (id: 'frontend' | 'backend') => {
        setActiveTab(id);
        if (id === 'backend') setBackendMounted(true);
    };

    // ── Drawer: keyboard close + reset backend when closing ──────────────────
    useEffect(() => {
        if (variant !== 'drawer') return;
        if (!isOpen) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose?.(); };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [variant, isOpen, onClose]);

    // ── Shared pane render ────────────────────────────────────────────────────
    const renderPane = () => {
        if (variant === 'panel') {
            return activeTab === 'frontend'
                ? <PanelLogPane entries={frontendEntries} onClear={clearFrontend} />
                : <PanelLogPane entries={backendEntries} onClear={clearBackend} />;
        }
        return activeTab === 'frontend'
            ? <DrawerLogPane entries={frontendEntries} onClear={clearFrontend} isLight={isLight} />
            : <DrawerLogPane entries={backendEntries} onClear={clearBackend} isLight={isLight} />;
    };

    // ── Shared tab bar ────────────────────────────────────────────────────────
    const renderTabs = () => {
        if (variant === 'panel') {
            return (
                <div className="shrink-0 flex items-center gap-1 px-3 pt-2 pb-0" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    {tabs.map(tab => {
                        const active = activeTab === tab.id;
                        return (
                            <button key={tab.id} onClick={() => handleTabClick(tab.id)}
                                className="relative flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-t-lg transition-all"
                                style={{
                                    color: active ? 'rgba(139,92,246,1)' : 'rgba(255,255,255,0.3)',
                                    background: active ? 'rgba(10,13,22,1)' : 'transparent',
                                    border: active ? '1px solid rgba(255,255,255,0.08)' : '1px solid transparent',
                                    borderBottom: active ? '1px solid rgba(10,13,22,1)' : '1px solid transparent',
                                    marginBottom: active ? '-1px' : '0',
                                }}>
                                {tab.icon}
                                {tab.label}
                                <span className="text-[8px] font-bold px-1 py-0.5 rounded-full"
                                    style={{ background: active ? 'rgba(139,92,246,0.2)' : 'rgba(255,255,255,0.05)', color: active ? 'rgba(139,92,246,0.9)' : 'rgba(255,255,255,0.25)' }}>
                                    {tab.count}
                                </span>
                                {tab.errorCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-red-500" />}
                            </button>
                        );
                    })}
                </div>
            );
        }

        // Drawer tabs
        return (
            <div className={['shrink-0 flex items-center gap-1 px-4 pt-3 pb-0 border-b', isLight ? 'border-slate-200' : 'border-white/[0.07]'].join(' ')}>
                {tabs.map(tab => (
                    <button key={tab.id} onClick={() => handleTabClick(tab.id)}
                        className={['relative flex items-center gap-2 px-3 py-2 text-[12px] font-medium rounded-t-lg transition-all',
                            activeTab === tab.id
                                ? isLight ? 'text-violet-700 bg-white border border-b-white border-slate-200' : 'text-violet-400 bg-[#0b0e18] border border-b-[#0b0e18] border-white/[0.08]'
                                : isLight ? 'text-slate-500 hover:text-slate-700' : 'text-white/40 hover:text-white/70'].join(' ')}
                        style={activeTab === tab.id ? { marginBottom: '-1px' } : {}}>
                        {tab.icon}
                        {tab.label}
                        <span className={['text-[9px] font-bold px-1.5 py-0.5 rounded-full',
                            activeTab === tab.id
                                ? isLight ? 'bg-violet-100 text-violet-600' : 'bg-violet-500/20 text-violet-400'
                                : isLight ? 'bg-slate-100 text-slate-400' : 'bg-white/[0.06] text-white/30'].join(' ')}>
                            {tab.count}
                        </span>
                        {tab.errorCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />}
                    </button>
                ))}
            </div>
        );
    };

    // ══════════════════════════════════════════════════════════════════════════
    // PANEL variant
    // ══════════════════════════════════════════════════════════════════════════
    if (variant === 'panel') {
        return (
            <div className="flex flex-col rounded-2xl overflow-hidden" style={{
                width: 400,
                height: 640,
                opacity: opacity ?? 1,
                background: 'rgba(10, 13, 22, 0.96)',
                backdropFilter: 'blur(28px) saturate(180%)',
                WebkitBackdropFilter: 'blur(28px) saturate(180%)',
                border: '1px solid rgba(255,255,255,0.07)',
            }}>
                {/* Header */}
                <div className="shrink-0 flex items-center justify-between px-4 py-2.5" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'rgba(139,92,246,0.15)', border: '1px solid rgba(139,92,246,0.25)' }}>
                            <Bug size={12} className="text-violet-400" strokeWidth={1.8} />
                        </div>
                        <span className="text-[11px] font-bold tracking-widest uppercase text-white/50">Debug Console</span>
                    </div>
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.06)' }}>DEV</span>
                </div>
                {renderTabs()}
                <div className="flex-1 min-h-0">{renderPane()}</div>
            </div>
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // DRAWER variant (default)
    // ══════════════════════════════════════════════════════════════════════════
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        key="debug-backdrop"
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        onClick={onClose}
                        className="fixed inset-0 z-[900] pointer-events-auto"
                        style={{ background: 'transparent' }}
                    />
                    <motion.div
                        key="debug-drawer"
                        initial={{ x: '100%', opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: '100%', opacity: 0 }}
                        transition={{ type: 'spring', stiffness: 380, damping: 36 }}
                        className={['fixed right-0 top-0 bottom-0 z-[901] flex flex-col', 'w-[680px] max-w-[92vw]', 'shadow-2xl',
                            isLight ? 'bg-white border-l border-slate-200' : 'bg-[#0b0e18] border-l border-white/[0.08]'].join(' ')}
                        onClick={e => e.stopPropagation()}
                        onPointerDown={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className={['shrink-0 flex items-center justify-between px-4 py-3 border-b',
                            isLight ? 'border-slate-200 bg-slate-50' : 'border-white/[0.07] bg-white/[0.02]'].join(' ')}>
                            <div className="flex items-center gap-2.5">
                                <div className={`p-1.5 rounded-lg ${isLight ? 'bg-violet-100' : 'bg-violet-500/15'}`}>
                                    <Bug size={14} className={isLight ? 'text-violet-600' : 'text-violet-400'} />
                                </div>
                                <div>
                                    <h2 className={`text-[13px] font-semibold ${isLight ? 'text-slate-800' : 'text-white'}`}>Debug Console</h2>
                                    <p className={`text-[10px] font-mono ${isLight ? 'text-slate-400' : 'text-white/30'}`}>development only · never shown in production</p>
                                </div>
                            </div>
                            <button onClick={onClose}
                                className={['h-7 w-7 flex items-center justify-center rounded-lg border transition-all',
                                    isLight ? 'border-slate-200 text-slate-400 hover:text-slate-700 hover:border-slate-300'
                                        : 'border-white/10 text-white/30 hover:text-white/70 hover:border-white/20'].join(' ')}>
                                <X size={13} />
                            </button>
                        </div>
                        {renderTabs()}
                        <div className="flex-1 min-h-0">{renderPane()}</div>
                    </motion.div>
                </>
            )}
        </AnimatePresence>
    );
};

export default DebugConsole;