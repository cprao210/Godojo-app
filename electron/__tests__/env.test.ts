import { afterEach, describe, expect, it } from 'vitest';
import { readEnv } from '../utils/env';

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
