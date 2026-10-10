import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, X, Check, Download, Loader2, AlertCircle, HardDriveDownload, ExternalLink } from 'lucide-react';
import { UpdateModalProps } from '@/types';
import { releasesPageUrl } from '@/../utils/updateFeed';
import { API_BASE } from '@/lib/apiClient';
import { formatUpdateSize } from '@/hooks/useUpdateStatus';

const CopyBlock = ({ command, isLight }: { command: string; isLight: boolean }) => {
    const [copied, setCopied] = React.useState(false);
    const handleCopy = () => {
        navigator.clipboard.writeText(command);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };
    return (
        <div className={`flex items-center justify-between rounded-xl pl-3 pr-1.5 py-1.5 border transition-colors w-full ${isLight
            ? 'bg-slate-50 border-slate-200 hover:border-slate-300'
            : 'bg-white/[0.03] border-white/[0.07] hover:border-white/[0.12]'
            }`}>
            <code className={`text-[10px] font-mono truncate mr-2 select-all overflow-hidden whitespace-nowrap ${isLight ? 'text-blue-600' : 'text-blue-400'}`}>
                {command}
            </code>
            <button
                onClick={handleCopy}
                className={`h-6 px-2.5 rounded-lg flex items-center justify-center transition-colors border shrink-0 ${isLight
                    ? 'bg-white border-slate-200 text-slate-500 hover:text-slate-800 hover:bg-slate-50'
                    : 'bg-white/5 border-white/10 text-white/50 hover:text-white/85 hover:bg-white/10'
                    }`}
                title="Copy to clipboard"
            >
                {copied ? (
                    <span className={`text-[10px] font-semibold ${isLight ? 'text-emerald-600' : 'text-emerald-400'}`}>Copied</span>
                ) : (
                    <span className="text-[10px] font-medium">Copy</span>
                )}
            </button>
        </div>
    );
};

const UpdateModal: React.FC<UpdateModalProps> = ({
    isOpen,
    updateInfo,
    parsedNotes,
    onDismiss,
    onInstall,
    onRemindLater,
    downloadProgress,
    status,
    errorMessage,
    onInstallUpdate,
    isLight,
    downloadSizeBytes,
    downloadTotalBytes,
    downloadTransferredBytes,
}) => {
    // Helper to format version string
    const formatVersion = (v: string) => {
        if (!v) return 'Unknown';
        if (v === 'latest' || v === 'vlatest') return 'Latest';
        return v.startsWith('v') ? v : `v${v}`;
    };

    const displayVersion = formatVersion(updateInfo?.version);
    const showFallback = !parsedNotes || (!parsedNotes.summary && (!parsedNotes.sections || parsedNotes.sections.length === 0));

    // Size shown BEFORE downloading = full package size (from the update feed
    // release asset). Once downloading, electron-updater reports the ACTUAL
    // transfer total — on Windows differential updates that's the much
    // smaller delta, so the modal switches to it the moment it's known.
    const preDownloadSize = formatUpdateSize(downloadSizeBytes);
    const liveTotal = formatUpdateSize(downloadTotalBytes);
    const liveTransferred = formatUpdateSize(downloadTransferredBytes);
    const headerSize = liveTotal ?? preDownloadSize;

    // Auto-scroll logic
    const scrollContainerRef = React.useRef<HTMLDivElement>(null);
    const isUserInteractionRef = React.useRef(false);
    const animationFrameRef = React.useRef<number>();

    React.useEffect(() => {
        // Only run if not downloading/error and we have notes
        if (status === 'downloading' || status === 'error' || showFallback || !isOpen) return;

        const scroll = () => {
            if (isUserInteractionRef.current || !scrollContainerRef.current) return;

            const el = scrollContainerRef.current;
            el.scrollTop += 0.5;

            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 1) {
                el.scrollTop = 0; // Cycle to top
            }

            animationFrameRef.current = requestAnimationFrame(scroll);
        };

        const timeoutId = setTimeout(() => {
            animationFrameRef.current = requestAnimationFrame(scroll);
        }, 1000);

        return () => {
            clearTimeout(timeoutId);
            if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
        };
    }, [status, showFallback, isOpen]);

    const handleUserScrollInteraction = () => {
        isUserInteractionRef.current = true;
        if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    };

    const panel = (children: React.ReactNode) => (
        <div className="px-6 pb-6 pt-1 flex flex-col min-h-0 flex-1">{children}</div>
    );

    const sizePill = headerSize && status !== 'error' && status !== 'instructions' ? (
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full border ${isLight
            ? 'bg-blue-50 text-blue-700 border-blue-200'
            : 'bg-blue-500/10 text-blue-300 border-blue-400/20'
            }`}>
            <HardDriveDownload size={11} />
            {headerSize} download
        </span>
    ) : null;

    return (
        <AnimatePresence>
            {isOpen && (
                <div
                    className="fixed inset-0 z-[9999] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm font-sans antialiased"
                    onMouseDown={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
                >
                    <motion.div
                        initial={{ opacity: 0, scale: 0.96, y: 12 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.96, y: 8 }}
                        transition={{ duration: 0.22, ease: [0.19, 1, 0.22, 1] }}
                        className={`w-full max-w-[460px] max-h-[600px] rounded-3xl border shadow-2xl overflow-hidden flex flex-col ${isLight
                            ? 'bg-white border-slate-200'
                            : 'bg-[#141820] border-white/10'
                            }`}
                    >
                        {/* ── Header band (Invitation-Modal style) ── */}
                        <div className={`px-6 pt-6 pb-5 shrink-0 ${isLight
                            ? 'bg-gradient-to-b from-blue-50 to-white'
                            : 'bg-gradient-to-b from-blue-500/[0.12] to-transparent'
                            }`}>
                            <div className="flex items-start justify-between">
                                <div className="flex items-center gap-3.5">
                                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-sm ${isLight
                                        ? 'bg-white border-slate-200 text-blue-600'
                                        : 'bg-blue-500/15 border-blue-400/20 text-blue-400'
                                        }`}>
                                        {status === 'downloading' ? <Loader2 size={22} strokeWidth={2} className="animate-spin" />
                                            : status === 'ready' ? <Check size={22} strokeWidth={2} />
                                                : status === 'error' ? <AlertCircle size={22} strokeWidth={2} className="text-red-400" />
                                                    : <Sparkles size={22} strokeWidth={2} />}
                                    </div>
                                    <div>
                                        <p className={`text-[10px] font-bold uppercase tracking-[0.14em] ${isLight ? 'text-blue-600' : 'text-blue-400'}`}>
                                            Software Update
                                        </p>
                                        <h3 className="text-[17px] font-bold text-text-primary leading-snug mt-0.5">
                                            {status === 'error' ? 'Update Failed'
                                                : status === 'downloading' ? 'Downloading Update'
                                                    : status === 'ready' ? 'Ready to Install'
                                                        : status === 'instructions' ? 'Manual Update Required'
                                                            : 'Update Available'}
                                        </h3>
                                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                            {status !== 'error' && (
                                                <p className="text-xs text-text-secondary">
                                                    Version <span className="font-semibold text-text-primary">{displayVersion}</span>
                                                </p>
                                            )}
                                            {sizePill}
                                        </div>
                                    </div>
                                </div>
                                <button
                                    onClick={onDismiss}
                                    aria-label="Dismiss"
                                    className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors shrink-0 ${isLight
                                        ? 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                                        : 'text-white/40 hover:text-white/80 hover:bg-white/[0.06]'
                                        }`}
                                >
                                    <X size={15} />
                                </button>
                            </div>
                        </div>

                        {/* ── Body ── */}
                        {status === 'error' ? (
                            panel(
                                <div className="flex flex-col items-center justify-center text-center flex-1">
                                    <div className="space-y-2 mb-6 max-w-full">
                                        {errorMessage && (
                                            <p className={`text-[13px] font-medium leading-relaxed break-words overflow-hidden max-h-[96px] overflow-y-auto px-2 ${isLight ? 'text-red-600' : 'text-red-400'}`}>
                                                {errorMessage}
                                            </p>
                                        )}
                                        <p className={`text-[13px] break-words ${isLight ? 'text-slate-500' : 'text-white/45'}`}>
                                            Check your internet connection or download the update manually.
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-3 w-full">
                                        <button
                                            onClick={() => window.electronAPI.openExternal(releasesPageUrl(API_BASE))}
                                            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all flex items-center justify-center gap-2 border ${isLight
                                                ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                                                : 'border-white/10 text-white/70 hover:bg-white/[0.05] hover:text-white'
                                                }`}
                                        >
                                            <ExternalLink size={14} /> Download page
                                        </button>
                                        <button
                                            onClick={onDismiss}
                                            className="flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-600/25 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white"
                                        >
                                            Close
                                        </button>
                                    </div>
                                </div>
                            )
                        ) : status === 'instructions' ? (
                            panel(
                                <>
                                    <p className={`text-[13px] leading-relaxed text-center ${isLight ? 'text-slate-600' : 'text-white/60'}`}>
                                        The download has started in your browser{preDownloadSize ? ` (${preDownloadSize})` : ''}. Follow these steps to install the update:
                                    </p>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar mt-4 space-y-2 min-h-0">
                                        <div className="flex items-center justify-between gap-2">
                                            <p className={`text-[12px] font-medium ${isLight ? 'text-slate-700' : 'text-white/80'}`}>1. Open the downloaded file and install GoDojo AI.</p>
                                            <button
                                                onClick={() => window.electronAPI.openKnownFolder('downloads')}
                                                className="shrink-0 text-[11px] font-medium text-blue-400 hover:text-blue-300 underline underline-offset-2 whitespace-nowrap"
                                            >
                                                Open Downloads
                                            </button>
                                        </div>
                                        <div className="space-y-1.5 mt-3">
                                            <div className="flex items-center justify-between gap-2">
                                                <p className={`text-[12px] font-medium ${isLight ? 'text-slate-700' : 'text-white/80'}`}>2. Clear quarantine on the installed app:</p>
                                                <button
                                                    onClick={() => window.electronAPI.openKnownFolder('applications')}
                                                    className="shrink-0 text-[11px] font-medium text-blue-400 hover:text-blue-300 underline underline-offset-2 whitespace-nowrap"
                                                >
                                                    Open Applications
                                                </button>
                                            </div>
                                            <CopyBlock command={`xattr -cr "/Applications/GoDojo AI.app"`} isLight={isLight} />
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-center gap-2 mt-5 shrink-0">
                                        <button
                                            onClick={onDismiss}
                                            className={`px-6 py-2.5 rounded-xl text-sm font-semibold transition-all w-full ${isLight
                                                ? 'border border-slate-200 text-slate-600 hover:bg-slate-50'
                                                : 'border border-white/10 text-white/70 hover:bg-white/[0.05] hover:text-white'
                                                }`}
                                        >
                                            Done
                                        </button>
                                        <button
                                            onClick={() => window.electronAPI.openExternal(releasesPageUrl(API_BASE))}
                                            className={`text-[11px] font-medium transition-colors ${isLight ? 'text-slate-400 hover:text-slate-600' : 'text-white/30 hover:text-white/55'}`}
                                        >
                                            Having trouble? Download the installer instead
                                        </button>
                                    </div>
                                </>
                            )
                        ) : status === 'downloading' ? (
                            panel(
                                <div className="flex flex-col items-center justify-center text-center flex-1">
                                    {/* Progress */}
                                    <div className="w-full max-w-[300px] space-y-2.5 mb-6">
                                        <div className={`h-[6px] w-full rounded-full overflow-hidden ${isLight ? 'bg-slate-100' : 'bg-white/10'}`}>
                                            <motion.div
                                                initial={{ width: 0 }}
                                                animate={{ width: `${downloadProgress}%` }}
                                                transition={{ ease: 'linear', duration: 0.2 }}
                                                className="h-full rounded-full bg-gradient-to-r from-blue-600 to-indigo-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                                            />
                                        </div>
                                        <p className={`text-[11px] font-medium tabular-nums flex items-center justify-center gap-2 ${isLight ? 'text-slate-500' : 'text-white/40'}`}>
                                            <span>{Math.round(downloadProgress)}%</span>
                                            {liveTransferred && liveTotal && <span className="opacity-60">·</span>}
                                            {liveTransferred && liveTotal && <span>{liveTransferred} / {liveTotal}</span>}
                                        </p>
                                    </div>

                                    {/* macOS quarantine hint */}
                                    <div className={`w-full max-w-[360px] rounded-2xl border p-3.5 flex flex-col gap-2.5 text-left ${isLight
                                        ? 'bg-slate-50 border-slate-200'
                                        : 'bg-white/[0.03] border-white/[0.07]'
                                        }`}>
                                        <div className="flex items-start gap-2.5">
                                            <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${isLight ? 'bg-amber-100' : 'bg-amber-500/10'}`}>
                                                <span className="text-[10px] text-amber-500">!</span>
                                            </div>
                                            <div className="space-y-0.5">
                                                <p className={`text-[12px] font-medium leading-normal ${isLight ? 'text-slate-700' : 'text-white/80'}`}>
                                                    If macOS says "App is damaged"
                                                </p>
                                                <p className={`text-[11px] leading-snug ${isLight ? 'text-slate-500' : 'text-white/40'}`}>
                                                    Move app to Applications folder, then run:
                                                </p>
                                            </div>
                                        </div>
                                        <CopyBlock command={`xattr -cr "/Applications/GoDojo AI.app"`} isLight={isLight} />
                                    </div>

                                    <button
                                        onClick={onDismiss}
                                        className={`text-[13px] font-medium transition-colors mt-4 ${isLight ? 'text-slate-400 hover:text-slate-600' : 'text-white/30 hover:text-white/60'}`}
                                    >
                                        Hide
                                    </button>
                                </div>
                            )
                        ) : (
                            panel(
                                <>
                                    {/* Release notes — scrollable */}
                                    <div
                                        ref={scrollContainerRef}
                                        onWheel={handleUserScrollInteraction}
                                        onTouchMove={handleUserScrollInteraction}
                                        onMouseDown={handleUserScrollInteraction}
                                        className={`py-1 flex-1 overflow-y-auto custom-scrollbar min-h-[120px] pr-2 -mr-2 ${isLight ? 'text-slate-700' : 'text-white/70'}`}
                                    >
                                        {showFallback ? (
                                            <p className={`text-[13px] text-center leading-relaxed mt-8 ${isLight ? 'text-slate-500' : 'text-white/60'}`}>
                                                Includes performance improvements and bug fixes.
                                            </p>
                                        ) : (
                                            <div className="space-y-5 px-1">
                                                {parsedNotes?.summary && (
                                                    <p className={`text-[13px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-white/60'}`}>
                                                        {parsedNotes.summary}
                                                    </p>
                                                )}
                                                {parsedNotes?.sections?.map((section, idx) => {
                                                    if (section.items.length === 0) return null;
                                                    if (section.title === 'Summary') return null;

                                                    return (
                                                        <div key={idx} className="space-y-2.5">
                                                            <h3 className={`text-[12px] font-bold uppercase tracking-wide ${isLight ? 'text-slate-500' : 'text-white/50'}`}>
                                                                {section.title}
                                                            </h3>
                                                            <ul className="space-y-2">
                                                                {section.items.map((item, i) => (
                                                                    <li key={i} className="text-[13px] leading-[1.5] flex items-start gap-3">
                                                                        <span className={`mt-[7px] text-[10px] shrink-0 ${isLight ? 'text-blue-400' : 'text-blue-400/70'}`}>—</span>
                                                                        <span>{item}</span>
                                                                    </li>
                                                                ))}
                                                            </ul>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>

                                    {/* Actions (Invitation-Modal style) */}
                                    <div className="flex items-center gap-3 mt-5 shrink-0">
                                        <button
                                            onClick={onRemindLater ?? onDismiss}
                                            className={`flex-1 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all border ${isLight
                                                ? 'border-slate-200 text-slate-600 hover:bg-slate-50'
                                                : 'border-white/10 text-white/70 hover:bg-white/[0.05] hover:text-white'
                                                }`}
                                        >
                                            Remind Me Later
                                        </button>
                                        {/* onInstallUpdate is the guarded path (meeting-active +
                                        dev refusal live in useUpdateStatus) — never call
                                        restartAndInstall directly from here. */}
                                        {status === 'ready' ? (
                                            <button
                                                onClick={onInstallUpdate}
                                                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-600/25 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white"
                                            >
                                                <Check size={15} /> Restart & Install
                                            </button>
                                        ) : (
                                            <button
                                                onClick={onInstall}
                                                className="flex-1 px-4 py-2.5 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-600/25 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white"
                                            >
                                                <Download size={15} /> Update Now
                                            </button>
                                        )}
                                    </div>
                                </>
                            )
                        )}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};

export default UpdateModal;