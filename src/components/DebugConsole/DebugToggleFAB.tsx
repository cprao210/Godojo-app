// ============================================================================
// DebugToggleFAB.tsx
//
// DEV-only self-contained floating button + debug console.
// Owns its own open/close state via a module-level singleton so it stays
// in sync no matter which window or component tree renders it.
// Keyboard shortcut: Cmd+Shift+D (Mac) / Ctrl+Shift+D (Win/Linux)
// Draggable — position saved in sessionStorage.
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bug, X } from 'lucide-react';
import { useResolvedTheme } from '../../hooks/useResolvedTheme';
import { isMac } from '../../utils/platformUtils';
import { DebugConsole } from './DebugConsole';

const IS_DEV = import.meta.env.DEV;
const STORAGE_KEY = 'debug_fab_pos';

// ── Shared singleton via window to bridge across module boundaries ────────────
type Listener = (open: boolean) => void;

function getDebugStore(): { isOpen: boolean; listeners: Set<Listener> } {
    const w = window as any;
    if (!w.__debugStore) {
        w.__debugStore = { isOpen: false, listeners: new Set<Listener>() };
    }
    return w.__debugStore;
}

function setGlobalOpen(val: boolean) {
    const store = getDebugStore();
    store.isOpen = val;
    store.listeners.forEach(fn => fn(val));
}

function useDebugOpen() {
    const [isOpen, setIsOpen] = useState(() => getDebugStore().isOpen);
    useEffect(() => {
        const store = getDebugStore();
        store.listeners.add(setIsOpen);
        return () => { store.listeners.delete(setIsOpen); };
    }, []);
    return [isOpen, (v: boolean) => setGlobalOpen(v)] as const;
}

// ── Shortcut label (platform-aware) ──────────────────────────────────────────
const SHORTCUT_LABEL = isMac ? '⌘ + ⇧ + D' : 'Ctrl + Shift + D';

interface DebugToggleFABProps {
    /** Pass total error count from log entries if you want the red dot */
    errorCount?: number;
}

export const DebugToggleFAB: React.FC<DebugToggleFABProps> = ({ errorCount = 0 }) => {
    const [isOpen, setOpen] = useDebugOpen();

    if (!IS_DEV) return null;

    const isLight = useResolvedTheme() === 'light';

    // ── Draggable position ────────────────────────────────────────────────────
    const getInitialPos = () => {
        try {
            const s = sessionStorage.getItem(STORAGE_KEY);
            if (s) return JSON.parse(s) as { x: number; y: number };
        } catch { /* ignore */ }
        return { x: window.innerWidth - 68, y: window.innerHeight - 80 };
    };

    const [pos, setPos] = useState(getInitialPos);
    const dragging = useRef(false);
    const dragOffset = useRef({ x: 0, y: 0 });
    const hasDragged = useRef(false);

    const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        dragging.current = true;
        hasDragged.current = false;
        dragOffset.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
    }, [pos]);

    const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
        if (!dragging.current) return;
        hasDragged.current = true;
        const FAB = 44;
        const nx = Math.max(0, Math.min(window.innerWidth - FAB, e.clientX - dragOffset.current.x));
        const ny = Math.max(0, Math.min(window.innerHeight - FAB, e.clientY - dragOffset.current.y));
        setPos({ x: nx, y: ny });
    }, []);

    const onPointerUp = useCallback(() => {
        dragging.current = false;
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
    }, [pos]);

    const onClick = useCallback(() => {
        if (!hasDragged.current) setOpen(!isOpen);
    }, [isOpen, setOpen]);

    return (
        <>
            {/* Floating Button */}
            <button
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onClick={onClick}
                aria-label={`${isOpen ? 'Close' : 'Open'} debug console`}
                style={{ left: pos.x, top: pos.y }}
                className={[
                    'fixed z-[9999] w-11 h-11 rounded-full',
                    'flex items-center justify-center',
                    'shadow-lg border select-none touch-none',
                    'cursor-grab active:cursor-grabbing',
                    'transition-all duration-150 group',
                    isOpen
                        ? 'bg-violet-600 border-violet-500 text-white'
                        : isLight
                            ? 'bg-white border-slate-200 text-slate-500 hover:border-violet-300 hover:text-violet-600 hover:shadow-md'
                            : 'bg-[#1a1d2e] border-white/10 text-white/40 hover:border-violet-500/40 hover:text-violet-400',
                ].join(' ')}
            >
                {isOpen ? <X size={16} /> : <Bug size={16} />}

                {/* Error dot */}
                {errorCount > 0 && !isOpen && (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-red-500 border-2 border-white shadow-sm" />
                )}

                {/* Tooltip with platform-aware shortcut */}
                <span className={[
                    'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-[90%]',
                    'opacity-0 group-hover:opacity-100 transition-opacity duration-150 delay-200',
                    'whitespace-nowrap text-[11px] font-medium px-2.5 py-1.5 rounded-lg shadow-xl',
                    'flex items-center gap-1.5',
                    isOpen || !isLight
                        ? 'bg-[#0a0e1a] text-white/80 border border-white/10'
                        : 'bg-slate-800 text-white',
                ].join(' ')}>
                    <Bug size={10} />
                    Debug Console
                    <kbd className="ml-1 text-[9px] font-mono opacity-60 bg-white/10 px-1 py-0.5 rounded">
                        {SHORTCUT_LABEL}
                    </kbd>
                </span>
            </button>

            {/* The console drawer — self-rendered here so this component is fully standalone */}
            <DebugConsole isOpen={isOpen} onClose={() => setOpen(false)} />
        </>
    );
};