import React from 'react';
import ReactDOM from 'react-dom';
import { BiLogoZoom } from "react-icons/bi";
import { SiGooglecalendar } from "react-icons/si";
import { Loader, Check, CalendarDays } from 'lucide-react';
import { useResolvedTheme, useCalendarConnections } from '@/hooks';
import { CalendarProvider, ConnectCalendarButtonProps } from '@/types';

const PROVIDERS: CalendarProvider[] = [
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

const ConnectCalendarButton: React.FC<ConnectCalendarButtonProps> = ({ onConnect, onDisconnect, className = '' }) => {

    const isLight = useResolvedTheme() === 'light';

    const {
        loading,
        connected,
        anyConnected,
        connectedList,
        unconnectedList,
        showPicker,
        dropdownPos,
        mainButtonRef,
        addButtonRef,
        dropdownRef,
        togglePicker,
        handleConnect,
    } = useCalendarConnections({ providers: PROVIDERS, onConnect, onDisconnect });

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