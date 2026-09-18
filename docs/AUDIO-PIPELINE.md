# Audio Pipeline — End to End (Capture → Deepgram → UI)

A developer's map of how a spoken word becomes text on screen.

Read **TL;DR** and **The two lanes** to get the shape of it. Everything after
that is reference you can dip into.

---

## TL;DR

There are **two separate audio lanes** that never mix:

| Lane | What it hears | Internal name |
| --- | --- | --- |
| **System audio** | the other person, coming out of your speakers/headphones | `client` |
| **Microphone** | you | `user` |

Each lane has its own capture, its own Deepgram WebSocket, and its own
transcript stream. They only meet again at the very end — in the UI, and in the
echo filter that stops your mic's copy of the other person from being
transcribed twice.

Both lanes follow the same seven steps:

```
OS / hardware
   |   raw samples at the device's native rate (44.1k, 48k, whatever)
   v
Rust native module            <- clean up, echo-cancel, resample
   |   16 kHz mono 16-bit PCM, in 20 ms frames
   v
napi bridge (.node file)
   |   Node Buffer
   v
Capture supervisor (TypeScript)  <- health checks + auto restart
   |   'data' event
   v
main.ts wiring
   |   stt.write(chunk)
   v
DeepgramStreamingSTT          <- WebSocket to Deepgram
   |   'transcript' event
   v
main.ts transcript handler    <- echo filter, translate, fan out
   |   IPC 'native-audio-transcript'
   v
Renderer (React)
```

---

## The two lanes

Everything is built twice, once per lane. When you are reading code and get
lost, ask yourself "which lane am I in?" — that usually explains the behaviour.

| | System audio (`client`) | Microphone (`user`) |
| --- | --- | --- |
| Native class | `SystemAudioCapture` | `MicrophoneCapture` |
| Supervisor file | [SystemAudioCapture.ts](electron/audio/SystemAudioCapture.ts) | [MicrophoneCapture.ts](electron/audio/MicrophoneCapture.ts) |
| STT instance in `main.ts` | `this.googleSTT` | `this.googleSTT_User` |
| Wiring function | `wireSystemCapture()` | `wireMicrophoneCapture()` |
| Level channel for the UI meter | `'system'` | `'mic'` |

> **Naming trap:** the fields are called `googleSTT` and `googleSTT_User` for
> historical reasons. They usually hold a **Deepgram** connection, not Google.
> The actual class is chosen at runtime by `createSTTProvider()`.

---

## Step 1 — The OS hands us raw audio

This all happens inside the Rust native module
([native-module/src/lib.rs](native-module/src/lib.rs)).

**Microphone** — same on every platform. We use **CPAL** to open the input
device. The device is picked when the object is constructed, so changing mics
means building a new capture (see *Device hot-swap* below). CPAL only tells us a
device died through its stream error callback — there is no "device removed"
event to subscribe to.

**System audio** — completely different per platform:

| Platform | How | Gotchas |
| --- | --- | --- |
| **Windows** | WASAPI **loopback**: we open the default *output* device as if it were an input | The endpoint can be re-opened in place, so restarts are cheap |
| **macOS** | CoreAudio **Process Tap**, falling back to **ScreenCaptureKit** | Needs the *Screen Recording* permission. Takes 5–7 s to initialise |
| **Linux** | PulseAudio **monitor source**: every output sink has a companion `<sink>.monitor` that carries whatever is being played to it | Needs a PulseAudio-compatible server running. `pipewire-pulse` counts, so modern distros work unchanged |

The macOS permission is resolved **before** we construct the system capture. If
we skipped that, every restart attempt would re-trigger the OS permission
dialog, and a user who said "no" would be prompted every couple of seconds for
the whole meeting.

### A note on Linux

Linux is the one platform where the sound server is not part of the OS, so it is
worth spelling out what we talk to and why.

We speak the **PulseAudio protocol**, not PipeWire's native API. That sounds
backwards on a 2026 desktop, but `pipewire-pulse` ships enabled on every
PipeWire system, so one client covers both worlds:

- PulseAudio distros — Ubuntu ≤ 22.04, Debian, Mint
- PipeWire distros — Ubuntu ≥ 22.10, Fedora, Arch

The alternative — a PipeWire-native client — would drop Ubuntu 22.04 LTS, which
is still very much in use. There is no kernel module to load (`snd-aloop`), no
config file to edit, and nothing needs root.

Three things are different from the Windows and macOS backends:

**We ask for 16 kHz mono directly.** Pulse resamples and downmixes server-side,
the same job WASAPI's `convert=true` does. So the DSP thread builds *no*
resampler for this lane, and swapping output devices mid-meeting cannot change
the rate the pipeline sees.

**A monitor emits silence rather than nothing.** While a sink is merely idle, its
monitor still produces real silent samples, which is exactly the keepalive
behaviour the pipeline wants. If the sink is fully *suspended* it does go quiet,
so a watchdog thread tops the ring up with synthesized silence — the same
guarantee `getNativeFeatureLevel() === 2` makes on the other platforms.

**Shutdown is bounded, not joined.** The reader thread can be parked inside a
blocking `read()` on a suspended sink. `Drop` waits 1.5 s for both worker
threads and then *detaches* them instead of blocking, so a restart from the JS
supervisor can never hang on a stuck sink.

Device hot-swap comes half for free: Pulse migrates streams itself when a sink
disappears, and a watchdog polls the default sink every second to catch the other
case — the user switching outputs while both devices still exist.

If no sound server is reachable, the error we surface names the fix
(`systemctl --user status pipewire-pulse`) and deliberately avoids the phrase
`not supported on this platform`, so the supervisor keeps retrying and the lane
heals itself if the server starts later.

**Packages.** Building needs `libpulse-dev` and `libasound2-dev` (plus the C++
toolchain for the echo canceller); `npm run build:native` preflights all of them
and prints the right `apt` / `dnf` / `pacman` command if any are missing. At
runtime the `.deb` depends on `libpulse0` and `libasound2 | libasound2t64` —
both are hard dependencies, because the `.node` links against them and a missing
one takes the whole native module down, not just system audio.

---

## Step 2 — Rust cleans the audio up

The audio-device callback runs on a real-time thread. You cannot do heavy work
there without causing dropouts, so it does the minimum: push samples into a
**lock-free ring buffer** (`ringbuf::HeapRb<f32>`, single producer / single
consumer) and return.

A separate **DSP thread** drains that buffer and works in **20 ms frames**
(`native_rate / 1000 * 20` samples per frame). For each frame:

**1. Silence suppression.** Decide whether the frame is real audio, or silence.
The two lanes are tuned differently on purpose:

| Setting | System audio | Microphone |
| --- | --- | --- |
| Amplitude threshold | 30 | 100 |
| Hangover (keep sending after speech stops) | 300 ms | 150 ms |
| Keepalive interval | 100 ms | 100 ms |
| Noise-floor multiplier | 3.0 | 3.0 |
| Minimum floor | 10.0 | 20.0 |
| Envelope smoothing (EMA) | 0.02 | 0.02 |

The mic is gated harder because it sits in a room full of noise; the far end
arrives already clean and level-matched by the conferencing app.

**2. Echo cancellation (mic lane only).** A shared WebRTC audio-processing
module (AEC3) uses the *system audio* as its reference signal and removes it
from the mic. A `MicGate` then decides `Emit` or `Duck` for the frame. This is
what stops "your speakers leak into your mic" from producing a duplicate
transcript. The real AEC3 runs on **macOS and Linux**; on Windows
[apm_shim.rs](native-module/src/apm_shim.rs) swaps in no-op stand-ins with the
same API, so the call sites need no `#[cfg]` branching.

**3. Resample to 16 kHz mono.** `rubato` converts whatever the device gave us
into **16 kHz, mono, 16-bit PCM**. This runs on **every** frame, even ones we
are about to throw away, because AEC3 needs an unbroken timeline of what came
out of the speakers. Skipping resampling on dropped frames would put a hole in
that timeline and break echo alignment.

**4. Emit, or emit silence.** The frame is sent to JavaScript, or replaced with
bit-exact zeros (a *keepalive*), or the loop just waits.

### The keepalive invariant (important)

Even in total silence, **every healthy lane emits about 10 chunks per second**
(one per 100 ms).

Two consequences you will rely on constantly:

- **No chunks = the stream is dead.** It never means "the user is quiet". Every
  watchdog in the TypeScript layer is built on this.
- **Silent chunks are not evidence of a problem.** A quiet meeting looks
  byte-identical to a permission failure that zero-fills our buffer. To tell
  them apart you need something else — see *Watchdogs* below.

### Why 16 kHz mono matters so much

Deepgram is told the sample rate **once**, in the WebSocket URL. Because Rust
always outputs 16 kHz mono no matter what hardware is underneath, **restarting a
capture never requires reconnecting to Deepgram.** That single design choice is
what makes device hot-swapping invisible to the transcript.

---

## Step 3 — Crossing into JavaScript

The Rust module is compiled with **napi-rs** into a platform-specific `.node`
file. Chunks reach JS through a `ThreadsafeFunction<Buffer>`, so the callback
signature is `(err, chunk)` — check `err` first.

What Rust exports:

- `SystemAudioCapture` / `MicrophoneCapture` — each with `getSampleRate()`,
  `start(onData, onSpeechEnded)`, `stop()`
- `getInputDevices()`, `getOutputDevices()`, `getOutputRoute()`
- `getAudioPipelineStats()` — JSON snapshot of the echo pipeline (ERLE, gate
  state); handy when debugging echo
- `getNativeFeatureLevel()` — capability probe, see *Watchdogs*

[nativeModuleLoader.ts](electron/audio/nativeModuleLoader.ts) loads the `.node`
file **by path**, not via `require('natively-audio')`. The npm-symlink approach
breaks on Windows. It tries the dev path, one level up, and
`app.asar.unpacked/native-module/` for packaged builds, then returns `null`
rather than throwing — so a missing native build degrades instead of crashing.

The newer methods (`getOutputRoute`, `getAudioPipelineStats`,
`getNativeFeatureLevel`) are **optional** so an older `.node` binary still
loads. Always call them with `?.` and have a fallback.

---

## Step 4 — The capture supervisors

`SystemAudioCapture.ts` and `MicrophoneCapture.ts` are thin TypeScript wrappers
around the native classes whose real job is **staying alive**. They are
`EventEmitter`s.

Events they emit: `start`, `stop`, `data`, `speech_ended`, `error`,
`sample-rate-detected`, `capture-failed`, `capture-recovered`.

### Health model

```ts
interface CaptureHealth {
  recording: boolean;         // is the native stream open right now
  shouldBeRecording: boolean; // do we WANT it open (the meeting is live)
  chunkCount: number;
  msSinceLastChunk: number;
  msSinceLastNonSilent: number;
  restartAttempts: number;
  degraded: boolean;          // dropped out of the fast-retry tier
}
```

The gap between `recording` and `shouldBeRecording` is the whole point: it is
what lets a supervisor notice "I am supposed to be capturing and I'm not" and
fix it without anyone asking.

### The supervisor loop

A `setInterval` tick that **always re-arms**, so it cannot die quietly. Every
failure — native error, stall, zero-chunk open — funnels into one method,
`_onNativeError()`, which decides whether to reopen.

Retry timing:

- **Fast tier:** 250 ms → 500 ms → 1 s → 2 s → 4 s
- **Slow tier:** 30 s, **forever**

Retries never stop. Leaving the fast tier sets `degraded` and emits
`capture-failed`, which is a *banner the user can act on*, not the end of the
lane. When chunks come back, `capture-recovered` takes the banner down.

The one exception is `PERMANENT_ERROR_RE` — `/not supported on this platform/i`.
That phrase means a build with no backend for this OS at all, which no amount of
retrying will fix, so we stop and report it as terminal. Every real backend keeps
that phrase out of its error strings for exactly this reason — a Linux box with
no sound server running, for instance, reports the missing server by name and
stays on the retry path so it recovers when the server comes up.

### Watchdogs and their timing

| Watchdog | System audio | Microphone | Why |
| --- | --- | --- | --- |
| Start grace (ignore stalls right after opening) | 12 s on macOS, 8 s on Linux, 5 s elsewhere | 5 s | ScreenCaptureKit needs 5–7 s just to warm up; Linux does a sound-server handshake plus two introspection round-trips |
| Stall window (no chunks for this long → restart) | 10 s if `getNativeFeatureLevel() >= 2`, else 3 s | 3 s (`LIVENESS_WINDOW_MS`) | Feature level ≥ 2 means the backend synthesises silence during idle (all three platforms do), so the shorter window would be trigger-happy |
| "Non-silent" amplitude threshold | 8 | 8 | Feeds `msSinceLastNonSilent` |

If an open produces **zero** chunks and it isn't the first attempt, the monitor
is dropped before retrying, so a broken endpoint can't hold the slot.

### Sample-rate polling

A poll at 1 s then every 8 s reads the device's declared rate and emits
`sample-rate-detected` **only when it actually changes**. `main.ts` forwards
that to `stt.setSampleRate()`. In practice this fires rarely, because Rust
already normalises to 16 kHz — it exists for the case where the *declared* rate
was wrong at open time.

### `restart(reason, rebindDevice)`

The public entry point for recovery. `rebindDevice: true` means "re-resolve the
device from the OS", which is what device hot-swap uses. `false` reopens the
same endpoint.

---

## Step 5 — main.ts wires captures to STT

[wireSystemCapture()](electron/main.ts:809) and
[wireMicrophoneCapture()](electron/main.ts:1018) attach the listeners. The
`data` handler is short and every line of it matters:

```ts
capture.on('data', (chunk: Buffer) => {
  if (this.microphoneCapture !== capture) return;   // 1. identity guard
  this.sendAudioLevel('mic', chunk);                // 2. feed the UI meter
  if (peakToPeak(chunk) > SILENCE_PEAK_TO_PEAK_THRESHOLD)
    this._lastRealMicAudioAt = Date.now();          // 3. "real audio" timestamp
  this.googleSTT_User?.write(chunk);                // 4. off to Deepgram
});
```

**1. The identity guard.** `if (this.microphoneCapture !== capture) return;`
appears in *every* handler. When a capture is replaced (device swap, restart),
the old instance may still be draining. Without this guard two captures write to
one Deepgram socket and you get two interleaved copies of the same speech.
**Copy this pattern into any new handler you add.**

**2. Audio levels for the UI.** `sendAudioLevel()` throttles to one message per
**50 ms per channel** and computes a simple RMS level:

```ts
// electron/main.ts:757
computeAudioRmsLevel(chunk) => Math.min(rms / 10000, 1.0)  // stride 10
```

It goes out as an `audio-level` IPC event and drives the wave meter in the
floating dock. Note the `/10000` divisor is calibrated for the **loopback**
lane; the mic lands roughly 2× lower for the same perceived loudness, which the
renderer compensates for with a per-channel gain in
[AudioWaveIndicator.tsx](src/features/floating-dock/AudioWaveIndicator.tsx).

**3. The "real audio" timestamp.** Because of keepalives, chunk *rate* tells you
nothing about whether anyone is talking. `_lastRealSystemAudioAt` and
`_lastRealMicAudioAt` record the last time a chunk had actual amplitude. The
far-end silence detector needs both.

### Two extra detectors on the system lane

**Stuck watchdog** — armed on `start`, disarmed by the very first chunk. If it
fires, the capture opened successfully but produced literally nothing: wrong
route, or a permission that was revoked. It is also exposed as
`capture.__disarmStuckWatchdog` so `endMeeting()` can cancel it *before* calling
`stop()` — otherwise a very short meeting raises a false alarm seconds after the
user already stopped recording.

**Zero-fill detector (macOS only)** — tracks a *rolling run* of silence, reset by
any real audio. When the run gets long enough it actively re-probes the Screen
Recording permission before saying anything, because an orphaned grant still
reports `granted` while capturing nothing. Rate-limited to one probe a minute.
Windows loopback doesn't zero-fill on permission change, so the detector has no
value there and is skipped.

### Choosing the STT provider

[createSTTProvider(speaker)](electron/main.ts:1751) builds one STT instance per
lane. The provider comes from `CredentialsManager.getInstance().getSttProvider()`:

`deepgram` · `soniox` · `elevenlabs` · `openai` · `groq` / `azure` /
`ibmwatson` (batched REST) · `GoogleSTT`

**Every one of them falls back to `GoogleSTT` when its API key is missing.** If
transcripts look unexpectedly different, check which provider actually got
constructed before debugging Deepgram.

Only the `client` lane may enable `diarize` (speaker separation) — it is a paid
Deepgram add-on and the mic lane has exactly one speaker anyway.

---

## Step 6 — DeepgramStreamingSTT

[electron/audio/DeepgramStreamingSTT.ts](electron/audio/DeepgramStreamingSTT.ts)

### Lifecycle

```
start()   -> isActive = true
write()   -> buffer or send   (SILENTLY DROPS when isActive === false)
connect() -> open WebSocket, flush buffer, start keepalive
stop()    -> isActive = false, close socket
```

> **Rule #1 — start STT *before* you start captures.**
>
> `write()` begins with `if (!this.isActive) return;`. Audio pushed before
> `start()` is **thrown away with no error and no log line**. This is why
> `startMeeting()` and `resumeMeeting()` create and start the STT instances
> first, and only then open the captures. There is a comment marking this at
> [main.ts:2873](electron/main.ts:2873). If you ever reorder that, the first
> seconds of every meeting go missing and nothing in the logs will tell you.

`write()` lazily connects when the socket isn't open yet, and **buffers up to
500 chunks** in the meantime. The buffer is flushed in order inside the `open`
handler.

### Connection parameters

```ts
{
  Authorization: `Token ${apiKey}`,
  model:          'nova-3',
  encoding:       'linear16',
  sample_rate:    this.sampleRate,     // 16000 in practice
  channels:       this.numChannels,    // 1
  language:       this.languageCode,
  smart_format:   'true',              // punctuation, numbers, dates
  interim_results:'true',              // live partials for the rolling UI
  utterance_end_ms:'1500',
  vad_events:     'true',
  endpointing:    languageCode === 'multi' ? '100' : '500',
  // diarize: 'true'  <- client lane only, when enabled
}
```

`endpointing` is aggressive (100 ms) in multi-language mode because language
switches otherwise get glued into one long window.

### The connect handshake

```ts
const socket = deepgram.listen.live(queryParams);  // createConnection
socket.on('open', ...); socket.on('message', ...); // handlers FIRST
socket.connect();                                  // then handshake
```

Handlers are registered **before** `connect()`. The SDK's reconnecting
WebSocket can otherwise fire `open` before you are listening, and the socket sits
there connected but silent forever.

### Generations: how superseded sockets are silenced

Every `connect()` bumps `_connectGeneration` and captures the value in a local.
Each handler starts with:

```ts
if (generation !== this._connectGeneration) return;
```

An old socket that is still closing must not mutate reconnect state, emit
transcripts, or touch the timestamp anchors — those now describe a *different*
socket's clock. Same idea as the capture identity guards.

### Timing constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `RECONNECT_BASE_DELAY_MS` | 1 000 | first retry delay |
| `RECONNECT_MAX_DELAY_MS` | 30 000 | backoff ceiling |
| `KEEPALIVE_INTERVAL_MS` | 5 000 | JSON keepalive so Deepgram doesn't time us out |
| `STABLE_CONNECTION_MS` | 30 000 | uptime that "earns" a backoff reset |
| `CONNECT_TIMEOUT_MS` | 15 000 | `_armConnectDeadline()` — stops `isConnecting` latching forever |

Backoff resets on **either** condition:

1. the connection survived 30 s, **or**
2. a real transcript arrived (proof it works, whatever the uptime)

Without #2, a connection that had escalated to the 30 s cap would keep paying 30
s per blip even while transcribing perfectly — up to 30 s of lost speech each
time. A socket that opens but never transcribes still escalates, so genuine
server flapping is still handled.

A **429** sets `rateLimitedUntil = now + 30 s` and no reconnect happens before
then. Hammering a rate-limited key just extends the outage.

### Word timestamps and the shared clock

Deepgram reports word times in *seconds since the start of this stream*. The
transcript echo filter needs to compare mic words against client words, and the
two lanes have different stream start times — so both need converting to
wall-clock milliseconds.

That is what `_sendTracked()` is for. It is the **only** place that calls
`sendMedia()`, and on each send it:

1. advances `_bytesSent`
2. converts bytes → stream seconds (bytes / 2 / sample_rate for 16-bit mono)
3. appends `{ streamSec, wallMs }` to the `_anchors` ring

`convertStreamSecToWallMs()` then interpolates against that ring. **If you add a
new send path, route it through `_sendTracked()`** — bypassing it silently
desynchronises the clock and echo filtering starts missing.

### Reading Deepgram's messages

| Message | What we do |
| --- | --- |
| `SpeechStarted` | log only |
| `Metadata` | ignore |
| `UtteranceEnd` | safety-net flush of `_lastIsFinalText` (normally already empty) |
| `Results` with `is_final: true` | **emit as final** |
| `Results` without `is_final` | emit as interim (live display only) |

Field semantics, which are easy to get wrong:

- **`is_final: true`** — Deepgram has committed this window and will not revise
  it. Can arrive mid-sentence for long speech. **This is the authoritative final
  signal for both lanes.**
- **`speech_final: true`** — an endpoint was detected. Always arrives *with*
  `is_final`, never alone.
- **`UtteranceEnd`** — in practice only fires reliably on the **mic** lane. On
  the client lane, VAD-lockout restarts cut the audio stream before Deepgram ever
  hears the closing silence, so it never arrives. If you build a feature on
  `UtteranceEnd`, it will work for `user` and quietly never fire for `client`.

Committed windows can span a speaker change when `diarize` is on, so
`splitFinalBySpeaker()` breaks them into same-speaker runs. Interims are never
split or speaker-labelled — their speaker indices are unstable and would flicker.

The emitted shape:

```ts
stt.emit('transcript', {
  text: string,
  isFinal: boolean,
  confidence: number,
  speakerIndex?: number,   // diarize only
  words?: SttWord[],       // wall-clock ms, main-process only
});
```

---

## Step 7 — From transcript to screen

One handler, registered per lane in
[createSTTProvider()](electron/main.ts:1828). The order of operations is
deliberate.

**Gate 1 — is this still wanted?** Dropped if the meeting is not active, or is
paused (in-flight audio can land just after a pause).

**Gate 2 — echo filtering.** On macOS with external speakers, your mic
physically hears the other person, so their words appear in *both* lanes. The
`TranscriptEchoFilter` compares mic text against recent client text:

| Segment | Method | Possible outcomes |
| --- | --- | --- |
| mic **interim** | `filterUserInterim()` | pass · suppress |
| mic **final** | `filterUserFinal()` | pass · **trim** (word-timestamp match removes just the echoed span) · **drop** (n-gram fallback drops the whole segment) |
| client final | `addClientFinal()` | recorded as reference |
| client interim | `addClientInterim()` | recorded as *provisional* reference |

Client **interims** are used as reference too, which closes a real ordering gap:
VAD-lockout restarts delay client *finals*, so mic echo often arrives before the
client final does — but never before the client interim.

Dropping a mic final needs two bits of cleanup, both easy to forget:

1. push an empty final into `IntelligenceManager` so the pending interim slot is
   cleared and can't be persisted on stop
2. if a partial is currently on screen, send a `retract: true` payload so the UI
   takes it back down

This text-level gate is **macOS-only** (`echoPossible` defaults to
`process.platform === 'darwin'`). Windows and Linux rely on the native AEC3
stage alone. That is a deliberate trade: the filter can *drop real user speech*
when it misfires, which is a worse failure than a little residual echo, so it
stays off on platforms where it has not been tuned.

> **Rule #2 — echo filtering happens *before* translation.**
>
> The filter compares mic audio against far-end audio. Both are in the spoken
> language. Translate first and the texts no longer match, so echo detection
> stops working entirely. Everything above the `dispatch` line in the handler
> runs on the **original** recognised text.

**Gate 3 — optional translation.** When transcript translation is on, finals go
through a per-speaker queue so they stay in spoken order (translation is async
and would otherwise reorder them). Interims skip translation and dispatch
synchronously — they're about to be replaced anyway.

**Fan-out.** [`_dispatchTranscript()`](electron/main.ts:1964) does five things:

1. `intelligenceManager.handleTranscript(...)` — session tracking, AI features
2. finals only: `ragManager.feedLiveTranscript(...)` — just-in-time retrieval
3. resolve a human display name (`Me` / `Them`, or the real names once known).
   With diarization, a `· Speaker N` suffix is appended — but **only after a
   second speaker has actually been seen**, so ordinary 1:1 calls look unchanged
4. send `native-audio-transcript` IPC to the launcher window *and* the overlay
5. client finals only: `knowledgeOrchestrator.feedInterviewerUtterance(...)`

> **`words` never crosses IPC.** The payload deliberately omits `segment.words`.
> This stream runs at 10+ messages a second and word arrays would dominate the
> serialisation cost, for data the renderer has no use for.

### On the renderer side

| Hook | Job |
| --- | --- |
| [useMeetingSession.ts](src/hooks/useMeetingSession.ts:36) | buffers segments into `transcriptSegmentsRef` while a backend meeting id exists |
| [useGodojoInterface.ts](src/hooks/useGodojoInterface.ts:537) | rolling transcript, handles `retract`, strips the pending partial at the `'  ·  '` separator |
| [useLiveAudioLevels.ts](src/hooks/useLiveAudioLevels.ts) | `audio-level` events → the dock's wave meter |
| [useSystemAudioPermission.ts](src/hooks/useSystemAudioPermission.ts:104) | consumes `onAudioCaptureFailed` and shows the banner |

The preload bridge exposes three relevant channels
([preload.ts](electron/preload.ts:751), typed in
[electron.d.ts](src/electron.d.ts:247)):

- `onNativeAudioTranscript` — transcript segments
- `onAudioLevel` — `{ channel: 'mic' | 'system', level: 0..1 }`
- `onAudioCaptureFailed` — capture health banners

---

## Reliability layers

Four independent mechanisms, each catching a failure the others can't see.

### 1. Capture supervisors

Covered above. Catch: *the stream stopped producing chunks.*

### 2. Device hot-swap

[AudioDeviceWatcher.ts](electron/audio/AudioDeviceWatcher.ts) **polls** every
**1 500 ms**. Polling, not OS callbacks — nowhere in the app do we register for
device-change notifications, so this is the only source of truth.

```ts
interface DeviceSnapshot {
  outputRoute: string;   // speakers vs headphones vs unknown
  defaultInput: string;
  inputIds: string[];
  outputIds: string[];
}
```

A change must hold for **`STABLE_TICKS = 2`** consecutive polls before it counts.
Device lists churn transiently while an OS switches endpoints; acting on the
first reading restarts captures two or three times per swap.

Emits `output-default-changed`, `input-default-changed`, `devices-changed` (with
`outputRouteKnown`). The handlers in
[main.ts:2225–2404](electron/main.ts:2225) call
`capture.restart(reason, /* rebindDevice */ true)`.

After we deliberately reconfigure audio ourselves, call **`resync()`** to
re-baseline the snapshot. Skip it and the watcher sees our own change as external
and restarts again — a feedback loop.

Catch: *the stream is fine but it's attached to a device the user stopped using.*

### 3. Pause / resume reconciliation

[pauseMeeting()](electron/main.ts:3211) / [resumeMeeting()](electron/main.ts:3266)

The watcher is stopped while paused, so a swap during the pause would be
invisible. `snapshot()` is public precisely so pause can record the device state
and resume can compare across the gap, rebinding if anything moved. Resume also
restarts the watcher.

Catch: *the user unplugged their headset while the meeting was paused.*

### 4. Far-end silence detector

[main.ts:2433–2504](electron/main.ts:2433). Constants:
`FAR_END_SILENCE_MS = 45 000`, `FAR_END_TICK_MS = 5 000`.

Every 5 s it asks: *has the mic heard real audio recently (so a conversation is
definitely happening), while the system lane has produced nothing but silence for
45 seconds?* If so, our loopback capture is almost certainly bound to the wrong
endpoint.

This is the only layer that can catch that, because such a capture is **perfectly
healthy** by every other measure: it is open, it is emitting chunks, no error
ever fired. It just happens to be listening to an endpoint nothing is playing to.

Real cause on Windows: the OS has separate **`eConsole`** and
**`eCommunications`** default roles. Conferencing apps play to
`eCommunications`; we bind `eConsole`. The device graph looks completely healthy
while the call audio comes out somewhere else.

The mic-activity precondition matters — without it this fires on every meeting
where the other person simply hasn't spoken yet.

---

## Rules you should not break

1. **Start STT before captures.** `write()` drops silently when inactive.
2. **Rust always emits 16 kHz mono.** Keep it that way — it is what makes capture
   restarts invisible to Deepgram. Never send device-native rates upstream.
3. **Identity-guard every capture and socket handler.** `if (this.x !== x) return;`
4. **Never read silence as "the user is quiet".** Keepalives make *no chunks*
   unambiguous; *silent chunks* prove nothing on their own.

5. **Echo filter before translation.**
6. **Route all media sends through `_sendTracked()`**, or the word clock drifts.
7. **Call `deviceWatcher.resync()`** after any reconfigure you initiate.
8. **Don't put `words` on the IPC stream.**

---

## Debugging cheat sheet

### Log prefixes

| Prefix | Layer |
| --- | --- |
| `[nativeModuleLoader]` | `.node` loading — check this first if devices list empty |
| `[Main] ` | capture wiring, watchdogs, device changes |
| `[DeepgramStreaming:client]` / `[DeepgramStreaming:user]` | one WebSocket each — the role suffix tells you the lane |
| `[Main] STT transcript (client\|user, final=…)` | every segment that survived the gates |

### Symptom → where to look

| Symptom | Likely layer | First thing to check |
| --- | --- | --- |
| No transcripts at all, either lane | STT lifecycle | Was `start()` called before captures? Is an API key present, or did it silently fall back to `GoogleSTT`? |
| Client transcripts stop mid-meeting, pause/resume fixes it | capture supervisor or wrong endpoint | `CaptureHealth.msSinceLastChunk` vs `msSinceLastNonSilent`. Chunks flowing + all silent = wrong endpoint, not a dead capture |
| Nothing from the far end on macOS | Screen Recording permission | The zero-fill detector's probe result; an orphaned grant still reports `granted` |
| Nothing from the far end on Linux | sound server | `systemctl --user status pipewire-pulse`, then `pactl list short sources \| grep monitor`. No monitor source means no sink to record |
| `.node` fails to load on Linux | missing runtime library | `ldd native-module/index.linux-x64-gnu.node` — look for `libpulse.so.0` or `libasound.so.2` reported as *not found* |
| Everything the other person says appears twice | echo filter | Client finals arriving *after* the mic echo — check `addClientInterim` is being fed |
| A mic partial is stuck on screen | retraction path | Was `retract: true` emitted when the final was dropped? |
| Wave meter animates for the client but barely for you | renderer gain, not capture | Per-channel gain in `AudioWaveIndicator.tsx`; the `/10000` divisor is loopback-calibrated |
| Transcripts arrive but out of order | translation queue | Finals must go through the per-speaker queue; interims must not |
| Reconnect storm in the logs | backoff | Look for a `429` — `rateLimitedUntil` should floor retries at 30 s |

### Useful probes

`getAudioPipelineStats()` returns a JSON snapshot of the echo pipeline (ERLE,
gate state, alignment). `getNativeFeatureLevel()` tells you whether you are on a
binary that synthesises idle silence — which changes the stall window from 3 s to
10 s and therefore changes what "stalled" even means.

---

## Glossary

| Term | Plain meaning |
| --- | --- |
| **AEC / AEC3** | Acoustic Echo Cancellation. Removes the speaker output from the mic signal. |
| **Anchor** | A `{ streamSec, wallMs }` pair letting us convert Deepgram's stream-relative word times into wall-clock time. |
| **Diarization** | Splitting one audio stream into "speaker 1 / speaker 2". Client lane only, paid add-on. |
| **Endpointing** | Deepgram deciding a sentence has ended. |
| **Final** | A transcript Deepgram has committed and will not revise (`is_final: true`). |
| **Interim / partial** | A live guess that will be replaced. Display only — never store it. |
| **Keepalive (audio)** | 100 ms of bit-exact zeros, so a healthy silent lane still emits ~10 chunks/s. |
| **Keepalive (WebSocket)** | A JSON message every 5 s so Deepgram doesn't time the socket out. |
| **linear16** | Uncompressed 16-bit signed PCM. What we send. |
| **Loopback** | Recording a device's *output* as if it were an input. How Windows captures system audio. |
| **napi-rs** | The Rust ↔ Node bridge. Produces the `.node` binary. |
| **Ring buffer** | Fixed-size queue. Lets the real-time audio thread hand off samples without locking. |
| **VAD** | Voice Activity Detection. "Is anyone speaking right now?" |
| **VAD lockout** | Our own restart triggered by the silence gate, which is why the client lane never sees `UtteranceEnd`. |

---

## File map

| File | What lives there |
| --- | --- |
| [native-module/src/lib.rs](native-module/src/lib.rs) | napi exports + both DSP loops (system ~180–355, mic ~540–620) |
| [native-module/src/silence_suppression.rs](native-module/src/silence_suppression.rs:65) | the two gate presets |
| [native-module/src/speaker/windows.rs](native-module/src/speaker/windows.rs) | WASAPI loopback backend |
| [native-module/src/speaker/linux.rs](native-module/src/speaker/linux.rs) | PulseAudio monitor backend (reader + watchdog threads) |
| [native-module/src/speaker/pulse.rs](native-module/src/speaker/pulse.rs) | Pulse server introspection: sink list, default sink, active port |
| [native-module/src/apm_shim.rs](native-module/src/apm_shim.rs) | real AEC3 on macOS/Linux, no-op stand-ins on Windows |
| [nativeModuleLoader.ts](electron/audio/nativeModuleLoader.ts) | finds and validates the `.node` binary |
| [SystemAudioCapture.ts](electron/audio/SystemAudioCapture.ts) | client-lane supervisor, watchdogs, restart ladder |
| [MicrophoneCapture.ts](electron/audio/MicrophoneCapture.ts) | mic-lane supervisor, `vadDisabled` / echo options |
| [AudioDeviceWatcher.ts](electron/audio/AudioDeviceWatcher.ts) | 1.5 s device polling, snapshot diffing |
| [DeepgramStreamingSTT.ts](electron/audio/DeepgramStreamingSTT.ts) | WebSocket, params, reconnect, anchors, transcript events |
| [GoogleSTT.ts](electron/audio/GoogleSTT.ts) | the no-API-key fallback provider |
| [scripts/build-native.js](scripts/build-native.js) | per-platform native build, Linux dependency preflight |
| [main.ts](electron/main.ts) | all the wiring — see the line map below |

### `electron/main.ts` line map

Line numbers drift — treat these as bookmarks, not addresses.

| Line | What |
| --- | --- |
| [757](electron/main.ts:757) | `computeAudioRmsLevel()` |
| [771](electron/main.ts:771) | `sendAudioLevel()` (50 ms throttle per channel) |
| [809](electron/main.ts:809) | `wireSystemCapture()` |
| [1018](electron/main.ts:1018) | `wireMicrophoneCapture()` |
| [1751](electron/main.ts:1751) | `createSTTProvider()` |
| [1828](electron/main.ts:1828) | the shared `transcript` handler (echo filter, translation) |
| [1964](electron/main.ts:1964) | `_dispatchTranscript()` |
| [2020](electron/main.ts:2020) | `setupSystemAudioPipeline()` |
| [2118](electron/main.ts:2118) | `reconfigureAudio()` |
| [2225](electron/main.ts:2225) | `_startDeviceWatcher()` + hot-swap handlers |
| [2433](electron/main.ts:2433) | far-end silence detector |
| [2774](electron/main.ts:2774) | `startMeeting()` |
| [2873](electron/main.ts:2873) | the "start STT before captures" comment |
| [3211](electron/main.ts:3211) | `pauseMeeting()` |
| [3266](electron/main.ts:3266) | `resumeMeeting()` |

---

## Adding a feature — a short checklist

- **New STT provider?** Add it to `createSTTProvider()`, emit the same
  `'transcript'` event shape, and keep the `GoogleSTT` fallback when the key is
  missing.
- **New capture event handler?** First line is the identity guard.
- **New place that sends audio to Deepgram?** Go through `_sendTracked()`.
- **Reconfiguring devices yourself?** Call `deviceWatcher.resync()` afterwards.
- **Changing meeting start/stop order?** Re-read Rule #1.
- **New watchdog?** Decide up front whether you are detecting *no chunks* (safe,
  unambiguous) or *silent chunks* (needs a second signal before you can blame
  anything).

