// State + interaction layer for Cropper: owns the drag-selection state,
// theme detection, canvas rendering (DPI-aware), and all the Electron IPC
// wiring (reset-cropper listener, ESC-to-cancel, confirm on release).
// Kept separate from the component so the component only owns rendering —
// same split as useCalendarConnections / useTopSearchPill / useEditableTextBlock.

import { useCallback, useEffect, useRef, useState } from "react";

type Point = { x: number; y: number };
type Theme = "dark" | "light";

const MIN_SELECTION_SIZE = 5;
const CORNER_SIZE = 14;
const DEFAULT_HUD_WIDTH = 320;

export function useCropper() {
    const [startPos, setStartPos] = useState<Point | null>(null);
    const [currentPos, setCurrentPos] = useState<Point | null>(null);
    const [hudPosition, setHudPosition] = useState<Point | null>(null);
    const [theme, setTheme] = useState<Theme>("dark");

    const canvasRef = useRef<HTMLCanvasElement>(null);
    const hudRef = useRef<HTMLDivElement>(null);
    // Stores the HUD width once measured; used to calculate centering offset.
    const hudWidthRef = useRef<number>(DEFAULT_HUD_WIDTH);
    // Ref mirrors of startPos/currentPos so window-level handlers can read current values.
    const startPosRef = useRef<Point | null>(null);
    const currentPosRef = useRef<Point | null>(null);

    // Keep refs in sync with state (needed by the window-level mouseup handler).
    useEffect(() => { startPosRef.current = startPos; }, [startPos]);
    useEffect(() => { currentPosRef.current = currentPos; }, [currentPos]);

    // ── Theme detection ──────────────────────────────────────────────────
    useEffect(() => {
        const detectTheme = () => {
            const currentTheme = (document.documentElement.getAttribute("data-theme") as Theme) || "dark";
            setTheme(currentTheme);
        };
        detectTheme();
        const observer = new MutationObserver(detectTheme);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        return () => observer.disconnect();
    }, []);

    // Commit the selection — used by both the div's onMouseUp and the window-level mouseup.
    const commitSelection = useCallback((sp: Point | null, cp: Point | null) => {
        if (!sp || !cp) return;
        const x = Math.min(sp.x, cp.x);
        const y = Math.min(sp.y, cp.y);
        const width = Math.abs(cp.x - sp.x);
        const height = Math.abs(cp.y - sp.y);
        if (width > MIN_SELECTION_SIZE && height > MIN_SELECTION_SIZE) {
            (window as any).electronAPI.cropperConfirmed({ x, y, width, height });
        } else {
            setStartPos(null);
            setCurrentPos(null);
        }
    }, []);

    // ── Reset handler + IPC bootstrap + global event listeners ──────────
    useEffect(() => {
        // Measure HUD width once it's mounted and visible. ResizeObserver is used
        // (rather than a childList MutationObserver) because the HUD already
        // contains its children on first render, so a childList observer would
        // never fire.
        let resizeObs: ResizeObserver | null = null;
        if (hudRef.current) {
            resizeObs = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (entry) {
                    const w = entry.contentRect.width;
                    if (w > 0) hudWidthRef.current = w;
                }
            });
            resizeObs.observe(hudRef.current);
        }

        // IPC: listen for the main-process reset signal (window is reused between captures).
        const cleanupIpc = (window as any).electronAPI.onResetCropper((data: { hudPosition: Point }) => {
            setStartPos(null);
            setCurrentPos(null);
            const halfWidth = hudWidthRef.current / 2;
            setHudPosition({
                x: data.hudPosition.x - halfWidth,
                y: data.hudPosition.y,
            });
        });

        // ESC cancels the crop.
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                (window as any).electronAPI.cropperCancelled();
                setStartPos(null);
                setCurrentPos(null);
            }
        };

        // Window-level mouseup: fires even if the cursor left the component bounds
        // mid-drag, so the selection never gets stuck if released outside.
        const handleWindowMouseUp = () => {
            commitSelection(startPosRef.current, currentPosRef.current);
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("mouseup", handleWindowMouseUp);

        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("mouseup", handleWindowMouseUp);
            cleanupIpc();
            resizeObs?.disconnect();
        };
    }, [commitSelection]);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault(); // prevent text selection
        setStartPos({ x: e.clientX, y: e.clientY });
        setCurrentPos({ x: e.clientX, y: e.clientY });
    }, []);

    const handleMouseMove = useCallback(
        (e: React.MouseEvent) => {
            if (startPos) {
                setCurrentPos({ x: e.clientX, y: e.clientY });
            }
        },
        [startPos],
    );

    // The div-level handler is kept for completeness; the window-level handler does the real commit
    // (propagation from this div's mouseup also triggers it).
    const handleMouseUp = useCallback(() => { }, []);

    // ── Canvas rendering — DPI-aware ──────────────────────────────────────
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const dpr = window.devicePixelRatio || 1;
        const cssWidth = window.innerWidth;
        const cssHeight = window.innerHeight;

        // Physical pixel dimensions — prevents blurry canvas on HiDPI/Retina screens.
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
        // Canvas element stays at CSS pixel size.
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;

        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        // Scale all drawing ops to match physical pixels.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssWidth, cssHeight);

        // Background overlay.
        ctx.fillStyle = theme === "dark" ? "rgba(0, 0, 0, 0.35)" : "rgba(0, 0, 0, 0.12)";
        ctx.fillRect(0, 0, cssWidth, cssHeight);

        if (startPos && currentPos) {
            const x = Math.min(startPos.x, currentPos.x);
            const y = Math.min(startPos.y, currentPos.y);
            const w = Math.abs(currentPos.x - startPos.x);
            const h = Math.abs(currentPos.y - startPos.y);

            // Clear the selected area (show through to the screen).
            ctx.clearRect(x, y, w, h);

            // Subtle inner border on the selected area.
            ctx.strokeStyle = theme === "dark" ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.12)";
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

            // Corner handles — drawn in CSS pixels, DPR scaling applied via setTransform.
            ctx.strokeStyle = theme === "dark" ? "rgba(255, 255, 255, 0.5)" : "rgba(0, 0, 0, 0.4)";
            ctx.lineWidth = 1.5;
            ctx.lineCap = "round";
            ctx.lineJoin = "round";

            const drawCorner = (x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) => {
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.lineTo(x3, y3);
                ctx.stroke();
            };

            drawCorner(x, y + CORNER_SIZE, x, y, x + CORNER_SIZE, y);
            drawCorner(x + w - CORNER_SIZE, y, x + w, y, x + w, y + CORNER_SIZE);
            drawCorner(x + w, y + h - CORNER_SIZE, x + w, y + h, x + w - CORNER_SIZE, y + h);
            drawCorner(x + CORNER_SIZE, y + h, x, y + h, x, y + h - CORNER_SIZE);
        }
    }, [startPos, currentPos, theme]);

    return {
        // state
        startPos,
        hudPosition,
        theme,
        isLightTheme: theme === "light",
        // refs
        canvasRef,
        hudRef,
        // handlers
        handleMouseDown,
        handleMouseMove,
        handleMouseUp,
    };
}