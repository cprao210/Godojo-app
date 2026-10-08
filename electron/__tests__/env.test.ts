import { afterEach, describe, expect, it } from 'vitest';
import { mirrorGodojoEnvForNativeModule, readEnv } from '../utils/env';

describe('readEnv', () => {
    afterEach(() => {
        delete process.env.GODOJO_TEST_FLAG;
        delete process.env.NATIVELY_TEST_FLAG;
    });

    it('reads the GODOJO_ name', () => {
        process.env.GODOJO_TEST_FLAG = '1';
        expect(readEnv('TEST_FLAG')).toBe('1');
    });

    it('still accepts the legacy NATIVELY_ name', () => {
        process.env.NATIVELY_TEST_FLAG = 'legacy';
        expect(readEnv('TEST_FLAG')).toBe('legacy');
    });

    it('GODOJO_ wins when both are set', () => {
        process.env.GODOJO_TEST_FLAG = 'new';
        process.env.NATIVELY_TEST_FLAG = 'old';
        expect(readEnv('TEST_FLAG')).toBe('new');
    });
});

describe('mirrorGodojoEnvForNativeModule', () => {
    it('copies GODOJO_* onto NATIVELY_* for the Rust module', () => {
        const env: NodeJS.ProcessEnv = { GODOJO_ECHO_MODE: 'half_duplex', GODOJO_VERBOSE: '1', PATH: 'x' };
        mirrorGodojoEnvForNativeModule(env);
        expect(env.NATIVELY_ECHO_MODE).toBe('half_duplex');
        expect(env.NATIVELY_VERBOSE).toBe('1');
        expect(env.NATIVELY_PATH).toBeUndefined();
    });

    it('never overrides an explicitly set NATIVELY_* value', () => {
        const env: NodeJS.ProcessEnv = { GODOJO_ECHO_MODE: 'half_duplex', NATIVELY_ECHO_MODE: 'full_duplex' };
        mirrorGodojoEnvForNativeModule(env);
        expect(env.NATIVELY_ECHO_MODE).toBe('full_duplex');
    });
});
