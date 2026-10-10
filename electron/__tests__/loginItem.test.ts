import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const setLoginItemSettings = vi.fn();
let exePath = 'C:\\Users\\u\\AppData\\Local\\Programs\\GoDojo AI\\GoDojo AI.exe';
vi.mock('electron', () => ({
    app: {
        getPath: (k: string) => (k === 'exe' ? exePath : ''),
        setLoginItemSettings: (...a: any[]) => setLoginItemSettings(...a),
        getLoginItemSettings: () => ({ openAtLogin: false }),
    },
}));

async function load(platform: NodeJS.Platform) {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: platform });
    return await import('../utils/loginItem');
}

describe('loginItem', () => {
    const realPlatform = process.platform;
    beforeEach(() => {
        setLoginItemSettings.mockClear();
        exePath = 'C:\\Users\\u\\AppData\\Local\\Programs\\GoDojo AI\\GoDojo AI.exe';
    });
    afterAll(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

    it('uses the registry name existing installs registered (electron.app.<exe name>)', async () => {
        const { __test } = await load('win32');
        expect(__test.LOGIN_ITEM_NAME).toBe('electron.app.GoDojo AI');
    });

    it('toggle OFF removes the canonical entry by explicit name, plus legacy disguise entries', async () => {
        const { applyOpenAtLogin } = await load('win32');
        applyOpenAtLogin(false);
        const calls = setLoginItemSettings.mock.calls.map(([o]) => o);
        expect(calls[0]).toMatchObject({ openAtLogin: false, name: 'electron.app.GoDojo AI' });
        const legacy = calls.slice(1);
        expect(legacy.map((o) => o.name)).toEqual([
            // Current disguise AUMIDs…
            'com.godojo.assistant.terminal',
            'com.godojo.assistant.settings',
            'com.godojo.assistant.activity',
            'com.godojo.assistant.none',
            // …and the pre-rebrand ones, still cleaned up for older installs.
            'com.natively.assistant.terminal',
            'com.natively.assistant.settings',
            'com.natively.assistant.activity',
            'com.natively.assistant.none',
        ]);
        expect(legacy.every((o) => o.openAtLogin === false)).toBe(true);
    });

    it('toggle ON registers under the canonical name and still clears legacy entries', async () => {
        const { applyOpenAtLogin } = await load('win32');
        applyOpenAtLogin(true);
        const [first, ...rest] = setLoginItemSettings.mock.calls.map(([o]) => o);
        expect(first).toMatchObject({ openAtLogin: true, name: 'electron.app.GoDojo AI', path: exePath });
        expect(rest.every((o) => o.openAtLogin === false)).toBe(true);
    });

    it('macOS: no registry name, no legacy cleanup', async () => {
        exePath = '/Applications/GoDojo AI.app/Contents/MacOS/GoDojo AI';
        const { applyOpenAtLogin } = await load('darwin');
        applyOpenAtLogin(true);
        expect(setLoginItemSettings).toHaveBeenCalledTimes(1);
        expect(setLoginItemSettings.mock.calls[0][0].name).toBeUndefined();
    });

    it('never throws if the OS call fails', async () => {
        const { applyOpenAtLogin } = await load('win32');
        setLoginItemSettings.mockImplementationOnce(() => { throw new Error('denied'); });
        vi.spyOn(console, 'warn').mockImplementation(() => { });
        expect(() => applyOpenAtLogin(false)).not.toThrow();
    });
});
