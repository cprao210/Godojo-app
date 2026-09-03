// Company Context tab. `<CompanyContextTab>` owns its own load/save/upload
// logic internally and just needs this state lifted up to the overlay level
// (so it survives switching away to another tab and back). The one thing
// that *does* belong here is the initial load, since it's triggered from two
// places — opening directly onto this tab, and clicking its sidebar nav item
// — and both need identical behavior.
//
// Identity / value prop / personas / competitors come from the FastAPI
// /company-context routes (companyContextApi). Knowledge-base asset METADATA
// (what's uploaded, its status) comes from GET /intelligence/company-assets —
// also tenant-scoped, so a team member sees the admin's uploaded docs instead
// of just whatever's on their own device. The local Electron/SQLite store
// (window.electronAPI.companyGetContext) is only a fallback for when that
// backend call fails (e.g. offline) — it can't see another user's uploads at
// all, which is exactly why members couldn't see admin-uploaded docs before.

import { useCallback, useState } from 'react';
import { companyContextApi } from '@/api/companyContextApi';
import { intelligenceApi } from '@/api/intelligenceApi';
import { BackendCompanyAsset, CompanyContextData, KnowledgeAsset } from '@/types';
import { normalizeContext } from './useCompanyContext';

const KNOWN_ASSET_TYPES: KnowledgeAsset['type'][] = ['sales_deck', 'product_specs', 'case_studies', 'custom'];
const KNOWN_ASSET_STATUSES: KnowledgeAsset['status'][] = ['mapped', 'processing', 'need_update'];

/** Maps the backend's loosely-typed asset row onto the frontend's KnowledgeAsset shape. */
function mapBackendAsset(a: BackendCompanyAsset): KnowledgeAsset {
    return {
        id: a.id,
        type: (KNOWN_ASSET_TYPES as string[]).includes(a.type) ? (a.type as KnowledgeAsset['type']) : 'custom',
        label: a.label,
        // Backend statuses beyond the three the UI knows about (e.g. an 'error'
        // or 'indexed' value) fall back to 'processing' rather than crashing a
        // status-based style lookup on an unrecognized value.
        status: (KNOWN_ASSET_STATUSES as string[]).includes(a.status) ? (a.status as KnowledgeAsset['status']) : 'processing',
        lastUpdated: a.last_updated,
    };
}

export function useCompanyContextSettings() {
    const [companyContext, setCompanyContext] = useState<CompanyContextData | null>(null);
    const [companyLoading, setCompanyLoading] = useState(false);
    const [companySaving, setCompanySaving] = useState(false);
    const [companyError, setCompanyError] = useState('');
    const [assetUploading, setAssetUploading] = useState<string | null>(null);

    /** Shared by the initial-tab bootstrap effect and the sidebar nav click handler. */
    const loadCompanyContext = useCallback(() => {
        setCompanyLoading(true);
        Promise.all([
            companyContextApi.get().catch(() => null),
            companyContextApi.listPersonas().catch(() => []),
            companyContextApi.listCompetitors().catch(() => []),
            intelligenceApi.listCompanyAssets().catch(() => null),
            window.electronAPI?.companyGetContext?.().catch(() => null) ?? Promise.resolve(null),
        ])
            .then(([ctx, personas, competitors, backendAssets, localCtx]) => {
                // Prefer the backend's tenant-scoped asset list; only fall back to
                // the local/per-device list if that call failed outright (e.g. the
                // route isn't reachable), not just because it came back empty —
                // an empty array is a legitimate "no docs uploaded yet" answer.
                const assets: KnowledgeAsset[] = backendAssets
                    ? backendAssets.map(mapBackendAsset)
                    : (localCtx?.assets ?? []);

                const merged: CompanyContextData = normalizeContext(
                    ctx
                        ? ({
                            identity: {
                                name: ctx.name ?? '',
                                website: ctx.website ?? '',
                                industry: ctx.industry ?? '',
                            },
                            coreValueProposition: ctx.core_value_proposition ?? '',
                            assets,
                            targetPersonas: personas.map(p => ({
                                id: p.id,
                                role: p.role,
                                description: p.description,
                            })),
                            competitors: competitors.map(c => ({
                                id: c.id,
                                name: c.name,
                                moat: c.moat,
                                winRate: c.win_rate,
                            })),
                            dataCompleteness: ctx.data_completeness ?? 0,
                            completenessBreakdown: localCtx?.completenessBreakdown,
                        } as CompanyContextData)
                        // Backend has no row yet — fall back entirely to whatever
                        // local/legacy data exists (pre-migration installs, or a
                        // brand-new user who hasn't saved anything yet), but still
                        // prefer the backend asset list if we got one.
                        : (localCtx ? { ...localCtx, assets } : localCtx),
                );
                setCompanyContext(merged);
            })
            .catch(() => { })
            .finally(() => setCompanyLoading(false));
    }, []);

    return {
        companyContext,
        setCompanyContext,
        companyLoading,
        setCompanyLoading,
        companySaving,
        setCompanySaving,
        companyError,
        setCompanyError,
        assetUploading,
        setAssetUploading,
        loadCompanyContext,
    };
}