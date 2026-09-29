// src/lib/outsideClick.ts
//
// "Did this mousedown start outside the panel?" for click-outside-to-close overlays.
//
// Checking `panel.contains(event.target)` alone is wrong when the click itself removes its target:
// picking a suggestion (the chat's company list) unmounts the clicked button during React's
// handler, before the document listener runs — the detached button is no longer inside the panel,
// so the overlay closed and the app fell back to Home. The event path is fixed when dispatch
// starts, so it still contains the panel; a target that has left the page came from inside UI.

export interface OutsideClickInput {
    /** event.composedPath() — may be empty in environments without it. */
    path: ArrayLike<unknown>;
    /** The panel that should stay open. */
    panel: { contains(node: unknown): boolean } | null;
    /** event.target */
    target: { isConnected?: boolean } | null;
}

export function isOutsideClick({ path, panel, target }: OutsideClickInput): boolean {
    if (!panel || !target) return false;
    if (Array.prototype.includes.call(path, panel)) return false;
    if (panel.contains(target)) return false;
    // Removed by this very click (a picked suggestion) — it was on screen inside the panel.
    if (target.isConnected === false) return false;
    return true;
}
