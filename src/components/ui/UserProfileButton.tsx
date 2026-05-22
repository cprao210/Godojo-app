import React, { useState, useRef, useEffect } from 'react';
import { User, LogOut, ChevronDown } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';

interface UserProfileButtonProps {
    displayName?: string | null;
    email?: string | null;
    photoURL?: string | null;
    onSignOut: () => void;
}

interface MenuItem {
    id: string;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    danger?: boolean;
}

const UserProfileButton: React.FC<UserProfileButtonProps> = ({
    displayName,
    email,
    photoURL,
    onSignOut,
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const isLight = useResolvedTheme() === 'light';

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
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

    const shortName = displayName || email?.split('@')[0] || 'Account';

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
        ? 'bg-white border border-gray-200 shadow-[0_8px_24px_rgba(0,0,0,0.12)]'
        : 'bg-[#1C1C1E] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)]';

    const triggerHover = isLight
        ? 'hover:bg-black/5'
        : 'hover:bg-white/8';

    return (
        <div ref={containerRef} className="relative flex items-center">
            {/* Trigger button */}
            <button
                type="button"
                onClick={() => setIsOpen((v) => !v)}
                aria-haspopup="true"
                aria-expanded={isOpen}
                className={`
          flex items-center gap-1.5 p-1.5 rounded-lg transition-all duration-200 no-drag
          text-text-secondary hover:text-text-primary ${triggerHover}
          ${isOpen ? (isLight ? 'bg-black/5 text-text-primary' : 'bg-white/8 text-text-primary') : ''}
        `}
            >
                {/* Avatar */}
                <div className="w-[22px] h-[22px] rounded-full overflow-hidden flex items-center justify-center bg-[var(--bg-item-surface)] shrink-0 ring-1 ring-white/10">
                    {photoURL ? (
                        <img
                            src={photoURL}
                            alt={shortName}
                            className="w-full h-full object-cover"
                            referrerPolicy="no-referrer"
                        />
                    ) : (
                        <User size={12} className="text-text-secondary" />
                    )}
                </div>
                {/* <ChevronDown
                    size={11}
                    className={`transition-transform duration-200 ${isOpen ? 'rotate-180' : ''} text-text-tertiary`}
                /> */}
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
                    <div className={`px-3 py-2.5 border-b ${isLight ? 'border-gray-100' : 'border-white/10'}`}>
                        <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-full overflow-hidden flex items-center justify-center bg-[var(--bg-item-surface)] shrink-0 ring-1 ring-white/10">
                                {photoURL ? (
                                    <img
                                        src={photoURL}
                                        alt={shortName}
                                        className="w-full h-full object-cover"
                                        referrerPolicy="no-referrer"
                                    />
                                ) : (
                                    <User size={15} className="text-text-secondary" />
                                )}
                            </div>
                            <div className="flex flex-col min-w-0">
                                <span className={`text-[12px] font-semibold truncate ${isLight ? 'text-gray-900' : 'text-text-primary'}`}>
                                    {displayName || shortName}
                                </span>
                                {email && (
                                    <span className="text-[10px] text-text-secondary truncate">{email}</span>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Menu items */}
                    <div className="p-1" role="none">
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
                                        : isLight
                                            ? 'text-gray-700 hover:bg-gray-50'
                                            : 'text-text-secondary hover:bg-white/6 hover:text-text-primary'
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