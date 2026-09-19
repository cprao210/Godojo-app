/**
 * CompanyAssociation.tsx
 *
 * The customer-company picker shared by three surfaces:
 *  - the post-call CompanySelectModal (quick meetings only — calendar meetings
 *    already have their company resolved from the event)
 *  - the optional field inside the TranscriptUploadModal (so an uploaded
 *    transcript never needs the post-submit prompt)
 *  - the MeetingDetails header chip (view / change / remove)
 *
 * All writes go through the backend (PUT /meetings/:id/company), which is the
 * single source of truth for the meeting → company association. The local
 * SQLite mirror deliberately does NOT carry company_id: PostgREST upserts
 * only overwrite columns present in the payload, so the Electron mirror can
 * never clobber a backend-side association.
 */

import React, { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Briefcase, Building2, Check, Loader2, Plus, Search, X } from 'lucide-react';
import { companiesApi, meetingsApi } from '@/api';
import { Company, CompanyRef } from '@/types';

// ─── Shared helpers ──────────────────────────────────────────────────────────

// Resolves the tenant id for company-scoped API calls. Threading tenantId
// through every caller (App, Launcher, MeetingDetails) would mean prop
// drilling through three surfaces — the IPC lookup is one call and always
// current, so the modal/picker own it instead.
async function resolveTenantId(): Promise<string | null> {
    try {
        return await window.electronAPI?.getCurrentTenantId?.() ?? null;
    } catch {
        return null;
    }
}

export interface PickedCompany {
    companyId: string | null; // null → create-new by name
    name: string;
    // Carried through to the create-or-get so a NEW company is born with the
    // domain detected from the meeting's attendees.
    domain?: string | null;
}

// ─── CompanyPickerField ──────────────────────────────────────────────────────
// Combobox: debounced search over GET /companies (name OR domain), result
// rows, a "Create '<query>'" row whenever the exact name isn't already
// listed, and an optional "Suggested for this meeting" group fed by the
// backend's attendee-domain candidates.

export const CompanyPickerField: React.FC<{
    isLight: boolean;
    value: PickedCompany | null;
    onChange: (value: PickedCompany | null) => void;
    placeholder?: string;
    autoFocus?: boolean;
    /** Attendee-domain candidates from the backend — shown when the search
    box is empty so the user can resolve a multi-domain meeting in one click. */
    suggestions?: { name: string; domain: string }[];
}> = ({ isLight, value, onChange, placeholder = 'Search or enter company name…', autoFocus, suggestions }) => {
    const [query, setQuery] = useState(value?.name ?? '');
    const [results, setResults] = useState<Company[]>([]);
    const [isSearching, setIsSearching] = useState(false);
    const [isOpen, setIsOpen] = useState(false);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rootRef = useRef<HTMLDivElement | null>(null);

    // Debounced search — 250ms quiet period, per the plan's picker UX.
    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (!isOpen) return;
        debounceRef.current = setTimeout(async () => {
            setIsSearching(true);
            try {
                const tenantId = await resolveTenantId();
                const rows = await companiesApi.list(query.trim() || undefined, 20, tenantId);
                setResults(rows);
            } catch {
                setResults([]); // search failure just empties the list; create-new still works
            } finally {
                setIsSearching(false);
            }
        }, 250);
        return () => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query, isOpen]);

    // Close on outside click.
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setIsOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isOpen]);

    const exactMatch = results.some(
        r => r.name.toLowerCase() === query.trim().toLowerCase(),
    );
    const showCreate = query.trim().length > 0 && !exactMatch;

    const pick = (company: Company) => {
        onChange({ companyId: company.id, name: company.name });
        setQuery(company.name);
        setIsOpen(false);
    };

    // A suggestion isn't a registered company yet — pick it by name+domain and
    // the save creates it with the domain attached.
    const pickSuggestion = (s: { name: string; domain: string }) => {
        onChange({ companyId: null, name: s.name, domain: s.domain });
        setQuery(s.name);
        setIsOpen(false);
    };

    const pickNew = () => {
        onChange({ companyId: null, name: query.trim() });
        setIsOpen(false);
    };

    if (value) {
        // Selected state: pill with the company name (+ domain when known).
        return (
            <div className={`flex items-center gap-2 rounded-[10px] px-3 py-[6px] border ${isLight ? 'bg-emerald-50 border-emerald-200' : 'bg-emerald-500/10 border-emerald-500/25'}`}>
                <Building2 size={13} className={isLight ? 'text-emerald-600' : 'text-emerald-400'} />
                <div className="flex-1 min-w-0 leading-normal">
                    <span className={`block text-[13px] font-medium truncate ${isLight ? 'text-emerald-800' : 'text-emerald-300'}`}>
                        {value.name}
                    </span>
                    {value.domain && (
                        <span className={`block text-[11px] truncate ${isLight ? 'text-emerald-600' : 'text-emerald-400/80'}`}>
                            {value.domain}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={() => { onChange(null); setQuery(''); }}
                    className={isLight ? 'text-emerald-600 hover:text-emerald-800' : 'text-emerald-400 hover:text-emerald-200'}
                    aria-label="Clear company"
                >
                    <X size={13} />
                </button>
            </div>
        );
    }

    return (
        <div ref={rootRef} className="relative">
            <div className="relative">
                <Search size={13} className={`absolute left-3 top-1/2 -translate-y-1/2 ${isLight ? 'text-slate-400' : 'text-text-tertiary'}`} />
                <input
                    type="text"
                    value={query}
                    autoFocus={autoFocus}
                    onChange={e => { setQuery(e.target.value); setIsOpen(true); }}
                    onFocus={() => setIsOpen(true)}
                    placeholder={placeholder}
                    className={[
                        'w-full rounded-[10px] pl-8 pr-8 py-[7px] text-[13px] text-text-primary focus:outline-none transition-colors',
                        isLight
                            ? 'bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-accent-primary/40 focus:ring-2 focus:ring-accent-primary/10'
                            : 'bg-bg-input border border-border-muted placeholder-text-tertiary focus:border-white/20 focus:ring-0',
                    ].join(' ')}
                />
                {isSearching && (
                    <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-text-tertiary animate-spin" />
                )}
            </div>

            <AnimatePresence>
                {isOpen && (query.trim() || results.length > 0 || (suggestions?.length ?? 0) > 0) && (
                    <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.12 }}
                        className={[
                            // z-30 keeps the list above the modal footer; the
                            // panel no longer clips it (no overflow-hidden).
                            'absolute z-30 mt-1 w-full rounded-xl overflow-y-auto shadow-xl border max-h-56 custom-scrollbar',
                            isLight ? 'bg-white border-slate-200' : 'bg-bg-secondary border-border-muted',
                        ].join(' ')}
                    >
                        {/* Attendee-domain candidates — the multi-domain case
                        where the backend deliberately didn't pick for the user */}
                        {!query.trim() && suggestions && suggestions.length > 0 && (
                            <>
                                <p className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                                    Suggested for this meeting
                                </p>
                                {suggestions.map(s => (
                                    <button
                                        key={s.domain}
                                        type="button"
                                        onClick={() => pickSuggestion(s)}
                                        className={[
                                            'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
                                            isLight ? 'hover:bg-blue-50' : 'hover:bg-blue-500/10',
                                        ].join(' ')}
                                    >
                                        <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${isLight ? 'bg-blue-100 text-blue-600' : 'bg-blue-500/15 text-blue-400'}`}>
                                            <Briefcase size={12} />
                                        </div>
                                        <span className={`text-[13px] font-medium truncate ${isLight ? 'text-slate-800' : 'text-text-primary'}`}>
                                            {s.name}
                                        </span>
                                        <span className="text-[11px] text-text-tertiary truncate">{s.domain}</span>
                                    </button>
                                ))}
                                <div className={`border-t my-1 ${isLight ? 'border-slate-100' : 'border-border-subtle'}`} />
                            </>
                        )}

                        {results.map(company => (
                            <button
                                key={company.id}
                                type="button"
                                onClick={() => pick(company)}
                                className={[
                                    'w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
                                    isLight ? 'hover:bg-slate-50' : 'hover:bg-white/[0.04]',
                                ].join(' ')}
                            >
                                <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${isLight ? 'bg-violet-100 text-violet-500' : 'bg-violet-500/15 text-violet-400'}`}>
                                    <Briefcase size={12} />
                                </div>
                                <span className={`text-[13px] font-medium truncate ${isLight ? 'text-slate-800' : 'text-text-primary'}`}>
                                    {company.name}
                                </span>
                                {company.domain && (
                                    <span className="text-[11px] text-text-tertiary truncate">{company.domain}</span>
                                )}
                            </button>
                        ))}

                        {showCreate && (
                            <button
                                type="button"
                                onClick={pickNew}
                                className={[
                                    'w-full flex items-center gap-2.5 px-3 py-2 text-left border-t transition-colors',
                                    isLight ? 'border-slate-100 hover:bg-blue-50' : 'border-border-subtle hover:bg-blue-500/10',
                                ].join(' ')}
                            >
                                <div className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${isLight ? 'bg-blue-100 text-blue-600' : 'bg-blue-500/15 text-blue-400'}`}>
                                    <Plus size={12} />
                                </div>
                                <span className={`text-[13px] font-medium truncate ${isLight ? 'text-blue-700' : 'text-blue-400'}`}>
                                    Create “{query.trim()}”
                                </span>
                            </button>
                        )}

                        {!showCreate && results.length === 0 && !isSearching && (
                            <p className="px-3 py-3 text-[12px] text-text-tertiary text-center">
                                No companies found yet — type a name to create one.
                            </p>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// ─── CompanySelectModal ──────────────────────────────────────────────────────

export interface CompanySelectModalProps {
    meetingId: string;
    /** 'post-call' offers Skip (records company_skipped); 'edit' offers Remove. */
    mode: 'post-call' | 'edit';
    initialCompany?: CompanyRef | null;
    /** Attendee-domain candidates (multi-domain meetings) — rendered as a
    "Suggested for this meeting" group when the search box is empty. */
    candidates?: { name: string; domain: string }[];
    isLight: boolean;
    onClose: () => void;
    /** Fires with the linked company after a successful association. */
    onSaved?: (company: CompanyRef) => void;
    /** Fires after Skip (post-call) or Remove (edit). */
    onCleared?: () => void;
}

export const CompanySelectModal: React.FC<CompanySelectModalProps> = ({
    meetingId, mode, initialCompany, candidates, isLight, onClose, onSaved, onCleared,
}) => {
    const [picked, setPicked] = useState<PickedCompany | null>(
        initialCompany
            ? { companyId: initialCompany.id, name: initialCompany.name, domain: initialCompany.domain }
            : null,
    );
    const [isSaving, setIsSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [skipping, setSkipping] = useState(false);

    const handleSave = async () => {
        if (!picked || isSaving) return;
        setIsSaving(true);
        setError(null);
        try {
            const saved = await meetingsApi.setCompany(
                meetingId,
                picked.companyId
                    ? { company_id: picked.companyId }
                    // Create-new carries the detected domain so the registry
                    // row is born searchable by "acme.com"-style queries.
                    : { name: picked.name, ...(picked.domain ? { domain: picked.domain } : {}) },
            );
            onSaved?.(saved);
            onClose();
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : 'Failed to link company');
        } finally {
            setIsSaving(false);
        }
    };

    const handleClear = async (skipped: boolean) => {
        setSkipping(true);
        setError(null);
        try {
            await meetingsApi.clearCompany(meetingId, skipped);
            onCleared?.();
            onClose();
        } catch (e) {
            setError(e instanceof Error && e.message ? e.message : 'Failed to update');
        } finally {
            setSkipping(false);
        }
    };

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="fixed inset-0 z-[110] backdrop-blur-sm bg-black/50"
                onClick={onClose}
            />
            <motion.div
                initial={{ opacity: 0, scale: 0.96, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 8 }}
                transition={{ duration: 0.22, type: 'spring', damping: 26, stiffness: 320 }}
                className="fixed inset-0 z-[111] flex items-center justify-center p-4 pointer-events-none"
            >
                <div className={[
                    // NO overflow-hidden: the picker's dropdown is absolutely
                    // positioned and must be allowed to extend past the panel
                    // (rounded corners are handled on header/footer instead).
                    'relative w-full max-w-[440px] rounded-2xl shadow-2xl pointer-events-auto',
                    isLight ? 'bg-bg-elevated border border-border-muted' : 'bg-bg-secondary border border-border-muted',
                ].join(' ')}>
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-border-muted rounded-t-2xl">
                        <div className="flex items-center gap-2">
                            <div className="flex h-[26px] w-[26px] items-center justify-center rounded-lg bg-violet-500/15 text-violet-400">
                                <Building2 size={12} strokeWidth={2.2} />
                            </div>
                            <div>
                                <p className="text-[13px] font-semibold text-text-primary leading-normal">
                                    {mode === 'post-call' ? 'Which company was this call with?' : 'Associated company'}
                                </p>
                                <p className="text-[11px] text-text-tertiary leading-tight">
                                    Used to give AI analysis and chat the right customer context
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-1 rounded-full text-text-tertiary hover:text-text-primary hover:bg-white/10 transition-colors"
                            aria-label="Close"
                        >
                            <X size={13} />
                        </button>
                    </div>

                    {/* Body */}
                    <div className="px-4 py-3 space-y-3">
                        <CompanyPickerField
                            isLight={isLight}
                            value={picked}
                            onChange={setPicked}
                            suggestions={candidates}
                            autoFocus
                        />
                        {error && (
                            <div className="flex items-center gap-2 text-[12px] rounded-lg px-3 py-2 border text-red-400 bg-red-500/10 border-red-500/20">
                                {error}
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    <div className="flex items-center justify-between px-4 py-2.5 border-t border-border-muted bg-bg-item-surface/50 rounded-b-2xl">
                        {mode === 'post-call' ? (
                            <button
                                onClick={() => handleClear(true)}
                                disabled={skipping || isSaving}
                                className="px-3.5 py-1.5 text-[12.5px] rounded-[10px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-white/[0.06] transition-colors disabled:opacity-40"
                            >
                                Skip
                            </button>
                        ) : (
                            <button
                                onClick={() => handleClear(false)}
                                disabled={skipping || isSaving || !initialCompany}
                                className="px-3.5 py-1.5 text-[12.5px] rounded-[10px] font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                            >
                                Remove
                            </button>
                        )}
                        <div className="flex items-center gap-1.5">
                            <button
                                onClick={onClose}
                                disabled={skipping}
                                className="px-3.5 py-1.5 text-[12.5px] rounded-[10px] font-medium text-text-tertiary hover:text-text-secondary hover:bg-white/[0.06] transition-colors disabled:opacity-40"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={!picked || isSaving || skipping}
                                className={[
                                    'flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-[12.5px] font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed',
                                    isLight ? 'bg-accent-primary hover:bg-blue-700 shadow-sm' : 'bg-accent-primary hover:bg-blue-500',
                                ].join(' ')}
                            >
                                {isSaving ? (
                                    <Loader2 size={12} className="animate-spin" />
                                ) : (
                                    <Check size={12} />
                                )}
                                {initialCompany ? 'Update' : 'Save'}
                            </button>
                        </div>
                    </div>
                </div>
            </motion.div>
        </AnimatePresence>
    );
};
