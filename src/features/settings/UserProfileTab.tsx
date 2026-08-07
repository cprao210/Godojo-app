import React from 'react';
import { User, Camera, Building2, Briefcase, MapPin, Phone, Mail, Globe, Upload, Check, X, Pencil } from 'lucide-react';
import { useUserProfileTab } from '@/hooks';
import { UserProfileTabProps } from '@/types';
import ProfileField from './ProfileField';

// Re-exported so existing imports (e.g. Launcher.tsx, UserProfileButton.tsx,
// and this feature's index.ts barrel) keep working unchanged — the actual
// implementations now live alongside the hook in useUserProfileTab.ts.
export { loadUserProfile, saveUserProfile } from '@/hooks';

// ============================================
// Main Component
// ============================================
// The "User Profile" settings tab: avatar/photo upload, personal info, and
// professional info. All state, Firebase sync, and save logic now live in
// useUserProfileTab — this component only renders.
export const UserProfileTab: React.FC<UserProfileTabProps> = ({ isLight }) => {
    const {
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
    } = useUserProfileTab();

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
                        onClick={triggerPhotoPicker}
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
                        onClick={triggerPhotoPicker}
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
                    <ProfileField label="Full Name" icon={<User size={12} />} value={profile.displayName} onChange={(v) => setField('displayName', v)} placeholder="John Smith" isLight={isLight} />
                    <ProfileField label="Email" icon={<Mail size={12} />} value={profile.email} onChange={(v) => setField('email', v)} placeholder="you@company.com" type="email" disabled isLight={isLight} />
                    <ProfileField label="Phone" icon={<Phone size={12} />} value={profile.phone} onChange={(v) => setField('phone', v)} placeholder="+1 (555) 000-0000" type="tel" isLight={isLight} />
                    <ProfileField label="Location" icon={<MapPin size={12} />} value={profile.location} onChange={(v) => setField('location', v)} placeholder="San Francisco, CA" isLight={isLight} />
                </div>
            </div>

            <div className={`rounded-xl border p-5 space-y-4
        ${isLight ? 'bg-white border-slate-200/80' : 'bg-bg-item-surface border-border-subtle'}`}
            >
                <h4 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">Professional</h4>
                <div className="grid grid-cols-2 gap-4">
                    <ProfileField label="Role / Title" icon={<Briefcase size={12} />} value={profile.role} onChange={(v) => setField('role', v)} placeholder="Account Executive" isLight={isLight} />
                    <ProfileField label="Organization" icon={<Building2 size={12} />} value={profile.organization} onChange={(v) => setField('organization', v)} placeholder="Acme Corp" isLight={isLight} />
                    <ProfileField label="Website / LinkedIn" icon={<Globe size={12} />} value={profile.website} onChange={(v) => setField('website', v)} placeholder="https://linkedin.com/in/you" type="url" isLight={isLight} />
                </div>

                <div>
                    <label className="flex items-center gap-1.5 text-xs font-medium text-text-secondary mb-1.5 uppercase tracking-wide">
                        <span className="text-text-tertiary"><Pencil size={12} /></span>
                        Short Bio
                    </label>
                    <textarea
                        value={profile.bio}
                        onChange={(e) => setField('bio', e.target.value)}
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