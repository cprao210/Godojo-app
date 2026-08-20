// Company Context tab. `<CompanyContextTab>` owns its own load/save/upload
// logic internally and just needs this state lifted up to the overlay level
// (so it survives switching away to another tab and back). The one thing
// that *does* belong here is the initial load, since it's triggered from two
// places — opening directly onto this tab, and clicking its sidebar nav item
// — and both need identical behavior.

import { useCallback, useState } from 'react';

export function useCompanyContextSettings() {
    const [companyContext, setCompanyContext] = useState<any>(null);
    const [companyLoading, setCompanyLoading] = useState(false);
    const [companySaving, setCompanySaving] = useState(false);
    const [companyError, setCompanyError] = useState('');
    const [assetUploading, setAssetUploading] = useState<string | null>(null);

    /** Shared by the initial-tab bootstrap effect and the sidebar nav click handler. */
    const loadCompanyContext = useCallback(() => {
        setCompanyLoading(true);
        window.electronAPI?.companyGetContext?.()
            .then(setCompanyContext)
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