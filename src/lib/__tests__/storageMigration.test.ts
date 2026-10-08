import { describe, expect, it } from 'vitest';
import { migrateLegacyStorageKeys } from '../storageMigration';

class MemoryStorage implements Storage {
    private m = new Map<string, string>();
    get length() { return this.m.size; }
    clear() { this.m.clear(); }
    getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
    key(i: number) { return [...this.m.keys()][i] ?? null; }
    removeItem(k: string) { this.m.delete(k); }
    setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

describe('migrateLegacyStorageKeys', () => {
    it('moves every natively_* key to godojo_* and removes the old one', () => {
        const s = new MemoryStorage();
        s.setItem('natively_resolved_theme', 'light');
        s.setItem('natively_performanceModePreference', 'on');
        s.setItem('natively_signup_phone_abc123', '+91 98765 43210');
        s.setItem('unrelated', 'x');
        expect(migrateLegacyStorageKeys(s)).toBe(3);
        expect(s.getItem('godojo_resolved_theme')).toBe('light');
        expect(s.getItem('godojo_performanceModePreference')).toBe('on');
        expect(s.getItem('godojo_signup_phone_abc123')).toBe('+91 98765 43210');
        expect(s.getItem('natively_resolved_theme')).toBeNull();
        expect(s.getItem('unrelated')).toBe('x');
    });

    it('a value already under the new key wins', () => {
        const s = new MemoryStorage();
        s.setItem('natively_undetectable', 'true');
        s.setItem('godojo_undetectable', 'false');
        migrateLegacyStorageKeys(s);
        expect(s.getItem('godojo_undetectable')).toBe('false');
        expect(s.getItem('natively_undetectable')).toBeNull();
    });

    it('routes the old overlay opacity key to its current name', () => {
        const s = new MemoryStorage();
        s.setItem('natively_overlay_opacity', '0.8');
        migrateLegacyStorageKeys(s);
        expect(s.getItem('gd_dock_opacity')).toBe('0.8');
        expect(s.getItem('godojo_overlay_opacity')).toBeNull();
    });

    it('is idempotent', () => {
        const s = new MemoryStorage();
        s.setItem('natively_user_name', 'Asha');
        migrateLegacyStorageKeys(s);
        expect(migrateLegacyStorageKeys(s)).toBe(0);
        expect(s.getItem('godojo_user_name')).toBe('Asha');
    });
});
