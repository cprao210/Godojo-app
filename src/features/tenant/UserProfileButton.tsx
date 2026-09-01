import React, { useState, useRef, useEffect } from 'react';
import { LogOut, ChevronDown, Users, UserPlus } from 'lucide-react';
import { useResolvedTheme } from '@/hooks';
import { isMac } from '@/../utils/platformUtils';
import { loadUserProfile } from '@/features/settings';
import { switchToAccount } from '@/lib/firebase';
import { MenuItem, UserProfileButtonProps } from '@/types';

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
        setSwitchingUid(uid);
        const ok = await switchToAccount(uid);
        setIsOpen(false);
        if (!ok) setSwitchingUid(null);
        window.electronAPI?.hardRefresh?.();
        // On success: onAuthStateChanged updates the gate. Do NOT hardRefresh.
    };

    const otherAccounts = accounts.filter((a) => !a.isActive);

    const [localProfile, setLocalProfile] = useState(() => loadUserProfile());

    // Re-read when another tab saves the profile
    useEffect(() => {
        const handler = (e: StorageEvent) => {
            if (e.key === 'gd_user_profile') {
                setLocalProfile(loadUserProfile());
            }
        };
        window.addEventListener('storage', handler);
        return () => window.removeEventListener('storage', handler);
    }, []);

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