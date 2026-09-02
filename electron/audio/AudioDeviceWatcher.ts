import { EventEmitter } from 'events';
import { loadNativeModule } from './nativeModuleLoader';

const NativeModule: any = loadNativeModule();

// Neither Electron's main process nor the Rust layer currently registers an OS
// device-notification callback (IMMNotificationClient on Windows,
// AudioObjectAddPropertyListener on macOS), so nothing anywhere in the app
// noticed a headset being plugged in mid-meeting. Polling the existing native
// enumeration APIs gets the same signal without new platform code in three
// backends, and 1.5s is far below the human tolerance for a dead channel.
const POLL_INTERVAL_MS = 1500;
// A single plug/unplug produces a burst of transitional states (endpoint
// appears, becomes default, format settles). Requiring the new identity to hold
// for one extra poll means we hot-swap once instead of three times.
const STABLE_TICKS = 2;

export interface DeviceSnapshot {
    /** "<kind>|<name>" of the default render endpoint, '' if unknown. */
    outputRoute: string;
    /** Label of the synthesized `default` input entry (carries the OS default). */
    defaultInput: string;
    inputIds: string;
    outputIds: string;
}

export interface DevicesChangedEvent {
    inputsChanged: boolean;
    outputsChanged: boolean;
    /**
     * False when the loaded .node predates get_output_route(). A plug/unplug is
     * then only visible as a list change, so consumers must treat it as a
     * possible default-endpoint change as well.
     */
    outputRouteKnown: boolean;
}

/** Whether two probes describe the same device graph. */
export function isSameSnapshot(a: DeviceSnapshot, b: DeviceSnapshot): boolean {
    return a.outputRoute === b.outputRoute
        && a.defaultInput === b.defaultInput
        && a.inputIds === b.inputIds
        && a.outputIds === b.outputIds;
}

/**
 * Watches for audio device changes while a meeting is active and reports them
 * as three events: `output-default-changed`, `input-default-changed` and
 * `devices-changed`.
 */
export class AudioDeviceWatcher extends EventEmitter {
    private _timer: NodeJS.Timeout | null = null;
    private _last: DeviceSnapshot | null = null;
    private _pending: DeviceSnapshot | null = null;
    private _pendingTicks = 0;
    private readonly _available: boolean;

    constructor() {
        super();
        this._available = !!NativeModule;
    }

    public isSupported(): boolean {
        return this._available;
    }

    public isRunning(): boolean {
        return this._timer !== null;
    }

    public start(): void {
        if (!this._available) {
            console.warn('[AudioDeviceWatcher] Native module unavailable — device hot-swap disabled.');
            return;
        }
        if (this._timer) return;
        this._last = this._snapshot();
        this._pending = null;
        this._pendingTicks = 0;
        console.log(`[AudioDeviceWatcher] Started. route="${this._last.outputRoute}" input="${this._last.defaultInput}"`);
        this._timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
        this._timer.unref?.();
    }

    public stop(): void {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        this._last = null;
        this._pending = null;
        this._pendingTicks = 0;
    }

    /**
     * Re-baseline without emitting. Call after a deliberate reconfigure so the
     * device change we just caused does not come back as a change to react to.
     */
    public resync(): void {
        if (!this._timer) return;
        this._last = this._snapshot();
        this._pending = null;
        this._pendingTicks = 0;
    }

    /**
     * Current device identity, or null when the native module is unavailable.
     *
     * Exposed so callers can compare across a gap in which the watcher is not
     * running — the meeting being paused, in particular. Both captures cache
     * their native monitor across stop()/start(), so a device change during a
     * pause is invisible to the poll loop and would only surface as a stalled
     * channel after resume.
     */
    public snapshot(): DeviceSnapshot | null {
        return this._available ? this._snapshot() : null;
    }

    private _tick(): void {
        const now = this._snapshot();
        const prev = this._last;
        if (!prev) { this._last = now; return; }

        if (this._same(now, prev)) {
            this._pending = null;
            this._pendingTicks = 0;
            return;
        }
        // Hold until the new state repeats — see STABLE_TICKS.
        if (!this._pending || !this._same(now, this._pending)) {
            this._pending = now;
            this._pendingTicks = 1;
            return;
        }
        if (++this._pendingTicks < STABLE_TICKS) return;

        this._pending = null;
        this._pendingTicks = 0;
        this._last = now;
        this._emitDiff(prev, now);
    }

    private _same(a: DeviceSnapshot, b: DeviceSnapshot): boolean {
        return isSameSnapshot(a, b);
    }

    private _emitDiff(prev: DeviceSnapshot, next: DeviceSnapshot): void {
        if (next.outputRoute && next.outputRoute !== prev.outputRoute) {
            console.log(`[AudioDeviceWatcher] Default output: "${prev.outputRoute}" → "${next.outputRoute}"`);
            this.emit('output-default-changed', { from: prev.outputRoute, to: next.outputRoute });
        }
        if (next.defaultInput && next.defaultInput !== prev.defaultInput) {
            console.log(`[AudioDeviceWatcher] Default input: "${prev.defaultInput}" → "${next.defaultInput}"`);
            this.emit('input-default-changed', { from: prev.defaultInput, to: next.defaultInput });
        }
        const inputsChanged = next.inputIds !== prev.inputIds;
        const outputsChanged = next.outputIds !== prev.outputIds;
        if (inputsChanged || outputsChanged) {
            console.log(`[AudioDeviceWatcher] Device list changed (inputs=${inputsChanged}, outputs=${outputsChanged})`);
            this.emit('devices-changed', {
                inputsChanged,
                outputsChanged,
                outputRouteKnown: !!next.outputRoute,
            } as DevicesChangedEvent);
        }
    }

    /**
     * Cheap identity probe. Every call is individually guarded: getOutputRoute()
     * is optional on older .node binaries, and all three can transiently throw
     * while the OS is mid-transition on a device change — exactly when we poll.
     */
    private _snapshot(): DeviceSnapshot {
        let outputRoute = '';
        try {
            if (typeof NativeModule?.getOutputRoute === 'function') {
                const r = NativeModule.getOutputRoute();
                if (r) outputRoute = `${r.kind ?? ''}|${r.name ?? ''}`;
            }
        } catch { /* stale binary or transient COM failure */ }

        let defaultInput = '';
        let inputIds = '';
        try {
            const inputs: Array<{ id: string; name: string }> = NativeModule?.getInputDevices?.() ?? [];
            // list_input_devices() synthesizes a `default` entry whose label
            // embeds the OS default device name. That label is the only
            // default-input signal the native API exposes.
            defaultInput = inputs.find((d) => d.id === 'default')?.name ?? '';
            inputIds = inputs.map((d) => d.id).sort().join('|');
        } catch { /* transient enumeration failure */ }

        let outputIds = '';
        try {
            const outputs: Array<{ id: string }> = NativeModule?.getOutputDevices?.() ?? [];
            outputIds = outputs.map((d) => d.id).sort().join('|');
        } catch { /* transient enumeration failure */ }

        return { outputRoute, defaultInput, inputIds, outputIds };
    }
}
