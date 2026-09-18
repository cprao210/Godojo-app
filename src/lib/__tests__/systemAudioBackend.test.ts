// The toggle and the meeting-start path used to disagree about the default:
// nothing saved read as "SCK on" in Settings and "SCK off" at meeting start, so
// a fresh install ran the (broken) CoreAudio tap while showing SCK enabled.

import { describe, expect, it } from 'vitest';

import {
    resolveSckPreference,
    resolveSystemAudioBackend,
    SCK_OUTPUT_ID,
} from '@/lib/systemAudioBackend';

describe('resolveSckPreference', () => {
    it('defaults to SCK on macOS when nothing was saved (fresh install)', () => {
        expect(resolveSckPreference(null, true)).toBe(true);
    });

    it('respects an explicit opt-out', () => {
        expect(resolveSckPreference('false', true)).toBe(false);
    });

    it('respects an explicit opt-in', () => {
        expect(resolveSckPreference('true', true)).toBe(true);
    });

    it('never selects SCK off macOS, whatever was saved', () => {
        expect(resolveSckPreference(null, false)).toBe(false);
        expect(resolveSckPreference('true', false)).toBe(false);
    });
});

describe('resolveSystemAudioBackend', () => {
    it('sends the sck sentinel and ignores the chosen speaker when SCK is on', () => {
        expect(resolveSystemAudioBackend({
            savedPreference: null,
            isMac: true,
            preferredOutputDeviceId: 'BuiltInSpeakerDevice',
        })).toEqual({ useSck: true, outputDeviceId: SCK_OUTPUT_ID });
    });

    it('passes the chosen speaker through to the tap when SCK is off', () => {
        expect(resolveSystemAudioBackend({
            savedPreference: 'false',
            isMac: true,
            preferredOutputDeviceId: 'BuiltInSpeakerDevice',
        })).toEqual({ useSck: false, outputDeviceId: 'BuiltInSpeakerDevice' });
    });

    it('falls back to the default output (null) when SCK is off and no speaker was chosen', () => {
        expect(resolveSystemAudioBackend({ savedPreference: 'false', isMac: true }))
            .toEqual({ useSck: false, outputDeviceId: null });
    });

    it('uses the platform backend with the chosen device off macOS', () => {
        expect(resolveSystemAudioBackend({
            savedPreference: null,
            isMac: false,
            preferredOutputDeviceId: 'wasapi-1',
        })).toEqual({ useSck: false, outputDeviceId: 'wasapi-1' });
    });
});
