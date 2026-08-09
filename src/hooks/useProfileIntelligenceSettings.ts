// Profile Intelligence tab: resume upload -> structured persona, job
// description upload, AI company research on the JD's target company, and
// AI-generated negotiation scripts. Also owns the Pro-license gate
// (`isPremium`) shared by Profile Mode and the premium upsell modal, since
// it's fetched from the same place profile status is.

import { useCallback, useEffect, useState } from 'react';

interface ProfileStatus {
    hasProfile: boolean;
    profileMode: boolean;
    name?: string;
    role?: string;
    totalExperienceYears?: number;
}

interface UseProfileIntelligenceSettingsArgs {
    isOpen: boolean;
    /** Proactively loads profile data when the overlay opens directly onto the profile tab. */
    initialTab?: string;
}

export function useProfileIntelligenceSettings({ isOpen, initialTab }: UseProfileIntelligenceSettingsArgs) {
    const [profileStatus, setProfileStatus] = useState<ProfileStatus>({ hasProfile: false, profileMode: false });
    const [profileData, setProfileData] = useState<any>(null);
    const [profileUploading, setProfileUploading] = useState(false);
    const [profileError, setProfileError] = useState('');

    const [isPremium, setIsPremium] = useState(false);
    const [isPremiumModalOpen, setIsPremiumModalOpen] = useState(false);

    const [jdUploading, setJdUploading] = useState(false);
    const [jdError, setJdError] = useState('');

    const [companyResearching, setCompanyResearching] = useState(false);
    const [companyDossier, setCompanyDossier] = useState<any>(null);

    const [negotiationScript, setNegotiationScript] = useState<any>(null);
    const [negotiationGenerating, setNegotiationGenerating] = useState(false);
    const [negotiationError, setNegotiationError] = useState('');

    /** Re-fetches profile status + data (and the negotiation script embedded in it, if any). Shared by the mount-time load and the "switch to Profile tab" nav handler. */
    const loadProfile = useCallback(async () => {
        try {
            const status = await window.electronAPI?.profileGetStatus?.();
            if (status) setProfileStatus(status);
            const data = await window.electronAPI?.profileGetProfile?.();
            if (data) {
                setProfileData(data);
                if (data.negotiationScript) setNegotiationScript(data.negotiationScript);
            }
        } catch (e) {
            console.warn('[useProfileIntelligenceSettings] Failed to load profile status:', e);
        }
    }, []);

    // ── Load premium status + profile data ───────────────────────────────────
    useEffect(() => {
        if (!isOpen) return;
        window.electronAPI?.licenseCheckPremium?.().then(setIsPremium).catch(() => { });
        // Proactively load if the overlay was opened directly onto the profile tab.
        if (initialTab === 'profile') loadProfile();
    }, [isOpen, initialTab, loadProfile]);

    const uploadResume = async () => {
        setProfileError('');
        try {
            const fileResult = await window.electronAPI?.profileSelectFile?.();
            if (fileResult?.cancelled || !fileResult?.filePath) return;

            setProfileUploading(true);
            const result = await window.electronAPI?.profileUploadResume?.(fileResult.filePath);
            if (result?.success) {
                await loadProfile();
            } else {
                setProfileError(result?.error || 'Upload failed');
            }
        } catch (e: any) {
            setProfileError(e.message || 'Upload failed');
        } finally {
            setProfileUploading(false);
        }
    };

    const deleteProfile = async () => {
        if (!confirm('Are you sure you want to delete your mapped persona? This will destroy all structured timeline data.')) return;
        try {
            await window.electronAPI?.profileDelete?.();
            setProfileStatus({ hasProfile: false, profileMode: false });
            setProfileData(null);
        } catch (e) {
            console.error('[useProfileIntelligenceSettings] Failed to delete profile:', e);
        }
    };

    const toggleProfileMode = async () => {
        if (!profileStatus.hasProfile || !isPremium) return;
        const newState = !profileStatus.profileMode;
        try {
            await window.electronAPI?.profileSetMode?.(newState);
            setProfileStatus((prev) => ({ ...prev, profileMode: newState }));
        } catch (e) {
            console.error('[useProfileIntelligenceSettings] Failed to toggle profile mode:', e);
        }
    };

    const uploadJobDescription = async () => {
        setJdError('');
        try {
            const fileResult = await window.electronAPI?.profileSelectFile?.();
            if (fileResult?.cancelled || !fileResult?.filePath) return;

            setJdUploading(true);
            const result = await window.electronAPI?.profileUploadJD?.(fileResult.filePath);
            if (result?.success) {
                const data = await window.electronAPI?.profileGetProfile?.();
                if (data) setProfileData(data);
            } else {
                setJdError(result?.error || 'JD upload failed');
            }
        } catch (e: any) {
            setJdError(e.message || 'JD upload failed');
        } finally {
            setJdUploading(false);
        }
    };

    const deleteJobDescription = async () => {
        await window.electronAPI?.profileDeleteJD?.();
        const data = await window.electronAPI?.profileGetProfile?.();
        if (data) setProfileData(data);
        setCompanyDossier(null); // dossier was scoped to the JD's company — clear it with the JD
    };

    const researchCompany = async () => {
        if (!profileData?.activeJD?.company) return;
        setCompanyResearching(true);
        try {
            const result = await window.electronAPI?.profileResearchCompany?.(profileData.activeJD.company);
            if (result?.success && result.dossier) setCompanyDossier(result.dossier);
        } catch (e) {
            console.error('[useProfileIntelligenceSettings] Company research failed:', e);
        } finally {
            setCompanyResearching(false);
        }
    };

    /** Pass `true` to regenerate an existing script, `false` to generate the first one. */
    const generateNegotiationScript = async (regenerate: boolean) => {
        setNegotiationGenerating(true);
        setNegotiationError('');
        try {
            const result = await window.electronAPI?.profileGenerateNegotiation?.(regenerate);
            if (result?.success && result.script) {
                setNegotiationScript(result.script);
            } else {
                setNegotiationError(result?.error || `Failed to ${regenerate ? 'regenerate' : 'generate'}`);
            }
        } catch {
            setNegotiationError('Generation failed');
        } finally {
            setNegotiationGenerating(false);
        }
    };

    return {
        profileStatus,
        profileData,
        profileUploading,
        profileError,
        isPremium,
        isPremiumModalOpen,
        setIsPremiumModalOpen,
        jdUploading,
        jdError,
        companyResearching,
        companyDossier,
        negotiationScript,
        negotiationGenerating,
        negotiationError,
        loadProfile,
        uploadResume,
        deleteProfile,
        toggleProfileMode,
        uploadJobDescription,
        deleteJobDescription,
        researchCompany,
        generateNegotiationScript,
    };
}