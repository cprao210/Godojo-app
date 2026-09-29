import { describe, it, expect } from 'vitest';
import { isOutsideClick } from '../outsideClick';

const inside = { isConnected: true };
const elsewhere = { isConnected: true };
const panel = { contains: (n: unknown) => n === inside };

describe('isOutsideClick', () => {
    it('a click on the page outside the panel closes it', () => {
        expect(isOutsideClick({ path: [elsewhere], panel, target: elsewhere })).toBe(true);
    });

    it('a click inside the panel does not', () => {
        expect(isOutsideClick({ path: [inside, panel], panel, target: inside })).toBe(false);
    });

    it('picking a suggestion that unmounts itself does not close the chat', () => {
        // The picked company button is removed during the click: no longer in the panel, not
        // connected — but the event path (fixed at dispatch) still holds the panel.
        const picked = { isConnected: false };
        expect(isOutsideClick({ path: [picked, panel], panel, target: picked })).toBe(false);
        // Even without composedPath support, a detached target came from inside UI.
        expect(isOutsideClick({ path: [], panel, target: picked })).toBe(false);
    });

    it('nothing to compare against → never closes', () => {
        expect(isOutsideClick({ path: [], panel: null, target: elsewhere })).toBe(false);
    });
});
