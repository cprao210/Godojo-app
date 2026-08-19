import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable state the mocked electron surface reads. Declared before vi.mock so the
// factory closes over it (vi.mock is hoisted above imports).
const state = {
  isPackaged: true,
  screenStatus: 'granted' as string,
  micStatus: 'granted' as string,
  /** Source ids the probe returns. */
  screenSources: ['screen:0:0'] as string[],
  /** When set, the probe rejects with this instead of resolving. */
  probeError: null as Error | null,
  /** When true, the probe never settles — exercises the timeout branch. */
  probeHangs: false,
  getMediaAccessStatusCalls: [] as string[],
  getSourcesCalls: 0,
};

vi.mock('electron', () => ({
  get app() {
    return { get isPackaged() { return state.isPackaged; } };
  },
  systemPreferences: {
    getMediaAccessStatus(type: string) {
      state.getMediaAccessStatusCalls.push(type);
      return type === 'microphone' ? state.micStatus : state.screenStatus;
    },
  },
  desktopCapturer: {
    getSources() {
      state.getSourcesCalls++;
      if (state.probeHangs) return new Promise(() => { /* never settles */ });
      if (state.probeError) return Promise.reject(state.probeError);
      return Promise.resolve(state.screenSources.map((id) => ({ id })));
    },
  },
}));

// Imported after the mock so the module under test binds to it. These are the
// REAL implementations — deliberately not reimplemented in the test, because a
// hand-copied detector silently drifts from the shipped one.
import {
  formatPermissionMessage,
  getMacMicrophoneStatus,
  getMacScreenCaptureStatus,
  isDevTccBypassEnabled,
  peakToPeak,
  resolveMacScreenCaptureCapability,
  SILENCE_PEAK_TO_PEAK_THRESHOLD,
  STUCK_WATCHDOG_MS,
} from '../utils/macPermissions';

const realPlatform = process.platform;
function setPlatform(platform: string) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  state.isPackaged = true;
  state.screenStatus = 'granted';
  state.micStatus = 'granted';
  state.screenSources = ['screen:0:0'];
  state.probeError = null;
  state.probeHangs = false;
  state.getMediaAccessStatusCalls = [];
  state.getSourcesCalls = 0;
  delete process.env.NATIVELY_DEV_BYPASS_SCREEN_TCC;
  setPlatform('darwin');
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.useRealTimers();
});

describe('getMacScreenCaptureStatus', () => {
  it('passes through each TCC status on darwin', () => {
    for (const status of ['granted', 'denied', 'not-determined', 'restricted']) {
      state.screenStatus = status;
      expect(getMacScreenCaptureStatus()).toBe(status);
    }
  });

  it('reports granted off darwin without consulting TCC', () => {
    setPlatform('win32');
    state.screenStatus = 'denied';
    expect(getMacScreenCaptureStatus()).toBe('granted');
    expect(state.getMediaAccessStatusCalls).toHaveLength(0);
  });

  it('degrades to not-determined when the TCC lookup throws', () => {
    setPlatform('darwin');
    state.screenStatus = 'denied';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Simulate a throwing systemPreferences by making the getter blow up.
    const original = state.getMediaAccessStatusCalls;
    Object.defineProperty(state, 'getMediaAccessStatusCalls', {
      get() { throw new Error('TCC unavailable'); },
      configurable: true,
    });
    expect(getMacScreenCaptureStatus()).toBe('not-determined');
    Object.defineProperty(state, 'getMediaAccessStatusCalls', { value: original, writable: true, configurable: true });
    spy.mockRestore();
  });

  it('reads the microphone service independently of screen capture', () => {
    state.micStatus = 'denied';
    state.screenStatus = 'granted';
    expect(getMacMicrophoneStatus()).toBe('denied');
    expect(getMacScreenCaptureStatus()).toBe('granted');
  });
});

describe('isDevTccBypassEnabled', () => {
  it('stays off in a packaged build even with the env var set', () => {
    state.isPackaged = true;
    process.env.NATIVELY_DEV_BYPASS_SCREEN_TCC = '1';
    expect(isDevTccBypassEnabled()).toBe(false);
  });

  it('stays off in dev unless explicitly opted in — the real TCC state must show', () => {
    state.isPackaged = false;
    expect(isDevTccBypassEnabled()).toBe(false);
  });

  it('turns on only for unpackaged builds with the env var set', () => {
    state.isPackaged = false;
    process.env.NATIVELY_DEV_BYPASS_SCREEN_TCC = '1';
    expect(isDevTccBypassEnabled()).toBe(true);
  });

  it('makes a denied status read as granted when enabled', () => {
    state.isPackaged = false;
    process.env.NATIVELY_DEV_BYPASS_SCREEN_TCC = '1';
    state.screenStatus = 'denied';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(getMacScreenCaptureStatus()).toBe('granted');
  });
});

describe('resolveMacScreenCaptureCapability', () => {
  it('allows capture when granted, without probing', async () => {
    const result = await resolveMacScreenCaptureCapability('test');
    expect(result).toMatchObject({ status: 'granted', capturable: true, effectiveDenied: false });
    expect(state.getSourcesCalls).toBe(0);
  });

  it('allows capture when not-determined — macOS will raise the sheet itself', async () => {
    state.screenStatus = 'not-determined';
    const result = await resolveMacScreenCaptureCapability('test');
    expect(result.capturable).toBe(true);
    expect(result.effectiveDenied).toBe(false);
    expect(state.getSourcesCalls).toBe(0);
  });

  it('blocks with policy wording when restricted, without probing', async () => {
    state.screenStatus = 'restricted';
    const result = await resolveMacScreenCaptureCapability('test');
    expect(result.effectiveDenied).toBe(true);
    expect(result.capturable).toBe(false);
    expect(result.message).toContain('restricted by device policy');
    expect(state.getSourcesCalls).toBe(0);
  });

  // The important non-obvious case: a 'denied' status is not trusted on its own.
  it('overrides a denied status when the probe still returns screen sources', async () => {
    state.screenStatus = 'denied';
    state.screenSources = ['screen:0:0', 'screen:1:0'];
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await resolveMacScreenCaptureCapability('test');
    expect(result.status).toBe('denied');
    expect(result.capturable).toBe(true);
    expect(result.effectiveDenied).toBe(false);
    expect(result.sourceCount).toBe(2);
  });

  it('counts only screen: sources, ignoring windows', async () => {
    state.screenStatus = 'denied';
    state.screenSources = ['window:123:0', 'window:456:0'];
    const result = await resolveMacScreenCaptureCapability('test');
    expect(result.sourceCount).toBe(0);
    expect(result.effectiveDenied).toBe(true);
  });

  it('confirms denial when the probe returns nothing', async () => {
    state.screenStatus = 'denied';
    state.screenSources = [];
    const result = await resolveMacScreenCaptureCapability('test');
    expect(result.effectiveDenied).toBe(true);
    expect(result.capturable).toBe(false);
  });

  it('confirms denial when the probe throws, keeping the error for logs', async () => {
    state.screenStatus = 'denied';
    state.probeError = new Error('NotAllowedError');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await resolveMacScreenCaptureCapability('test');
    expect(result.effectiveDenied).toBe(true);
    expect(result.error).toContain('NotAllowedError');
  });

  // Without the timeout, getSources blocking on an open TCC dialog would hang
  // the main process — this is the branch that keeps the app responsive.
  it('treats a hanging probe as denied once the timeout elapses', async () => {
    vi.useFakeTimers();
    state.screenStatus = 'denied';
    state.probeHangs = true;
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = resolveMacScreenCaptureCapability('hang-test');
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(result.effectiveDenied).toBe(true);
    expect(result.error).toContain('screen-capture-probe-timeout-hang-test');
    expect(result.message).toContain('Screen Recording permission denied');
  });

  it('short-circuits to capturable off darwin', async () => {
    setPlatform('win32');
    state.screenStatus = 'denied';
    const result = await resolveMacScreenCaptureCapability('test');
    expect(result.capturable).toBe(true);
    expect(result.effectiveDenied).toBe(false);
    expect(state.getSourcesCalls).toBe(0);
  });

  it('latches a warning on denial and clears it once resolved', async () => {
    const seen: Array<string | null> = [];
    const hooks = {
      onWarning: (m: string) => seen.push(m),
      onClear: () => seen.push(null),
    };

    state.screenStatus = 'denied';
    state.screenSources = [];
    await resolveMacScreenCaptureCapability('test', hooks);
    expect(typeof seen[0]).toBe('string');

    state.screenStatus = 'granted';
    await resolveMacScreenCaptureCapability('test', hooks);
    expect(seen[1]).toBeNull();
  });
});

describe('formatPermissionMessage', () => {
  it('gives macOS-specific guidance on darwin', () => {
    const msg = formatPermissionMessage('screen-recording-denied');
    expect(msg).toContain('System Settings');
    expect(msg).toContain('Screen Recording');
  });

  // Leaking macOS copy to Windows is a real regression class: Windows has no
  // screen-capture gate at all, so the instructions would be unfollowable.
  it('never mentions Screen Recording or TCC panes off darwin', () => {
    setPlatform('win32');
    const reasons = [
      'screen-recording-denied',
      'mac-screen-recording-restricted',
      'mac-screen-recording-revoked-rebuild',
      'mic-denied',
      'mic-zero-fill',
      'mac-same-device-input-output',
      'system-audio-stuck',
    ] as const;
    for (const reason of reasons) {
      const msg = formatPermissionMessage(reason);
      expect(msg, `reason=${reason}`).not.toContain('Screen Recording');
      expect(msg, `reason=${reason}`).not.toContain('Privacy & Security');
    }
  });

  it('interpolates the device name for the same-device case', () => {
    const msg = formatPermissionMessage('mac-same-device-input-output', { device: 'AirPods Pro' });
    expect(msg).toContain('AirPods Pro');
  });

  // The sibling implementation hardcoded "8s" here and kept saying it long after
  // the watchdog moved to 12s. Deriving the number keeps copy and behaviour tied.
  it('quotes the actual watchdog timeout in the stuck message', () => {
    const msg = formatPermissionMessage('system-audio-stuck');
    expect(msg).toContain(`${Math.round(STUCK_WATCHDOG_MS / 1000)}s`);
  });
});

describe('peakToPeak', () => {
  const pcm = (samples: number[]): Buffer => {
    const buf = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
    return buf;
  };
  // 640 samples ≈ one 20ms chunk at 16kHz, enough that the stride skips samples.
  const filled = (value: (i: number) => number) => pcm(Array.from({ length: 640 }, (_, i) => value(i)));

  it('reports zero for digital silence', () => {
    expect(peakToPeak(filled(() => 0))).toBe(0);
  });

  it('reports zero for a constant DC offset', () => {
    // The whole reason for peak-to-peak over absolute peak: a muted-but-biased
    // input reads as a large absolute peak while carrying no signal, which
    // permanently latched the old detector off and suppressed the banner.
    expect(peakToPeak(filled(() => 3000))).toBe(0);
  });

  it('stays under the silence threshold for quantisation-level noise', () => {
    expect(peakToPeak(filled((i) => (i % 2 === 0 ? 1 : -1)))).toBeLessThan(SILENCE_PEAK_TO_PEAK_THRESHOLD);
  });

  it('exceeds the silence threshold for real signal', () => {
    // A tone whose period (~50 samples) does not divide the sampling stride, i.e.
    // what actual speech looks like at this granularity.
    expect(peakToPeak(filled((i) => Math.round(6000 * Math.sin(i / 8))))).toBeGreaterThan(SILENCE_PEAK_TO_PEAK_THRESHOLD);
  });

  it('detects signal riding on a DC offset', () => {
    expect(peakToPeak(filled((i) => 3000 + Math.round(4000 * Math.sin(i / 8))))).toBeGreaterThan(SILENCE_PEAK_TO_PEAK_THRESHOLD);
  });

  // Documents a real limitation of scanning with a stride rather than every
  // sample: a waveform whose period divides the stride is sampled at a single
  // phase and reads as constant. Harmless in practice — the detector needs 12
  // continuous seconds of silent chunks before it reports anything, and no real
  // signal stays phase-locked to the stride across hundreds of chunks — but it is
  // deliberate behaviour, not an accident, so it is pinned here.
  it('aliases a waveform whose period divides the sampling stride', () => {
    expect(peakToPeak(filled((i) => (i % 2 === 0 ? 6000 : -6000)))).toBe(0);
  });

  it('returns zero for an empty buffer rather than a negative range', () => {
    expect(peakToPeak(Buffer.alloc(0))).toBe(0);
  });
});
