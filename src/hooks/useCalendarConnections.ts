// State + IPC layer for ConnectCalendarButton: tracks which calendar
// providers are connected, and drives the floating provider-picker dropdown
// (position, open/close, outside-click/Escape dismissal). Kept separate from
// the component so it only owns rendering.

import { useCallback, useEffect, useRef, useState } from "react";
import { posthogAnalytics } from "@/lib/analytics/posthog.service";
import { CalendarProvider, Provider } from "@/types";

type ConnectionStatus = Record<Provider, boolean>;

interface DropdownPosition {
    top: number;
    left: number;
    width: number;
}

interface UseCalendarConnectionsArgs {
    providers: CalendarProvider[];
    onConnect?: () => void;
    onDisconnect?: () => void;
}

/** Reads both providers' connection status from the main process in one shot. */
async function readConnectionStatus(): Promise<ConnectionStatus> {
    const [google, zoom] = await Promise.all([
        window.electronAPI.getCalendarStatus(),
        window.electronAPI.getZoomCalendarStatus(),
    ]);
    return { google: google.connected, zoom: zoom.connected };
}

export function useCalendarConnections({ providers, onConnect, onDisconnect }: UseCalendarConnectionsArgs) {
    const [loading, setLoading] = useState<Provider | null>(null);
    const [connected, setConnected] = useState<ConnectionStatus>({ google: false, zoom: false });
    const [showPicker, setShowPicker] = useState(false);
    const [dropdownPos, setDropdownPos] = useState<DropdownPosition>({ top: 0, left: 0, width: 0 });

    const mainButtonRef = useRef<HTMLButtonElement>(null);
    const addButtonRef = useRef<HTMLButtonElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // ── Load connection status on mount ─────────────────────────────────────
    useEffect(() => {
        if (!window.electronAPI) return;
        readConnectionStatus().then((status) => {
            setConnected(status);
            if (status.google || status.zoom) onConnect?.();
        });
        // Deliberately mount-only: re-checking is handled by the settings-closed
        // listener below rather than re-running this on every onConnect identity change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // ── Re-check whenever the Settings window closes ────────────────────────
    // (the user may have connected/disconnected a provider from there).
    useEffect(() => {
        if (!window.electronAPI) return;
        const handleSettingsClosed = () => {
            const wasAnyConnected = Object.values(connected).some(Boolean);
            readConnectionStatus().then((status) => {
                setConnected(status);
                const isAnyConnected = status.google || status.zoom;
                if (isAnyConnected) onConnect?.();
                else if (wasAnyConnected) onDisconnect?.();
            });
        };
        window.addEventListener("settings-closed", handleSettingsClosed);
        return () => window.removeEventListener("settings-closed", handleSettingsClosed);
    }, [connected, onConnect, onDisconnect]);

    // ── Close the picker on outside click or Escape ─────────────────────────
    useEffect(() => {
        if (!showPicker) return;

        const handleOutsideClick = (e: MouseEvent) => {
            const target = e.target as Node;
            const clickedDropdown = dropdownRef.current?.contains(target);
            const clickedMainBtn = mainButtonRef.current?.contains(target);
            const clickedAddBtn = addButtonRef.current?.contains(target);
            if (!clickedDropdown && !clickedMainBtn && !clickedAddBtn) setShowPicker(false);
        };
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === "Escape") setShowPicker(false);
        };

        document.addEventListener("mousedown", handleOutsideClick, true);
        document.addEventListener("keydown", handleEscape);
        return () => {
            document.removeEventListener("mousedown", handleOutsideClick, true);
            document.removeEventListener("keydown", handleEscape);
        };
    }, [showPicker]);

    const recalcPosition = useCallback((el: HTMLElement | null) => {
        if (!el) return;
        const rect = el.getBoundingClientRect();
        setDropdownPos({ top: rect.bottom + 8, left: rect.left, width: Math.max(rect.width, 240) });
    }, []);

    // ── Keep the dropdown aligned to its trigger button while open ──────────
    useEffect(() => {
        if (!showPicker) return;
        const update = () => recalcPosition(mainButtonRef.current || addButtonRef.current);
        window.addEventListener("scroll", update, true);
        window.addEventListener("resize", update);
        return () => {
            window.removeEventListener("scroll", update, true);
            window.removeEventListener("resize", update);
        };
    }, [showPicker, recalcPosition]);

    const togglePicker = useCallback(
        (ref: React.RefObject<HTMLButtonElement>) => {
            if (!showPicker) {
                recalcPosition(ref.current);
                setShowPicker(true);
            } else {
                setShowPicker(false);
            }
        },
        [showPicker, recalcPosition],
    );

    const handleConnect = useCallback(
        async (provider: Provider) => {
            setShowPicker(false);
            setLoading(provider);
            posthogAnalytics.trackCalendarConnectClicked(provider);
            try {
                const res =
                    provider === "google"
                        ? await window.electronAPI.calendarConnect()
                        : await window.electronAPI.zoomCalendarConnect();

                if (res?.success) {
                    setConnected((prev) => ({ ...prev, [provider]: true }));
                    posthogAnalytics.trackCalendarConnected(provider);
                    onConnect?.();
                }
            } catch (err) {
                console.error("[useCalendarConnections] connect failed:", err);
            } finally {
                setLoading(null);
            }
        },
        [onConnect],
    );

    const anyConnected = Object.values(connected).some(Boolean);
    const connectedList = providers.filter((p) => connected[p.id]);
    const unconnectedList = providers.filter((p) => !connected[p.id]);

    return {
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
    };
}