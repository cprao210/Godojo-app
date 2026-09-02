import React, { useState, useRef, useEffect } from 'react';
import { LogOut, ChevronDown, Users, UserPlus } from 'lucide-react';
import { useResolvedTheme } from '@/hooks';
import { isMac } from '@/../utils/platformUtils';
import { loadUserProfile } from '@/features/settings';
import { switchToAccount } from '@/lib/firebase';
import { MenuItem, UserProfileButtonProps } from '@/types';
import { createPortal } from 'react-dom';

const UserProfileButton: React.FC<UserProfileButtonProps> = ({
    displayName,
    email,
    photoURL,
    onSignOut,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const [accounts, setAccounts] = useState<Array<{ uid: string; email?: string; displayName?: string; photoURL?: string; isActive: boolean }>>([]);
    const isLight = useResolvedTheme() === 'light';
    const [switchingUid, setSwitchingUid] = useState<string | null>(null);
    const [switchError, setSwitchError] = useState<string | null>(null);

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        window.electronAPI?.authListAccounts?.().then(setAccounts).catch(() => { });
        return () => document.removeEventListener('mousedown', handleClick);
    }, [isOpen]);

    // Close on Escape
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsOpen(false);
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [isOpen]);

    const handleSwitch = async (uid: string) => {
        if (switchingUid) return;

        // Never swap the DB out from under a live meeting — DatabaseManager
        // .switchUser() closes the handle mid-write.
        try {
            if (await window.electronAPI?.getMeetingActive?.()) {
                setSwitchError('Finish the current meeting before switching accounts.');
                return;
            }
        } catch { /* can't tell — fall through rather than block the switch */ }

        setSwitchError(null);
        setSwitchingUid(uid);
        setIsOpen(false);

        // The cover below is painted BEFORE this await on purpose.
        // signInWithCustomToken inside switchToAccount flips Firebase's
        // currentUser, which fires onAuthStateChanged and re-renders this whole
        // tree with the NEW identity while tenant / meetings / react-query /
        // the cached local profile are all still the OLD account's. That
        // half-switched frame is the flicker; the cover makes it invisible.
        const ok = await switchToAccount(uid);

        if (!ok) {
            // Previously this fell through to hardRefresh() as well, so a failed
            // switch was indistinguishable from a successful one.
            setSwitchingUid(null);
            setSwitchError('Could not switch account. Please try again.');
            return;
        }

        // Only now: switchToAccount has awaited the main-process handshake, so
        // credentials, the SQLite file and identityStore.lastUid are already
        // committed to the new uid and the reload restores it deterministically.
        // Every window, not just this one: the overlay/settings/model-selector
        // renderers each run their own Firebase auth listener and React tree,
        // and a surviving one can push a stale token back into AuthManager
        // after the switch. Safe to reload them all because we refused above
        // if a meeting was active. Falls back to the single-window reload on an
        // older preload that doesn't expose the new channel yet.
        if (window.electronAPI?.reloadAllWindows) {
            window.electronAPI.reloadAllWindows();
        } else {
            window.electronAPI?.hardRefresh?.();
        }
    };

    const otherAccounts = accounts.filter((a) => !a.isActive);

    const [localProfile, setLocalProfile] = useState(() => loadUserProfile());

    // Re-read when another tab saves the profile. Prefix match, not equality:
    // the cache key is now per-uid (gd_user_profile_<uid>), so an === check
    // against the bare key never fires and the avatar/name silently stop
    // updating when the user saves Settings > Profile.
    useEffect(() => {
        const handler = (e: StorageEvent) => {
            if (e.key?.startsWith('gd_user_profile')) {
                setLocalProfile(loadUserProfile());
            }
        };
        window.addEventListener('storage', handler);
        return () => window.removeEventListener('storage', handler);
    }, []);

    // Re-read when the signed-in account changes. loadUserProfile() resolves a
    // per-uid key, but useState's initializer runs once per mount — and the
    // "Add another account" flow (onSignOut → SignIn → new user) never
    // remounts this component, so without this the header keeps rendering the
    // PREVIOUS account's name, photo, role and organization.
    useEffect(() => {
        setLocalProfile(loadUserProfile());
    }, [email]);

    // Merge: local profile name/photo takes priority over Firebase auth data
    const effectiveName = localProfile.displayName || displayName || email?.split('@')[0] || 'Account';
    const effectivePhoto = localProfile.photoDataUrl || photoURL || null;
    const shortName = effectiveName;
    const initials = effectiveName.split(' ').map((w: string) => w[0]).join('').slice(0, 2).toUpperCase() || 'U';

    // Menu items — easily extendable in the future
    const menuItems: MenuItem[] = [
        {
            id: 'signout',
            label: 'Sign out',
            icon: <LogOut size={13} />,
            onClick: () => {
                setIsOpen(false);
                onSignOut();
            },
            danger: true,
        },
    ];

    const dropdownBg = isLight
        ? 'bg-bg-elevated text-text-primary border border-border-muted shadow-[0_8px_24px_rgba(0,0,0,0.12)]'
        : 'bg-gray-900 text-text-primary border border-border-subtle shadow-[0_8px_32px_rgba(0,0,0,0.5)]';

    return (
        <div ref={containerRef} className="relative flex items-center">

            {(switchingUid || switchError) && createPortal(
                <div
                    style={{ position: 'fixed', inset: 0, zIndex: 100000 }}
                    className={`flex flex-col items-center justify-center gap-3 ${isLight ? 'bg-white' : 'bg-[#000000]'}`}
                    role="status"
                    aria-live="polite"
                    aria-busy={!!switchingUid}
                >
                    {switchingUid ? (
                        <>
                            <div className={`h-5 w-5 animate-spin rounded-full border-2 border-t-transparent ${isLight ? 'border-gray-400' : 'border-gray-600'}`} />
                            <span className="text-xs text-text-secondary">Switching account…</span>
                        </>
                    ) : (
                        <>
                            <span className="text-xs text-text-primary">{switchError}</span>
                            <button
                                type="button"
                                onClick={() => setSwitchError(null)}
                                className="rounded-md border border-border-muted px-3 py-1 text-xs text-text-secondary hover:text-text-primary"
                            >
                                Close
                            </button>
                        </>
                    )}
                </div>,
                document.body
            )}

            <button
                onClick={() => setIsOpen((v) => !v)}
                aria-haspopup="true"
                aria-expanded={isOpen}
                type='button'
                className={[
                    "flex items-center gap-2 rounded-full pl-1 pr-3 transition-all no-drag",
                    isMac ? "h-9" : "h-7",   // ← shrink on Windows
                    isLight
                        ? "border border-border-muted bg-bg-elevated/90 hover:bg-bg-elevated"
                        : "border border-border-subtle bg-bg-item-surface hover:bg-white/[0.08]",
                ].join(" ")}
            >
                <div className={[
                    "rounded-full flex items-center justify-center overflow-hidden ring-2 ring-blue-500/30",
                    isMac ? "h-7 w-7 text-xs" : "h-5 w-5 text-[10px]",
                ].join(" ")}
                    style={!effectivePhoto ? { background: 'linear-gradient(135deg, #3b82f6, #1d4ed8)' } : undefined}
                >
                    {effectivePhoto
                        ? <img src={effectivePhoto} alt={shortName} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        : <span className="text-white font-bold">{initials}</span>
                    }
                </div>
                <span className={["text-xs font-medium", isLight ? "text-text-primary" : "text-white"].join(" ")}>
                    {displayName?.split(' ')[0] ?? email?.split('@')[0] ?? 'Account'}
                </span>
                <ChevronDown className="h-3.5 w-3.5 text-text-tertiary" />
            </button>

            {/* Dropdown */}
            {isOpen && (
                <div
                    className={`
                        absolute top-full right-0 mt-1.5 w-56 rounded-xl z-[500]
                        ${dropdownBg}
                        duration-150
                    `}
                    role="menu"
                >
                    {/* User info header */}
                    <div className="px-3 py-2.5 border-b border-border-subtle">
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-[var(--bg-item-surface)] shrink-0 ring-1 ring-white/10">
                                {effectivePhoto ? (
                                    <img
                                        src={effectivePhoto}
                                        alt={shortName}
                                        className="w-full h-full object-cover"
                                        referrerPolicy="no-referrer"
                                    />
                                ) : (
                                    <div className="w-full h-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center text-white font-bold text-xs">
                                        {initials}
                                    </div>
                                )}
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className="text-[12px] font-semibold truncate text-text-primary">
                                    {effectiveName}
                                </span>
                                {(localProfile.role || localProfile.organization) && (
                                    <span className="text-[10px] text-text-secondary truncate">
                                        {localProfile.role}{localProfile.organization ? ` · ${localProfile.organization}` : ''}
                                    </span>
                                )}
                                {email && !localProfile.role && (
                                    <span className="text-[10px] text-text-secondary truncate">{email}</span>
                                )}
                            </div>

                        </div>
                    </div>

                    {otherAccounts.length > 0 && (
                        <div className="p-1 border-b border-border-subtle" role="none">
                            <div className="px-2.5 py-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-text-tertiary">
                                <Users size={11} /> Switch account
                            </div>
                            {/* Cap the list at ~2 rows; scroll vertically when there are more. */}
                            <div className={otherAccounts.length > 2 ? 'max-h-[88px] overflow-y-auto custom-scrollbar' : ''}>
                                {otherAccounts.map((acct) => {

                                    const name = acct.displayName || acct.email?.split('@')[0] || 'Account';
                                    const acctInitials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase() || 'U';
                                    return (
                                        <button
                                            key={acct.uid}
                                            type="button"
                                            role="menuitem"
                                            disabled={!!switchingUid}
                                            onClick={() => handleSwitch(acct.uid)}
                                            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[12px] font-medium text-text-secondary hover:bg-bg-item-surface hover:text-text-primary transition-colors duration-150 disabled:opacity-50"
                                        >
                                            <div className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center shrink-0 ring-1 ring-white/10 bg-gradient-to-br from-blue-500 to-blue-700 text-white text-[10px] font-bold">
                                                {acct.photoURL
                                                    ? <img src={acct.photoURL} alt={name} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                                                    : acctInitials}
                                            </div>
                                            <div className="flex flex-col min-w-0">
                                                <span className="truncate">{name}</span>
                                                {acct.email && <span className="text-[10px] text-text-tertiary truncate">{acct.email}</span>}
                                            </div>
                                            {switchingUid === acct.uid && <span className="ml-auto text-[10px] text-text-tertiary">…</span>}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}


                    {/* Menu items */}
                    <div className="p-1" role="none">
                        <button
                            type="button"
                            role="menuitem"
                            onClick={() => { setIsOpen(false); onSignOut(); /* or a dedicated onAddAccount that opens SignIn */ }}
                            className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[12px] font-medium text-text-secondary hover:bg-bg-item-surface hover:text-text-primary"
                        >
                            <UserPlus size={13} /> Add another account
                        </button>
                        {menuItems.map((item) => (
                            <button
                                key={item.id}
                                type="button"
                                role="menuitem"
                                onClick={item.onClick}
                                className={`
                                    w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left text-[12px] font-medium
                                    transition-colors duration-150
                                    ${item.danger
                                        ? isLight
                                            ? 'text-red-600 hover:bg-red-50'
                                            : 'text-red-400 hover:bg-red-500/10'
                                        : 'text-text-secondary hover:bg-bg-item-surface hover:text-text-primary'
                                    }
                                `}
                            >
                                {item.icon}
                                {item.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

export default UserProfileButton;