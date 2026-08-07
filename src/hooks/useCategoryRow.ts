// State layer for CategoryRow: the meatball (⋮) menu's open/close state and
// its outside-click-to-close behavior.

import { useEffect, useRef, useState } from "react";

export function useCategoryRow() {
    const [menuOpen, setMenuOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        if (menuOpen) document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, [menuOpen]);

    const toggleMenu = () => setMenuOpen((v) => !v);
    const closeMenu = () => setMenuOpen(false);

    return { menuOpen, menuRef, toggleMenu, closeMenu };
}