// Calendar integrations tab: Google + Zoom calendar connection status and
// the connect/disconnect flows for each. Distinct from `useCalendarConnections`
// (used by the small ConnectCalendarButton dropdown) — this one tracks the
// connected account's email and exposes explicit disconnect, which the
// compact button doesn't need.

import { useEffect, useState } from 'react';

interface CalendarConnectionStatus {
    connected: boolean;
    email?: string;
}

const DISCONNECTED: CalendarConnectionStatus = { connected: false };

interface UseCalendarIntegrationSettingsArgs {
    isOpen: boolean;
}

export function useCalendarIntegrationSettings({ isOpen }: UseCalendarIntegrationSettingsArgs) {
    const [calendarStatus, setCalendarStatus] = useState<CalendarConnectionStatus>(DISCONNECTED);
    const [zoomCalendarStatus, setZoomCalendarStatus] = useState<CalendarConnectionStatus>(DISCONNECTED);
    const [isGoogleCalendarLoading, setIsGoogleCalendarLoading] = useState(false);
    const [isZoomCalendarLoading, setIsZoomCalendarLoading] = useState(false);

    // ── Load both providers' status whenever the overlay opens ──────────────
    useEffect(() => {
        if (!isOpen) return;
        window.electronAPI?.getCalendarStatus?.().then(setCalendarStatus);
        window.electronAPI?.getZoomCalendarStatus?.().then(setZoomCalendarStatus);
    }, [isOpen]);

    const connectGoogleCalendar = async () => {
        setIsGoogleCalendarLoading(true);
        try {
            const res = await window.electronAPI.calendarConnect();
            if (res.success) {
                setCalendarStatus(await window.electronAPI.getCalendarStatus());
            }
        } catch (e) {
            console.error('[useCalendarIntegrationSettings] Google connect failed:', e);
        } finally {
            setIsGoogleCalendarLoading(false);
        }
    };

    const disconnectGoogleCalendar = async () => {
        setIsGoogleCalendarLoading(true);
        try {
            await window.electronAPI.calendarDisconnect();
            setCalendarStatus(await window.electronAPI.getCalendarStatus());
        } catch (e) {
            console.error('[useCalendarIntegrationSettings] Google disconnect failed:', e);
        } finally {
            setIsGoogleCalendarLoading(false);
        }
    };

    const connectZoomCalendar = async () => {
        setIsZoomCalendarLoading(true);
        try {
            const res = await window.electronAPI.zoomCalendarConnect();
            if (res?.success) {
                setZoomCalendarStatus(await window.electronAPI.getZoomCalendarStatus());
            }
        } catch (e) {
            console.error('[useCalendarIntegrationSettings] Zoom connect failed:', e);
        } finally {
            setIsZoomCalendarLoading(false);
        }
    };

    const disconnectZoomCalendar = async () => {
        setIsZoomCalendarLoading(true);
        try {
            await window.electronAPI.zoomCalendarDisconnect();
            setZoomCalendarStatus(await window.electronAPI.getZoomCalendarStatus());
        } catch (e) {
            console.error('[useCalendarIntegrationSettings] Zoom disconnect failed:', e);
        } finally {
            setIsZoomCalendarLoading(false);
        }
    };

    return {
        calendarStatus,
        zoomCalendarStatus,
        isGoogleCalendarLoading,
        isZoomCalendarLoading,
        connectGoogleCalendar,
        disconnectGoogleCalendar,
        connectZoomCalendar,
        disconnectZoomCalendar,
    };
}