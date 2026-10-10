import { beforeEach, describe, expect, it, vi } from 'vitest';

const capture = vi.fn();
const ctor = vi.fn();
vi.mock('posthog-node', () => ({
    PostHog: class {
        constructor(...args: unknown[]) { ctor(...args); }
        capture = capture;
        captureException = vi.fn();
        shutdown = vi.fn(async () => { });
    },
}));
vi.mock('../services/AuthManager', () => ({ AuthManager: { getInstance: () => ({ getUid: () => 'uid-1' }) } }));
vi.mock('../services/TenantContext', () => ({ tenantContext: { get: (): string | null => null } }));

describe('PostHogMainService', () => {
    beforeEach(() => {
        vi.resetModules();
        capture.mockClear();
        ctor.mockClear();
        delete process.env.VITE_POSTHOG_KEY;
        delete process.env.VITE_POSTHOG_HOST;
    });

    it('picks up a key that is loaded AFTER the module is imported (dotenv runs after imports)', async () => {
        const { posthogMain } = await import('../services/PostHogMainService'); // env still empty here
        process.env.VITE_POSTHOG_KEY = 'phc_test';                               // dotenv.config() happens now
        posthogMain.init();
        posthogMain.capture('llm_generation_usage', { total_tokens: 10 });

        expect(ctor).toHaveBeenCalledWith('phc_test', expect.objectContaining({ host: 'https://us.i.posthog.com' }));
        expect(capture).toHaveBeenCalledWith(expect.objectContaining({
            event: 'llm_generation_usage',
            distinctId: 'uid-1',
            properties: expect.objectContaining({ total_tokens: 10, process: 'main' }),
        }));
    });

    it('self-heals when an event is captured before init() was ever called', async () => {
        const { posthogMain } = await import('../services/PostHogMainService');
        process.env.VITE_POSTHOG_KEY = 'phc_late';
        posthogMain.capture('early_event');
        expect(capture).toHaveBeenCalledTimes(1);
    });

    it('warns once, not per event, when there is no key', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => { });
        const { posthogMain } = await import('../services/PostHogMainService');
        posthogMain.capture('a');
        posthogMain.capture('b');
        posthogMain.capture('c');
        expect(capture).not.toHaveBeenCalled();
        expect(warn.mock.calls.filter((c) => String(c[0]).includes('events are being dropped'))).toHaveLength(1);
        warn.mockRestore();
    });
});