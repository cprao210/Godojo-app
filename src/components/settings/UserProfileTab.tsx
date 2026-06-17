import React, { useState, useRef, useEffect } from 'react';
import { User, Camera, Building2, Briefcase, MapPin, Phone, Mail, Globe, Upload, Check, X, Pencil } from 'lucide-react';
import { getFirebaseAuth } from '../../lib/firebase';

interface UserProfileData {
    displayName: string;
    email: string;
    phone: string;
    role: string;
    organization: string;
    location: string;
    website: string;
    bio: string;
    photoDataUrl: string | null; // base64 data URL stored locally
}

interface UserProfileTabProps {
    isLight: boolean;
}

const PROFILE_KEY = 'gd_user_profile';

export function loadUserProfile(): UserProfileData {
    try {
        const raw = localStorage.getItem(PROFILE_KEY);
        if (raw) return JSON.parse(raw);
    } catch { /* ignore */ }

    // No saved profile yet — seed from Firebase auth user
    const auth = getFirebaseAuth();
    const firebaseUser = auth.currentUser;
    const uid = firebaseUser?.uid ?? '';
    const savedPhone = uid ? (localStorage.getItem(`natively_signup_phone_${uid}`) ?? '') : '';

    return {
        displayName: firebaseUser?.displayName ?? '',
        email: firebaseUser?.email ?? '',
        phone: savedPhone,
        role: '',
        organization: '',
        location: '',
        website: '',
        bio: '',
        photoDataUrl: null,
    };
}

export function saveUserProfile(data: UserProfileData): void {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(data));
    // Broadcast so other open windows/components can react
    window.dispatchEvent(new StorageEvent('storage', {
        key: PROFILE_KEY,
        newValue: JSON.stringify(data),
    }));
}

export const UserProfileTab: React.FC<UserProfileTabProps> = ({ isLight }) => {
    const [profile, setProfile] = useState<UserProfileData>(loadUserProfile);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [photoError, setPhotoError] = useState('');


    useEffect(() => {
        const auth = getFirebaseAuth();
        const firebaseUser = auth.currentUser;
        if (!firebaseUser) return;

        const uid = firebaseUser.uid;
        const savedPhone = localStorage.getItem(`natively_signup_phone_${uid}`) ?? '';

        setProfile(prev => ({
            ...prev,
            // Always keep email in sync with Firebase — it's the source of truth
            email: firebaseUser.email ?? prev.email,
            // Only backfill name/phone if the saved profile has them blank
            displayName: prev.displayName || firebaseUser.displayName || '',
            phone: prev.phone || savedPhone,
        }));
    }, []);

    const fileInputRef = useRef<HTMLInputElement>(null);


    const field = (
        key: keyof UserProfileData,
        label: string,
        icon: React.ReactNode,
        placeholder: string,
        type: string = 'text',
        disabled: boolean = false,
    ) => (
        <div>
            <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                <span className="text-text-tertiary">{icon}</span>
                {label}
                {disabled && (
                    <span className="ml-1 text-[10px] font-normal text-text-tertiary normal-case tracking-normal">(managed by account)</span>
                )}
            </label>
            <input
                type={type}
                value={(profile[key] as string) ?? ''}
                onChange={e => !disabled && setProfile(p => ({ ...p, [key]: e.target.value }))}
                placeholder={placeholder}
                disabled={disabled}
                className={`w-full px-3 py-2.5 rounded-lg text-sm text-text-primary placeholder-text-tertiary
              border transition-colors focus:outline-none focus:border-accent-primary
              ${disabled
                        ? 'opacity-60 cursor-not-allowed bg-bg-item-surface border-border-subtle'
                        : isLight
                            ? 'bg-white border-slate-200 focus:border-blue-400'
                            : 'bg-bg-input border-border-subtle'
                    }`}
            />
        </div>
    );

    const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
        setPhotoError('');
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setPhotoError('Please select an image file.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setPhotoError('Image must be smaller than 5 MB.');
            return;
        }
        const reader = new FileReader();
        reader.onload = ev => {
            const dataUrl = ev.target?.result as string;
            setProfile(p => ({ ...p, photoDataUrl: dataUrl }));
        };
        reader.readAsDataURL(file);
    };

    const handleSave = () => {
        setSaving(true);
        saveUserProfile(profile);
        setTimeout(() => {
            setSaving(false);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        }, 400);
    };

    const initials = profile.displayName
        ? profile.displayName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
        : profile.email?.[0]?.toUpperCase() ?? 'U';

    return (
        <div className="space-y-6 animated fadeIn pb-6">
            {/* Header */}
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-1">User Profile</h3>
                <p className="text-xs text-text-secondary">
                    Your personal details — used across the app wherever your identity appears.
                </p>
            </div>

            {/* Avatar section */}
            <div className={`rounded-xl border p-5 flex items-center gap-5
        ${isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle'}`}
            >
                <div className="relative shrink-0">
                    <div className="w-20 h-20 rounded-full overflow-hidden bg-gradient-to-br from-blue-500 to-blue-700
            flex items-center justify-center text-white text-2xl font-bold ring-2 ring-blue-500/30"
                    >
                        {profile.photoDataUrl
                            ? <img src={profile.photoDataUrl} alt="Profile" className="w-full h-full object-cover" />
                            : <span>{initials}</span>
                        }
                    </div>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-accent-primary text-white
              flex items-center justify-center shadow-md hover:scale-110 transition-transform"
                        title="Upload photo"
                    >
                        <Camera size={13} />
                    </button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={handlePhotoUpload}
                    />
                </div>

                <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-text-primary truncate">
                        {profile.displayName || 'Your Name'}
                    </p>
                    <p className="text-xs text-text-secondary truncate">
                        {profile.role || 'Your Role'}{profile.organization ? ` · ${profile.organization}` : ''}
                    </p>
                    <button
                        onClick={() => fileInputRef.current?.click()}
                        className="mt-2 flex items-center gap-1.5 text-xs text-accent-primary hover:underline"
                    >
                        <Upload size={11} />
                        {profile.photoDataUrl ? 'Change photo' : 'Upload photo'}
                    </button>
                    {photoError && (
                        <p className="mt-1 text-xs text-red-500 flex items-center gap-1">
                            <X size={11} /> {photoError}
                        </p>
                    )}
                </div>
            </div>

            {/* Fields */}
            <div className={`rounded-xl border p-5 space-y-4
        ${isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle'}`}
            >
                <h4 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Personal Info</h4>
                <div className="grid grid-cols-2 gap-4">
                    {field('displayName', 'Full Name', <User size={12} />, 'John Smith')}
                    {field('email', 'Email', <Mail size={12} />, 'you@company.com', 'email', true)}
                    {field('phone', 'Phone', <Phone size={12} />, '+1 (555) 000-0000', 'tel')}
                    {field('location', 'Location', <MapPin size={12} />, 'San Francisco, CA')}
                </div>
            </div>

            <div className={`rounded-xl border p-5 space-y-4
        ${isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle'}`}
            >
                <h4 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Professional</h4>
                <div className="grid grid-cols-2 gap-4">
                    {field('role', 'Role / Title', <Briefcase size={12} />, 'Account Executive')}
                    {field('organization', 'Organization', <Building2 size={12} />, 'Acme Corp')}
                    {field('website', 'Website / LinkedIn', <Globe size={12} />, 'https://linkedin.com/in/you', 'url')}
                </div>

                <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                        <span className="text-text-tertiary"><Pencil size={12} /></span>
                        Short Bio
                    </label>
                    <textarea
                        value={profile.bio}
                        onChange={e => setProfile(p => ({ ...p, bio: e.target.value }))}
                        rows={3}
                        placeholder="A brief description about yourself…"
                        className={`w-full px-3 py-2.5 rounded-lg text-sm text-text-primary placeholder-text-tertiary
              border transition-colors focus:outline-none focus:border-accent-primary resize-none
              ${isLight
                                ? 'bg-white border-slate-200 focus:border-blue-400'
                                : 'bg-bg-input border-border-subtle'
                            }`}
                    />
                </div>
            </div>

            {/* Save */}
            <div className="flex justify-end">
                <button
                    onClick={handleSave}
                    disabled={saving}
                    className={`px-6 py-2.5 rounded-lg text-sm font-semibold transition-all flex items-center gap-2
            ${saved
                            ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                            : 'bg-accent-primary text-white hover:opacity-90 shadow-md'
                        }`}
                >
                    {saved ? <><Check size={14} /> Saved!</> : saving ? 'Saving…' : 'Save Profile'}
                </button>
            </div>
        </div>
    );
};