import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { BiLogoZoom } from "react-icons/bi";
import { SiGooglecalendar } from "react-icons/si";
import { Loader, Check, CalendarDays } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';

type Provider = 'google' | 'zoom';

const PROVIDERS: {
    id: Provider;
    label: string;
    subtitle: string;
    Icon: React.ElementType;
    iconBg: string;
    iconColor: string;
}[] = [
        {
            id: 'google',
            label: 'Google Calendar',
            subtitle: 'Connect your Google account',
            Icon: SiGooglecalendar,
            iconBg: 'bg-white',
            iconColor: 'text-yellow-500',
        },
        {
            id: 'zoom',
            label: 'Zoom',
            subtitle: 'Connect your Zoom account',
            Icon: BiLogoZoom,
            iconBg: 'bg-[#2D8CFF]',
            iconColor: 'text-white',
        },
    ];

const ConnectCalendarButton: React.FC<{
    onConnect?: () => void;
    onDisconnect?: () => void;
    className?: string;
}> = ({ onConnect, onDisconnect, className = '' }) => {
    const isLight = useResolvedTheme() === 'light';

    const [loading, setLoading] = useState<Provider | null>(null);
    const [connected, setConnected] = useState<Record<Provider, boolean>>({
        google: false,
        zoom: false,
    });
    const [showPicker, setShowPicker] = useState(false);
    const [dropdownPos, setDropdownPos] = useState({ top: 0, left: 0, width: 0 });

    const mainButtonRef = useRef<HTMLButtonElement>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // ── Load initial connection status ────────────────────────────────────────
    useEffect(() => {
        if (!window.electronAPI) return;
        Promise.all([
            window.electronAPI.getCalendarStatus(),
            window.electronAPI.getZoomCalendarStatus(),
        ]).then(([google, zoom]) => {
            setConnected({ google: google.connected, zoom: zoom.connected });
            if (google.connected || zoom.connected) onConnect?.();
        });
    }, []);

    useEffect(() => {
        if (!window.electronAPI) return;
        const handleSettingsClosed = () => {
            Promise.all([
                window.electronAPI.getCalendarStatus(),
                window.electronAPI.getZoomCalendarStatus(),
            ]).then(([google, zoom]) => {
                const wasAnyConnected = Object.values(connected).some(Boolean);
                const isAnyConnected = google.connected || zoom.connected;
                setConnected({ google: google.connected, zoom: zoom.connected });
                if (isAnyConnected) {
                    onConnect?.();
                } else if (wasAnyConnected && !isAnyConnected) {
                    onDisconnect?.();
                }
            });
        };
        window.addEventListener('settings-closed', handleSettingsClosed);
        return () => window.removeEventListener('settings-closed', handleSettingsClosed);
    }, [connected, onConnect, onDisconnect]);

    // ── Close on outside click or Escape ─────────────────────────────────────
    useEffect(() => {
        if (!showPicker) return;

        const handleOutsideClick = (e: MouseEvent) => {
            const target = e.target as Node;
            const clickedDropdown = dropdownRef.current?.contains(target);
            const clickedMainBtn = mainButtonRef.current?.contains(target);
            const clickedAddBtn = addButtonRef.current?.contains(target);
            if (!clickedDropdown && !clickedMainBtn && !clickedAddBtn) {
                setShowPicker(false);
            }
        };

        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setShowPicker(false);
        };

        document.addEventListener('mousedown', handleOutsideClick, true);
        document.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleOutsideClick, true);
            document.removeEventListener('keydown', handleEscape);
        };
    }, [showPicker]);

    // ── Recalculate position on scroll / resize while open ────────────────────
    useEffect(() => {
        if (!showPicker) return;
        const update = () => recalcPosition(mainButtonRef.current || addButtonRef.current);
        window.addEventListener('scroll', update, true);
        window.addEventListener('resize', update);
        return () => {
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        };
    }, [showPicker]);

    const recalcPosition = (el: HTMLElement | null) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setDropdownPos({
            top: rect.bottom + 8,
            left: rect.left,
            width: Math.max(rect.width, 240),
        });
    };

    const togglePicker = (ref: React.RefObject<HTMLButtonElement>) => {
        if (!showPicker) {
            recalcPosition(ref.current);
            setShowPicker(true);
        } else {
            setShowPicker(false);
        }
    };

    // ── Connect handler ───────────────────────────────────────────────────────
    const handleConnect = async (provider: Provider) => {
        setShowPicker(false);
        setLoading(provider);
        try {
            const res = provider === 'google'
                ? await window.electronAPI.calendarConnect()
                : await window.electronAPI.zoomCalendarConnect();

            if (res?.success) {
                setConnected(prev => ({ ...prev, [provider]: true }));
                onConnect?.();
            }
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(null);
        }
    };

    const anyConnected = Object.values(connected).some(Boolean);
    const connectedList = PROVIDERS.filter(p => connected[p.id]);
    const unconnectedList = PROVIDERS.filter(p => !connected[p.id]);

    // ── Shared floating dropdown ──────────────────────────────────────────────
    const Dropdown = ({ items }: { items: typeof PROVIDERS }) => {
        const dropdownContent = (
            <div
                ref={dropdownRef}
                style={{
                    position: 'fixed',
                    top: dropdownPos.top,
                    left: dropdownPos.left,
                    minWidth: dropdownPos.width,
                    zIndex: 99999,
                    // Light: clean white card with slate border
                    // Dark: deep purple-tinted dark as before
                    background: isLight
                        ? 'var(--bg-elevated)'
                        : 'linear-gradient(180deg, #14102a 0%, #0e0a1e 100%)',
                    animation: 'calDropdownIn 0.18s cubic-bezier(0.22,1,0.36,1) forwards',
                }}
                className={[
                    'overflow-hidden rounded-xl',
                    isLight
                        ? 'shadow-[0_8px_32px_-4px_rgba(0,0,0,0.12),0_0_0_1px_rgba(0,0,0,0.07)]'
                        : 'shadow-[0_24px_48px_-8px_rgba(0,0,0,0.7),0_0_0_1px_rgba(99,60,255,0.25)]',
                ].join(' ')}
            >
                {items.map((p, i) => (
                    <React.Fragment key={p.id}>
                        <button
                            onClick={() => handleConnect(p.id)}
                            disabled={!!loading}
                            className={[
                                'w-full flex items-center gap-3 px-4 py-3.5 transition-colors disabled:opacity-50 disabled:cursor-wait text-left',
                                isLight ? 'hover:bg-bg-item-surface' : 'hover:bg-white/[0.06]',
                            ].join(' ')}
                        >
                            {/* Provider icon */}
                            <span className={[
                                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[18px]",
                                p.iconBg,
                                p.iconColor,
                            ].join(" ")}>
                                <p.Icon />
                            </span>

                            {/* Title + subtitle */}
                            <span className="flex flex-col min-w-0">
                                <span className={[
                                    'text-[13px] font-semibold leading-tight',
                                    isLight ? 'text-text-primary' : 'text-white',
                                ].join(' ')}>
                                    {p.label}
                                </span>
                                <span className={[
                                    'text-[11px] mt-0.5',
                                    isLight ? 'text-text-secondary' : 'text-text-tertiary',
                                ].join(' ')}>
                                    {p.subtitle}
                                </span>
                            </span>

                            {/* Loading indicator */}
                            {loading === p.id && (
                                <Loader size={13} className="ml-auto shrink-0 animate-spin text-blue-500" />
                            )}

                            {/* Connected check */}
                            {connected[p.id] && (
                                <Check size={13} className="ml-auto shrink-0 text-emerald-500" strokeWidth={2.5} />
                            )}
                        </button>

                        {/* Row divider */}
                        {i < items.length - 1 && (
                            <div className="mx-4 border-t border-border-subtle" />
                        )}
                    </React.Fragment>
                ))}
            </div>
        );
        return ReactDOM.createPortal(dropdownContent, document.body);
    };

    // ── Connected state ───────────────────────────────────────────────────────
    if (anyConnected) {
        return (
            <>
                <div className={`flex flex-col gap-2 ${className}`}>
                    {/* Connected pills */}
                    <div className="flex flex-wrap gap-2">
                        {connectedList.map(p => (
                            <span
                                key={p.id}
                                className={[
                                    'flex items-center gap-1.5 text-[11px] font-medium rounded-full px-3 py-1 border',
                                    isLight
                                        ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                                        : 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20',
                                ].join(' ')}
                            >
                                <Check size={10} strokeWidth={3} />
                                {p.label}
                            </span>
                        ))}
                    </div>

                    {/* Add more button — only when some providers still unconnected */}
                    {unconnectedList.length > 0 && (
                        <button
                            ref={addButtonRef}
                            onClick={() => togglePicker(addButtonRef)}
                            className={[
                                "w-full h-9 flex items-center justify-center gap-2 rounded-xl",
                                "text-[12px] font-medium transition-all duration-200",
                                isLight
                                    ? [
                                        'border border-border-muted text-text-secondary',
                                        'hover:border-border-muted hover:text-text-primary hover:bg-bg-item-surface',
                                        showPicker ? 'bg-bg-item-surface text-text-primary border-border-muted' : '',
                                    ].join(' ')
                                    : [
                                        'border border-border-subtle text-text-tertiary',
                                        'hover:border-border-muted hover:text-white hover:bg-bg-item-surface',
                                        showPicker ? 'bg-bg-item-surface text-white border-border-muted' : '',
                                    ].join(' '),
                            ].join(" ")}
                        >
                            <CalendarDays size={13} strokeWidth={2} />
                            Add another account
                        </button>
                    )}
                </div>

                {showPicker && <Dropdown items={unconnectedList} />}

                <style>{`
                    @keyframes calDropdownIn {
                        from { opacity: 0; transform: translateY(-8px) scale(0.96); }
                        to   { opacity: 1; transform: translateY(0)     scale(1);    }
                    }
                `}</style>
            </>
        );
    }

    // ── Disconnected state ────────────────────────────────────────────────────
    return (
        <>
            <button
                ref={mainButtonRef}
                onClick={() => togglePicker(mainButtonRef)}
                disabled={!!loading}
                className={[
                    "group relative w-full h-11 flex items-center justify-center gap-2 overflow-hidden",
                    "rounded-xl text-[13px] font-semibold",
                    "transition-all duration-200 active:scale-[0.98]",
                    loading ? "opacity-70 cursor-wait" : "",
                    isLight ? "text-white hover:brightness-105" : "text-white hover:brightness-110",
                    className,
                ].join(" ")}
                style={
                    isLight
                        ? {
                            // Light mode: cleaner, slightly less neon — confident blue-to-indigo
                            background: 'linear-gradient(135deg, #3b82f6 0%, #6366f1 100%)',
                            boxShadow: '0 4px 16px -4px rgba(99,102,241,0.45)',
                        }
                        : {
                            background: 'linear-gradient(135deg, #3b5bfc 0%, #6d28d9 100%)',
                            boxShadow: '0 8px 24px -6px rgba(99,60,255,0.55)',
                        }
                }
            >
                {/* Top gloss highlight — kept in both modes, softer in light */}
                <span
                    aria-hidden
                    className={[
                        'absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b to-transparent pointer-events-none',
                        isLight ? 'from-white/15' : 'from-white/20',
                    ].join(' ')}
                />

                {loading ? (
                    <Loader size={14} className="relative z-10 animate-spin" />
                ) : (
                    <CalendarDays size={14} strokeWidth={2.2} className="relative z-10" />
                )}

                <span className="relative z-10">
                    {loading ? 'Connecting...' : 'Connect Calendar'}
                </span>
            </button>

            {showPicker && <Dropdown items={PROVIDERS} />}

            <style>{`
                @keyframes calDropdownIn {
                    from { opacity: 0; transform: translateY(-8px) scale(0.96); }
                    to   { opacity: 1; transform: translateY(0)     scale(1);    }
                }
            `}</style>
        </>
    );
};

export default ConnectCalendarButton;