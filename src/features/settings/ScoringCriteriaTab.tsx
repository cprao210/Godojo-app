/**
 * ScoringCriteriaTab.tsx
 *
 * Settings tab for customizing per-meeting-type scoring rubrics.
 * Fully self-contained: loads from / saves to `scoring_criteria` DB table.
 * Design system mirrors CompanyContextTab — CSS vars, card styles, sticky save bar, modals.
 *
 * All state and DB sync now live in useScoringCriteriaTab; per-section state
 * (add/edit modal, category rows) lives in MeetingTypeSection and its own
 * hooks. This component only renders the page shell.
 */

import React from 'react';
import { RefreshCw, AlertCircle, X, BarChart3, Info, RotateCcw } from 'lucide-react';
import { useResolvedTheme } from '@/hooks';
import { useScoringCriteriaTab } from '@/hooks/useScoringCriteriaTab';
import MeetingTypeSection from './MeetingTypeSection';

export const ScoringCriteriaTab: React.FC = () => {
    const isLight = useResolvedTheme() === 'light';
    const {
        settings,
        isDirty,
        isSaving,
        saveError,
        setSaveError,
        allValid,
        enabledCount,
        handleConfigChange,
        handleSave,
        handleDiscard,
        handleFullReset,
    } = useScoringCriteriaTab();

    return (
        <div className="space-y-6 animated fadeIn pb-10">

            {/* ── Page header ── */}
            <div className="mb-5">
                <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                        <h3 className={`text-sm font-bold ${isLight ? 'text-slate-900' : 'text-text-primary'}`}>Meeting Score Criteria</h3>
                        {enabledCount > 0 && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                                {enabledCount} custom
                            </span>
                        )}
                    </div>

                    {/* Global reset */}
                    <button
                        onClick={handleFullReset}
                        className={`flex items-center gap-1.5 text-[10px] font-medium transition-colors px-2 py-1 rounded-lg border border-transparent hover:border-red-500/20 hover:bg-red-500/10 hover:text-red-400 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`}
                    >
                        <RotateCcw size={10} />
                        Reset all
                    </button>
                </div>
                <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-text-secondary'}`}>
                    Override how each call type is scored. Enable a type to define your own categories,
                    frameworks, weights, and checkpoints. Disabled types use the built-in rubric.
                </p>
            </div>

            {/* ── Meeting type sections ── */}
            <div className="space-y-4">
                {settings.configs.map(cfg => (
                    <MeetingTypeSection
                        key={cfg.meetingType}
                        config={cfg}
                        isLight={isLight}
                        onChange={updated => handleConfigChange(cfg.meetingType, updated)}
                    />
                ))}
            </div>

            {/* ── Info callout ── */}
            <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${isLight ? 'bg-slate-50 border-slate-200' : 'bg-white/[0.02] border-border-subtle'}`}>
                <Info size={13} className={`shrink-0 mt-0.5 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`} />
                <p className={`text-[11px] leading-relaxed ${isLight ? 'text-slate-600' : 'text-text-secondary'}`}>
                    Custom criteria take effect on the <strong className={isLight ? 'text-slate-800' : 'text-text-primary'}>next meeting</strong> that ends.
                    Already-scored meetings are not affected.
                </p>
            </div>

            {/* ── Error banner ── */}
            {saveError && (
                <div className="px-3 py-2 bg-red-500/10 border border-red-500/20 rounded-lg flex items-center gap-2 text-[11px] text-red-400 font-medium animated fadeIn">
                    <AlertCircle size={13} className="shrink-0" />
                    {saveError}
                    <button onClick={() => setSaveError('')} className="ml-auto shrink-0">
                        <X size={12} />
                    </button>
                </div>
            )}

            {/* ── Sticky save bar (mirrors CompanyContextTab pattern exactly) ── */}
            {isDirty && (
                <div className="sticky bottom-0 pt-3 pb-1 animated fadeIn">
                    <div className={`flex items-center justify-between gap-3 px-4 py-3 rounded-xl border shadow-lg ${isLight ? 'bg-white border-slate-200' : 'bg-bg-elevated border-border-subtle'}`}>
                        <p className={`text-xs ${isLight ? 'text-slate-600' : 'text-text-secondary'}`}>
                            {allValid
                                ? 'You have unsaved changes'
                                : 'Fix weight totals before saving'}
                        </p>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={handleDiscard}
                                disabled={isSaving}
                                className={`px-4 py-1.5 rounded-full text-xs font-medium transition-all border disabled:opacity-50 ${isLight
                                    ? 'text-slate-600 hover:text-slate-800 hover:bg-slate-50 border-slate-200'
                                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-input border-border-subtle'
                                    }`}
                            >
                                Discard
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={isSaving || !allValid}
                                className="px-4 py-1.5 rounded-full text-xs font-bold transition-all flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed bg-text-primary text-bg-main hover:opacity-90 shadow"
                            >
                                {isSaving
                                    ? <><RefreshCw size={12} className="animate-spin" /> Saving…</>
                                    : <><BarChart3 size={12} /> Save Scoring Rules</>
                                }
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ScoringCriteriaTab;