import React from 'react';
import { RefreshCw, CheckCircle2, Download, AlertCircle, Sparkles, ExternalLink } from 'lucide-react';
import { UseUpdateStatusResult } from '@/hooks';

interface UpdatesTabProps {
    isLight: boolean;
    // Shared instance owned by SettingsOverlay — do NOT call useUpdateStatus()
    // in here again. This tab unmounts/remounts on every tab switch, so a
    // locally-owned hook instance would reset on every visit instead of
    // reflecting what SettingsOverlay (and the badge) already know.
    updateStatus: UseUpdateStatusResult;
}

const StatusPill: React.FC<{ children: React.ReactNode; tone: 'neutral' | 'good' | 'accent' | 'error' }> = ({ children, tone }) => {
    const toneClasses = {
        neutral: 'bg-bg-input text-text-secondary border-border-subtle',
        good: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
        accent: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
        error: 'bg-red-500/10 text-red-400 border-red-500/20',
    }[tone];

    return (
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${toneClasses}`}>
            {children}
        </span>
    );
};

const UpdatesTab: React.FC<UpdatesTabProps> = ({ updateStatus: shared }) => {
    const {
        appVersion,
        parsedNotes,
        updateInfo,
        isUpdateAvailable,
        status,
        downloadProgress,
        errorMessage,
        lastCheckedAt,
        checkForUpdates,
        downloadUpdate,
        installUpdate,
    } = shared;

    const latestVersionLabel = updateInfo?.version
        ? (updateInfo.version.startsWith('v') ? updateInfo.version : `v${updateInfo.version}`)
        : null;

    const releaseUrl: string | undefined = parsedNotes?.url;

    const renderStatusPill = () => {
        if (status === 'error') return <StatusPill tone="error"><AlertCircle size={12} /> Update failed</StatusPill>;
        if (status === 'checking') return <StatusPill tone="neutral"><RefreshCw size={12} className="animate-spin" /> Checking…</StatusPill>;
        if (status === 'downloading') return <StatusPill tone="accent"><Download size={12} /> Downloading… {Math.round(downloadProgress)}%</StatusPill>;
        if (status === 'ready') return <StatusPill tone="good"><CheckCircle2 size={12} /> Ready to install</StatusPill>;
        if (isUpdateAvailable) return <StatusPill tone="accent"><Sparkles size={12} /> Update available</StatusPill>;
        return <StatusPill tone="good"><CheckCircle2 size={12} /> Up to date</StatusPill>;
    };

    const primaryAction = () => {
        if (status === 'ready') {
            return (
                <button
                    onClick={() => installUpdate()}
                    className="whitespace-nowrap px-4 py-2 bg-text-primary hover:bg-white/90 text-bg-main text-xs font-bold rounded-lg transition-all shadow hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 flex items-center gap-2"
                >
                    <RefreshCw size={14} />
                    Restart & Install
                </button>
            );
        }
        if (status === 'downloading') {
            return (
                <button
                    disabled
                    className="whitespace-nowrap px-4 py-2 bg-bg-component border border-border-subtle text-text-tertiary text-xs font-bold rounded-lg flex items-center gap-2 cursor-not-allowed"
                >
                    <Download size={14} />
                    Downloading… {Math.round(downloadProgress)}%
                </button>
            );
        }
        if (isUpdateAvailable) {
            return (
                <button
                    onClick={() => downloadUpdate()}
                    className="whitespace-nowrap px-4 py-2 bg-text-primary hover:bg-white/90 text-bg-main text-xs font-bold rounded-lg transition-all shadow hover:shadow-lg hover:-translate-y-0.5 active:translate-y-0 flex items-center gap-2"
                >
                    <Download size={14} />
                    Download Update
                </button>
            );
        }
        return (
            <button
                onClick={() => checkForUpdates()}
                disabled={status === 'checking'}
                className="whitespace-nowrap px-4 py-2 bg-bg-component hover:bg-bg-elevated border border-border-subtle text-text-primary text-xs font-bold rounded-lg transition-all flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
                <RefreshCw size={14} className={status === 'checking' ? 'animate-spin' : ''} />
                {status === 'checking' ? 'Checking…' : 'Check for Updates'}
            </button>
        );
    };

    return (
        <div className="space-y-6 animated fadeIn pb-10">
            {/* Header */}
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">Updates</h3>
                <p className="text-sm text-text-secondary">Keep GoDojo up to date with the latest features and fixes.</p>
            </div>

            {/* Current version + status */}
            <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
                        <Sparkles size={20} />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h5 className="text-sm font-bold text-text-primary">
                                GoDojo {appVersion ? `v${appVersion}` : ''}
                            </h5>
                            {renderStatusPill()}
                        </div>
                        <p className="text-xs text-text-secondary mt-1">
                            {lastCheckedAt
                                ? `Last checked ${lastCheckedAt.toLocaleString()}`
                                : 'Checks automatically shortly after launch'}
                        </p>
                    </div>
                </div>
                {primaryAction()}
            </div>

            {errorMessage && (
                <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4 flex items-start gap-3">
                    <AlertCircle size={16} className="text-red-400 mt-0.5 shrink-0" />
                    <div>
                        <h5 className="text-sm font-medium text-text-primary">Couldn't check for updates</h5>
                        <p className="text-xs text-text-secondary mt-1 leading-relaxed">{errorMessage}</p>
                    </div>
                </div>
            )}

            {/* What's new / changelog for the pending update */}
            {(isUpdateAvailable || status === 'ready') && (
                <div>
                    <h4 className="text-xs font-bold text-text-tertiary uppercase tracking-wider mb-2 px-1">
                        What's new{latestVersionLabel ? ` in ${latestVersionLabel}` : ''}
                    </h4>
                    <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5 space-y-4">
                        {parsedNotes?.summary && (
                            <p className="text-sm text-text-secondary leading-relaxed">{parsedNotes.summary}</p>
                        )}

                        {parsedNotes?.sections && parsedNotes.sections.length > 0 ? (
                            parsedNotes.sections.map((section) => (
                                <div key={section.title}>
                                    <h5 className="text-xs font-bold text-text-primary mb-1.5">{section.title}</h5>
                                    <ul className="space-y-1">
                                        {section.items.map((item, idx) => (
                                            <li key={idx} className="text-xs text-text-secondary leading-relaxed flex gap-2">
                                                <span className="text-text-tertiary">•</span>
                                                <span>{item}</span>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            ))
                        ) : (
                            !parsedNotes?.summary && (
                                <p className="text-xs text-text-tertiary">
                                    Release notes aren't available yet for this version.
                                </p>
                            )
                        )}

                        {releaseUrl && (
                            <a
                                href={releaseUrl}
                                onClick={(e) => { e.preventDefault(); window.electronAPI?.openExternal?.(releaseUrl); }}
                                className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
                            >
                                View full release notes <ExternalLink size={12} />
                            </a>
                        )}
                    </div>
                </div>
            )}

            {/* Explainer */}
            <div className="bg-bg-item-surface rounded-xl border border-border-subtle p-5">
                <div className="flex items-start gap-3">
                    <RefreshCw size={16} className="text-text-tertiary mt-0.5" />
                    <div>
                        <h5 className="text-sm font-medium text-text-primary">How updates work</h5>
                        <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                            GoDojo checks for new versions automatically shortly after launch. When one is available
                            you'll see a badge here and a popup you can act on right away — no need to reinstall
                            the app manually or download it from anywhere else.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default UpdatesTab;