// macOS TCC (Transparency, Consent and Control) permission helpers.
//
// System/interviewer audio on macOS is captured by the Rust native module via
// a CoreAudio Process Tap (macOS 14.4+) with a ScreenCaptureKit fallback. BOTH
// sit behind kTCCServiceScreenCapture — the "Screen Recording" toggle — so the
// app must resolve that permission before it constructs a SystemAudioCapture.
//
// This module is deliberately standalone (rather than living in main.ts) for
// two reasons:
//   1. ScreenshotHelper needs the identical dev-bypass policy. When the bypass
//      predicate was private to main.ts, screenshots and audio disagreed about
//      permission state in dev.
//   2. Everything here is pure enough to unit-test with a mocked `electron`
//      module. Reimplementing the logic inside the test (the previous approach
//      in the sibling repo) let the test and the real code drift apart.

import { app, desktopCapturer, systemPreferences } from 'electron';

export type MacScreenCaptureStatus = 'granted' | 'denied' | 'not-determined' | 'restricted';

export type MacScreenCaptureCapability = {
  status: MacScreenCaptureStatus;
  /** Whether system audio can actually be captured right now. */
  capturable: boolean;
  /** `true` only when we are confident capture will fail — the banner trigger. */
  effectiveDenied: boolean;
  /** Number of `screen:` sources the probe returned (0 when no probe ran). */
  sourceCount: number;
  message?: string;
  error?: string;
};

/**
 * How long the `desktopCapturer` probe may run before we treat a 'denied'
 * status as authoritative. getSources() can block indefinitely while a TCC
 * dialog is open, which would otherwise hang the main process.
 */
export const SCREEN_CAPTURE_PROBE_TIMEOUT_MS = 5000;

/**
 * How long a capture may produce nothing (no chunks at all) before we warn.
 *
 * The ScreenCaptureKit fallback path takes 5-7s to deliver its first buffer on
 * a warm system and ~8-10s on a contended one, so anything much below this
 * produces false positives during a legitimate cold start.
 */
export const STUCK_WATCHDOG_MS = 12000;

/**
 * How long a capture may produce nothing but silent samples before we conclude
 * the Screen Recording grant does not apply to this binary. Kept equal to
 * STUCK_WATCHDOG_MS so the two detectors describe the same observation window
 * in their copy; they are distinguished by *why* they fired, not by timing.
 */
export const ZEROFILL_OBSERVATION_MS = 12000;

/**
 * Peak-to-peak amplitude below which a chunk counts as silent.
 *
 * Peak-to-peak (max - min) rather than absolute peak, because a muted-but-
 * biased input with a sustained DC offset reads as a large absolute peak while
 * carrying no signal — that false-latched the detector permanently, so the user
 * got no banner even when audio was genuinely dead. Ranges by source: pure DC
 * 0; quantisation noise ~2-4; thermal mic noise ~20-100; quiet speech >500.
 *
 * IMPORTANT: crossing this threshold downward does NOT imply a permission
 * problem. The native module synthesises bit-exact zero keepalives during
 * render-idle (FrameAction::SendSilence in native-module/src/lib.rs), which are
 * byte-identical to TCC zero-fill. A quiet meeting and a revoked grant look the
 * same at this layer, so anything that blames permissions on silence MUST
 * confirm with confirmScreenCaptureWorks() first.
 */
export const SILENCE_PEAK_TO_PEAK_THRESHOLD = 100;

/**
 * Whether the dev-mode TCC bypass is enabled.
 *
 * Opt-in rather than automatic: an unconditional dev bypass reports screen
 * capture as 'granted' on every `npm run app:dev` launch regardless of real TCC
 * state, which makes the dominant production failure mode ("permissions look
 * granted but nothing transcribes") invisible while developing. Set
 * NATIVELY_DEV_BYPASS_SCREEN_TCC=1 for a frictionless local loop.
 */
export function isDevTccBypassEnabled(): boolean {
  return !app.isPackaged && process.env.NATIVELY_DEV_BYPASS_SCREEN_TCC === '1';
}

export function getMacScreenCaptureStatus(): MacScreenCaptureStatus {
  if (process.platform !== 'darwin') return 'granted';

  if (isDevTccBypassEnabled()) {
    console.log('[Permissions] Dev TCC bypass enabled (NATIVELY_DEV_BYPASS_SCREEN_TCC=1) — reporting screen capture as granted');
    return 'granted';
  }

  try {
    return systemPreferences.getMediaAccessStatus('screen') as MacScreenCaptureStatus;
  } catch (error) {
    console.error('[Permissions] Failed to read screen recording permission:', error);
    return 'not-determined';
  }
}

export function getMacMicrophoneStatus(): MacScreenCaptureStatus {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('microphone') as MacScreenCaptureStatus;
  } catch (error) {
    console.error('[Permissions] Failed to read microphone permission:', error);
    return 'not-determined';
  }
}

/**
 * Wraps a promise with a timeout, rejecting with a message containing `tag`.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[withTimeout] ${tag} timed out after ${ms}ms`));
    }, ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Resolve whether system audio can be captured, and latch a user-facing
 * message when it cannot.
 *
 * Note that a 'denied' status is NOT taken at face value. `getMediaAccessStatus`
 * reports per-service TCC state, but a still-valid capture session can outlive a
 * status change, and on some macOS versions the status lags the real grant. So
 * on 'denied' we actually attempt a 1x1 screen probe: if real screen sources
 * come back, capture works and we suppress the banner rather than nagging a user
 * whose audio is fine.
 *
 * `context` is a short human string ('meeting start', 'power resume', …) that
 * appears in logs and in the probe-timeout tag, so a failure can be traced to
 * the call site that triggered it.
 */
export async function resolveMacScreenCaptureCapability(
  context: string,
  hooks?: {
    onWarning?: (message: string) => void;
    onClear?: () => void;
  },
): Promise<MacScreenCaptureCapability> {
  const remember = (message: string) => hooks?.onWarning?.(message);
  const clear = () => hooks?.onClear?.();

  const status = getMacScreenCaptureStatus();
  const isMac = process.platform === 'darwin';

  // Mirror getMacScreenCaptureStatus's bypass policy so dev runs exercise the
  // real resolution path unless explicitly opted out.
  if (!isMac || isDevTccBypassEnabled()) {
    clear();
    return { status, capturable: true, effectiveDenied: false, sourceCount: 0 };
  }

  if (status === 'restricted') {
    const message = formatPermissionMessage('mac-screen-recording-restricted');
    remember(message);
    return { status, capturable: false, effectiveDenied: true, sourceCount: 0, message };
  }

  // 'granted' needs nothing; 'not-determined' means macOS will raise the sheet
  // when the native module touches SCK/CoreAudio, so let it proceed.
  if (status !== 'denied') {
    clear();
    return { status, capturable: true, effectiveDenied: false, sourceCount: 0 };
  }

  try {
    const sources = await withTimeout(
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }),
      SCREEN_CAPTURE_PROBE_TIMEOUT_MS,
      `screen-capture-probe-timeout-${context}`,
    );
    const sourceCount = sources.filter((source) => source.id.startsWith('screen:')).length;
    const capturable = sourceCount > 0;

    if (capturable) {
      clear();
      console.warn(`[Permissions] Screen Recording reads as denied during ${context}, but the capture probe succeeded; continuing without a banner.`);
    } else {
      remember(formatPermissionMessage('screen-recording-denied'));
    }

    return { status, capturable, effectiveDenied: !capturable, sourceCount };
  } catch (error: any) {
    const message = formatPermissionMessage('screen-recording-denied');

    if (error?.message?.includes('screen-capture-probe-timeout')) {
      remember(`${message} (permission probe timed out)`);
      console.warn(`[Permissions] Screen Recording probe timed out during ${context} — treating as denied.`);
      return { status, capturable: false, effectiveDenied: true, sourceCount: 0, message, error: error.message };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    remember(message);
    console.warn(`[Permissions] Screen Recording probe failed during ${context}: ${errorMessage}`);
    return { status, capturable: false, effectiveDenied: true, sourceCount: 0, message, error: errorMessage };
  }
}

/**
 * Actively confirm that screen capture works RIGHT NOW, ignoring the reported
 * TCC status.
 *
 * Needed because the status is unreliable in precisely the case that matters
 * most. When a grant was made against a previous build's code signature, macOS
 * keeps reporting 'granted' while silently zero-filling captured audio — so
 * `getMediaAccessStatus` cannot detect the very failure the zero-fill detector
 * exists to catch. Attempting a real capture is the only thing that separates
 * "the permission is broken" from "nothing is playing right now".
 *
 * Returns true when capture demonstrably works, and true on non-darwin (nothing
 * gates it there). A timeout counts as failure.
 */
export async function confirmScreenCaptureWorks(context: string): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  if (isDevTccBypassEnabled()) return true;

  try {
    const sources = await withTimeout(
      desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }),
      SCREEN_CAPTURE_PROBE_TIMEOUT_MS,
      `screen-capture-confirm-timeout-${context}`,
    );
    return sources.some((source) => source.id.startsWith('screen:'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[Permissions] Screen capture confirmation failed during ${context}: ${message}`);
    return false;
  }
}

// Variants prefixed `mac-` are macOS-only and name TCC / CoreAudio /
// ScreenCaptureKit concepts that have no Windows equivalent. Call sites for
// those must themselves be darwin-gated — the prefix makes that visible in
// review. Cross-platform variants carry no prefix and branch internally.
export type PermissionReason =
  | 'screen-recording-denied'
  | 'mac-screen-recording-restricted'
  | 'mac-screen-recording-revoked-rebuild'
  | 'mic-denied'
  | 'mic-zero-fill'
  | 'mac-same-device-input-output'
  | 'system-audio-stuck';

/**
 * User-facing copy for an audio/permission failure, phrased for the current
 * platform. Windows has no screen-capture gate (WASAPI loopback is ungated) and
 * reaches its microphone settings by a different route, so macOS copy must not
 * leak onto it.
 */
export function formatPermissionMessage(reason: PermissionReason, extra?: { device?: string }): string {
  const isMac = process.platform === 'darwin';
  switch (reason) {
    case 'screen-recording-denied':
      return isMac
        ? 'Screen Recording permission denied. Interviewer audio will not be captured. Enable it in System Settings → Privacy & Security → Screen Recording, then restart GoDojo AI.'
        : 'System audio capture is unavailable. Interviewer audio will not be captured. Check your audio device routing in Settings and restart the meeting.';

    case 'mac-screen-recording-restricted':
      if (!isMac) return formatPermissionMessage('system-audio-stuck');
      return 'Screen Recording is restricted by device policy. Interviewer audio will not be captured. Contact your administrator to allow screen capture for GoDojo AI.';

    case 'mac-screen-recording-revoked-rebuild':
      // Defence in depth: all call sites are darwin-gated (see the `mac-`
      // prefix), but degrade gracefully rather than leak macOS copy if a future
      // caller forgets.
      if (!isMac) return formatPermissionMessage('system-audio-stuck');
      return 'System audio is being captured but every sample is silent. This usually means macOS Screen Recording permission needs to be re-granted to this build of GoDojo AI. Open System Settings → Privacy & Security → Screen Recording, toggle GoDojo AI off and back on, then restart the app. (If you recently updated or rebuilt, the previous grant may no longer apply.)';

    case 'mic-denied':
      return isMac
        ? 'Microphone access denied. Allow microphone access in System Settings → Privacy & Security → Microphone, then restart GoDojo AI.'
        : 'Microphone access denied. Allow microphone access in Settings → Privacy → Microphone, then restart GoDojo AI.';

    case 'mic-zero-fill':
      return isMac
        ? 'Your microphone is producing silent audio. Check that the device is unmuted and that macOS Microphone permission is granted to GoDojo AI in System Settings → Privacy & Security → Microphone.'
        : 'Your microphone is producing silent audio. Check that the device is unmuted and that GoDojo AI has microphone access in Settings → Privacy → Microphone.';

    case 'mac-same-device-input-output':
      if (!isMac) return formatPermissionMessage('system-audio-stuck');
      return `Silent capture detected — input and output are the same device (${extra?.device ?? 'unknown'}). macOS cannot tap a device while it is also the active microphone. Switch your input to the built-in mic, or your output to the built-in speakers.`;

    case 'system-audio-stuck':
      // Derived from the constant rather than hardcoded — the sibling repo's
      // copy still said "8s" long after the watchdog moved to 12s.
      return `No audio detected on system output for ${Math.round(STUCK_WATCHDOG_MS / 1000)}s. If your meeting app is using a different output device (Bluetooth headset, virtual cable, second monitor), switch it to your default output, or restart the meeting after switching.`;
  }
}

/**
 * Peak-to-peak amplitude of an interleaved 16-bit PCM buffer, sampled with a
 * stride so the scan stays cheap on the audio path (~960 samples per 20ms
 * chunk). The stride is forced even so reads stay 16-bit aligned.
 */
export function peakToPeak(chunk: Buffer): number {
  let minSample = 32767;
  let maxSample = -32768;
  const stride = Math.max(2, (chunk.length >> 5) & ~1);
  for (let i = 0; i + 1 < chunk.length; i += stride) {
    const sample = chunk.readInt16LE(i);
    if (sample < minSample) minSample = sample;
    if (sample > maxSample) maxSample = sample;
  }
  if (maxSample < minSample) return 0; // empty buffer
  return maxSample - minSample;
}

/** macOS System Settings deep links for the panes this app cares about. */
export const MAC_SETTINGS_PANES = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
} as const;

export type MacSettingsPane = keyof typeof MAC_SETTINGS_PANES;
