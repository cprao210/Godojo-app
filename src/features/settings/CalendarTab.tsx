import React from 'react';
import { useSettingsOverlay } from '@/hooks';

type SettingsOverlayHook = ReturnType<typeof useSettingsOverlay>;

const GoogleLogo: React.FC<{ size?: number }> = ({ size = 18 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} xmlns="http://www.w3.org/2000/svg">
        <g transform="matrix(1, 0, 0, 1, 27.009001, -39.238998)">
            <path fill="#4285F4" d="M -3.264 51.509 C -3.264 50.719 -3.334 49.969 -3.454 49.239 L -14.754 49.239 L -14.754 53.749 L -8.284 53.749 C -8.574 55.229 -9.424 56.479 -10.684 57.329 L -10.684 60.329 L -6.824 60.329 C -4.564 58.239 -3.264 55.159 -3.264 51.509 Z" />
            <path fill="#34A853" d="M -14.754 63.239 C -11.514 63.239 -8.804 62.159 -6.824 60.329 L -10.684 57.329 C -11.764 58.049 -13.134 58.489 -14.754 58.489 C -17.884 58.489 -20.534 56.379 -21.484 53.529 L -25.464 53.529 L -25.464 56.619 C -23.494 60.539 -19.444 63.239 -14.754 63.239 Z" />
            <path fill="#FBBC05" d="M -21.484 53.529 C -21.734 52.809 -21.864 52.039 -21.864 51.239 C -21.864 50.439 -21.734 49.669 -21.484 48.949 L -21.484 45.859 L -25.464 45.859 C -26.284 47.479 -26.754 49.299 -26.754 51.239 C -26.754 53.179 -26.284 54.999 -25.464 56.619 L -21.484 53.529 Z" />
            <path fill="#EA4335" d="M -14.754 43.989 C -12.984 43.989 -11.404 44.599 -10.154 45.789 L -6.734 42.369 C -8.804 40.429 -11.514 39.239 -14.754 39.239 C -19.444 39.239 -23.494 41.939 -25.464 45.859 L -21.484 48.949 C -20.534 46.099 -17.884 43.989 -14.754 43.989 Z" />
        </g>
    </svg>
);

const ZoomLogo: React.FC<{ size?: number }> = ({ size = 16 }) => (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="24" height="24" rx="4" fill="#2D8CFF" />
        <path d="M14.5 9.5C14.5 8.67 13.83 8 13 8H6C5.17 8 4.5 8.67 4.5 9.5v5C4.5 15.33 5.17 16 6 16h7c.83 0 1.5-.67 1.5-1.5v-1.25L17 15V9l-2.5 1.75V9.5Z" fill="white" />
    </svg>
);

/** One connect/disconnect card for a single calendar provider. */
const CalendarProviderCard: React.FC<{
    logo: React.ReactNode;
    name: string;
    connected: boolean;
    email?: string;
    loading: boolean;
    onConnect: () => void;
    onDisconnect: () => void;
}> = ({ logo, name, connected, email, loading, onConnect, onDisconnect }) => (
    <div className="bg-bg-item-surface border-border-subtle rounded-xl p-5 flex flex-col items-start gap-4">
        <div className="w-full flex items-center justify-between">
            <div className="flex items-center gap-3">
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${connected ? 'bg-blue-500/10' : 'bg-bg-item-surface border border-border-subtle'}`}>
                    {logo}
                </div>
                <div>
                    <h4 className="text-sm font-medium text-text-primary">{name}</h4>
                    <p className="text-xs text-text-secondary">{connected ? `Connected as ${email || 'User'}` : 'Not connected'}</p>
                </div>
            </div>
            {connected ? (
                <button
                    onClick={onDisconnect}
                    disabled={loading}
                    className="px-3 py-1.5 bg-bg-input hover:bg-bg-elevated border border-border-subtle text-text-primary rounded-md text-xs font-medium transition-colors"
                >
                    {loading ? 'Disconnecting...' : 'Disconnect'}
                </button>
            ) : (
                <button
                    onClick={onConnect}
                    disabled={loading}
                    className="px-3 py-1.5 bg-bg-item-surface hover:bg-bg-item-active border border-border-subtle text-text-primary rounded-md text-xs font-medium transition-colors flex items-center gap-2"
                >
                    {loading ? 'Connecting...' : 'Connect'}
                </button>
            )}
        </div>
    </div>
);

// Calendar integrations tab: Google Calendar + Zoom Calendar connection
// cards, backed entirely by `useCalendarIntegrationSettings`.
const CalendarTab: React.FC<{ overlay: SettingsOverlayHook }> = ({ overlay }) => {
    const { calendar } = overlay;

    return (
        <div className="space-y-6 animated fadeIn h-full">
            <div>
                <h3 className="text-lg font-bold text-text-primary mb-2">Visible Calendars</h3>
                <p className="text-xs text-text-secondary mb-4">Upcoming meetings are synchronized from these calendars</p>
            </div>

            <div className="space-y-3">
                <CalendarProviderCard
                    logo={<GoogleLogo />}
                    name="Google Calendar"
                    connected={calendar.calendarStatus.connected}
                    email={calendar.calendarStatus.email}
                    loading={calendar.isGoogleCalendarLoading}
                    onConnect={calendar.connectGoogleCalendar}
                    onDisconnect={calendar.disconnectGoogleCalendar}
                />

                <CalendarProviderCard
                    logo={<ZoomLogo />}
                    name="Zoom Calendar"
                    connected={calendar.zoomCalendarStatus.connected}
                    email={calendar.zoomCalendarStatus.email}
                    loading={calendar.isZoomCalendarLoading}
                    onConnect={calendar.connectZoomCalendar}
                    onDisconnect={calendar.disconnectZoomCalendar}
                />

                {!calendar.calendarStatus.connected && !calendar.zoomCalendarStatus.connected && (
                    <p className="text-xs text-text-tertiary pt-1">
                        Connect at least one calendar to see upcoming meetings in GoDojo.
                    </p>
                )}
            </div>
        </div>
    );
};

export default CalendarTab;