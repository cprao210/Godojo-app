// Data + interaction layer for UserProfileTab. Includes the standalone
// loadUserProfile / saveUserProfile helpers (used elsewhere in the app to
// read the cached profile — e.g. Launcher, UserProfileButton) plus the hook
// that owns the tab's own editing state. Kept separate from the component so
// the component only owns rendering — same split as useProviderCard /
// useCropper / useAIProvidersSettings.

import { useCallback, useEffect, useRef, useState } from "react";
import { getFirebaseAuth } from "@/lib/firebase";
import { UserProfileData } from "@/types";
import { settingsToast } from "@/lib/settingsToastBus";

/**
 * The cached profile holds displayName / email / phone / role / organization /
 * location / website / bio / photoDataUrl, and BOTH the header
 * (UserProfileButton) and the Launcher prefer it over Firebase's own user
 * object. On a single shared key that means after switching accounts the app
 * keeps rendering the previous user's name and photo — not for a frame, but
 * until that user opens Settings > Profile and saves. So: one key per uid.
 */
const PROFILE_KEY_PREFIX = "gd_user_profile";
const LEGACY_PROFILE_KEY = "gd_user_profile";

function profileKey(): string {
    const uid = getFirebaseAuth().currentUser?.uid;
    // No uid resolved yet (shouldn't happen — the auth gate mounts these
    // consumers only once authUser exists) — keep the old behavior.
    return uid ? `${PROFILE_KEY_PREFIX}_${uid}` : LEGACY_PROFILE_KEY;
}

const SAVE_ANIMATION_MS = 400;
const SAVED_BADGE_MS = 2000;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5 MB

/** Reads the cached profile from localStorage, seeding it from the current Firebase user if none is saved yet. */
export function loadUserProfile(): UserProfileData {
    const auth = getFirebaseAuth();
    const firebaseUser = auth.currentUser;
    const uid = firebaseUser?.uid ?? "";
    const key = profileKey();

    try {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
    } catch {
        /* ignore corrupt cache */
    }

    // One-time migration off the old shared key — but only adopt it if it
    // genuinely belongs to this user. On a machine that has had two accounts the
    // shared blob is whoever saved last, and handing it to the wrong user is the
    // exact leak this split exists to fix.
    if (uid && key !== LEGACY_PROFILE_KEY) {
        try {
            const legacyRaw = localStorage.getItem(LEGACY_PROFILE_KEY);
            if (legacyRaw) {
                const legacy = JSON.parse(legacyRaw) as UserProfileData;
                if (legacy?.email && firebaseUser?.email && legacy.email === firebaseUser.email) {
                    localStorage.setItem(key, legacyRaw);
                    localStorage.removeItem(LEGACY_PROFILE_KEY);
                    return legacy;
                }
            }
        } catch {
            /* ignore corrupt legacy cache */
        }
    }

    // No saved profile yet — seed from Firebase auth user.
    const savedPhone = uid ? (localStorage.getItem(`natively_signup_phone_${uid}`) ?? "") : "";

    return {
        displayName: firebaseUser?.displayName ?? "",
        email: firebaseUser?.email ?? "",
        phone: savedPhone,
        role: "",
        organization: "",
        location: "",
        website: "",
        bio: "",
        photoDataUrl: null,
    };
}

/** Persists the profile to localStorage and broadcasts a storage event so other open windows/components pick up the change. */
export function saveUserProfile(data: UserProfileData): void {
    const key = profileKey();
    localStorage.setItem(key, JSON.stringify(data));
    window.dispatchEvent(new StorageEvent("storage", {
        key,
        newValue: JSON.stringify(data),
    }));
}

export function useUserProfileTab() {
    const [profile, setProfile] = useState<UserProfileData>(loadUserProfile);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [photoError, setPhotoError] = useState("");

    const fileInputRef = useRef<HTMLInputElement>(null);

    // Backfill from Firebase on mount: email always stays in sync (source of
    // truth), name/phone are only filled in if the saved profile has them blank.
    useEffect(() => {
        const auth = getFirebaseAuth();
        const firebaseUser = auth.currentUser;
        if (!firebaseUser) return;

        const uid = firebaseUser.uid;
        const savedPhone = localStorage.getItem(`natively_signup_phone_${uid}`) ?? "";

        setProfile((prev) => ({
            ...prev,
            email: firebaseUser.email ?? prev.email,
            displayName: prev.displayName || firebaseUser.displayName || "",
            phone: prev.phone || savedPhone,
        }));
    }, []);

    const setField = useCallback((key: keyof UserProfileData, value: string) => {
        setProfile((prev) => ({ ...prev, [key]: value }));
    }, []);

    const handlePhotoUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setPhotoError("");
        const file = e.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            setPhotoError("Please select an image file.");
            return;
        }
        if (file.size > MAX_PHOTO_BYTES) {
            setPhotoError("Image must be smaller than 5 MB.");
            return;
        }

        const reader = new FileReader();
        reader.onload = (ev) => {
            const dataUrl = ev.target?.result as string;
            setProfile((p) => ({ ...p, photoDataUrl: dataUrl }));
        };
        reader.readAsDataURL(file);
    }, []);

    const handleSave = useCallback(() => {
        setSaving(true);
        try {
            saveUserProfile(profile);
            setTimeout(() => {
                setSaving(false);
                setSaved(true);
                settingsToast.success('Saved Successfully');
                setTimeout(() => setSaved(false), SAVED_BADGE_MS);
            }, SAVE_ANIMATION_MS);
        } catch (e: any) {
            settingsToast.error(e?.message ?? 'Failed to save profile.');
        }
    }, [profile]);

    const triggerPhotoPicker = useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const initials = profile.displayName
        ? profile.displayName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()
        : (profile.email?.[0]?.toUpperCase() ?? "U");

    return {
        profile,
        setField,
        saving,
        saved,
        photoError,
        fileInputRef,
        handlePhotoUpload,
        handleSave,
        triggerPhotoPicker,
        initials,
    };
}