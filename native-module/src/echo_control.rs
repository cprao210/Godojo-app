// Echo gate control — the policy layer between the capture DSP loops and STT.
//
// Replaces the old all-or-nothing SPEAKER_ACTIVE hard mute with a mode-driven
// pipeline:
//
//   legacy       — the original gate, bit-compatible mute condition
//                  (SilenceSuppressor-driven SPEAKER_ACTIVE + 100 ms APM
//                  warmup). Kept for A/B rollback.
//   phase1       — headphone bypass + RMS-driven gate with a short (120 ms)
//                  hangover decoupled from the STT hangover. AEC3 processes
//                  every frame in all modes so it can actually converge.
//   full_duplex  — phase1 plus runtime delay alignment (echo_align) and a
//                  convergence-tracking soft gate: once AEC3 demonstrably
//                  cancels the echo (ERLE high, delay stable) the mic stays
//                  open (residual far-end passages are ducked, not muted)
//                  even while the far end speaks. Falls back to the hard
//                  gate whenever convergence is lost, with a talk-over escape
//                  hatch — gated on AEC evidence (ERLE) — so loud near-end
//                  speech still gets through. While the render pipeline has
//                  not produced a frame yet (SCK init takes 5-7 s) the gate
//                  holds hard-closed (startup_hold) instead of leaking the
//                  far end, then fails OPEN if render never arrives.
//
// Mode source of truth: CaptureOptions.echoMode from JS, falling back to the
// NATIVELY_ECHO_MODE env var, falling back to full_duplex (the default —
// phase1/legacy remain available as rollback modes).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use crate::apm::Processor;
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

use crate::echo_align;
use crate::output_route::{self, OutputRouteInfo, RouteKind};

// ============================================================================
// Time base
// ============================================================================

static EPOCH: Lazy<Instant> = Lazy::new(Instant::now);

/// Monotonic milliseconds since module epoch. Shared time base for the gate
/// hangover and the envelope timestamps in echo_align.
pub fn now_ms() -> u64 {
    EPOCH.elapsed().as_millis() as u64
}

// ============================================================================
// Mode
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EchoMode {
    Legacy = 0,
    Phase1 = 1,
    FullDuplex = 2,
}

impl EchoMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            EchoMode::Legacy => "legacy",
            EchoMode::Phase1 => "phase1",
            EchoMode::FullDuplex => "full_duplex",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "legacy" => Some(EchoMode::Legacy),
            "phase1" => Some(EchoMode::Phase1),
            "full_duplex" | "fullduplex" | "full-duplex" => Some(EchoMode::FullDuplex),
            _ => None,
        }
    }
}

// Default echo mode when NATIVELY_ECHO_MODE is unset. Windows has no WebRTC APM
// (AEC disabled — see src/apm_stub.rs), and FullDuplex relies on APM convergence
// stats that the stub never produces, so Windows defaults to the Processor-free
// Phase1 hard-gate (headphone bypass + speaker-recently-active mute) instead.
#[cfg(not(target_os = "windows"))]
const DEFAULT_ECHO_MODE: EchoMode = EchoMode::FullDuplex;
#[cfg(target_os = "windows")]
const DEFAULT_ECHO_MODE: EchoMode = EchoMode::Phase1;

static MODE: Lazy<AtomicU8> = Lazy::new(|| {
    let m = std::env::var("NATIVELY_ECHO_MODE")
        .ok()
        .and_then(|v| EchoMode::parse(&v))
        .unwrap_or(DEFAULT_ECHO_MODE);
    println!("[EchoControl] mode={}", m.as_str());
    AtomicU8::new(m as u8)
});

pub fn mode() -> EchoMode {
    match MODE.load(Ordering::Acquire) {
        0 => EchoMode::Legacy,
        2 => EchoMode::FullDuplex,
        _ => EchoMode::Phase1,
    }
}

/// Set the mode from JS (CaptureOptions.echoMode). Unknown strings are ignored.
pub fn set_mode_from_str(s: &str) {
    if let Some(m) = EchoMode::parse(s) {
        let prev = mode();
        MODE.store(m as u8, Ordering::Release);
        if prev != m {
            println!("[EchoControl] mode {} → {}", prev.as_str(), m.as_str());
        }
    } else {
        eprintln!("[EchoControl] ignoring unknown echo mode {:?}", s);
    }
}

fn env_f32(name: &str, default: f32) -> f32 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(default)
}

// Tunables (env-overridable for field tuning without rebuilds).
static GATE_HANGOVER_MS: Lazy<u64> = Lazy::new(|| env_u64("NATIVELY_GATE_HANGOVER_MS", 120));
/// Extra hangover tail when no positive alignment estimate is available
/// (covers quiet far-end passages + trailing reverb on reference-late rigs).
static GATE_TAIL_MS: Lazy<u64> = Lazy::new(|| env_u64("NATIVELY_GATE_TAIL_MS", 150));
static RENDER_ACTIVE_RMS: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_RENDER_ACTIVE_RMS", 15.0));
static ERLE_ENTER_DB: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_ERLE_ENTER_DB", 8.0));
static ERLE_EXIT_DB: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_ERLE_EXIT_DB", 5.0));
/// Above this ERLE the converged gate trusts AEC3 fully and stops ducking.
static ERLE_STRONG_DB: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_ERLE_STRONG_DB", 15.0));
static TALKOVER_RMS_RATIO: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_TALKOVER_RMS_RATIO", 3.0));
/// Minimum AEC evidence (Convergence ERLE EMA, dB) before the unconverged
/// talk-over escape may open the mic. With ERLE≈0 the "post-AEC residual" is
/// raw far-end speech — loud and voiced — so without this floor the escape
/// leaks every far-end onset. Mute wins when we cannot tell double-talk from
/// echo (accepted trade-off).
static TALKOVER_MIN_ERLE_DB: Lazy<f32> =
    Lazy::new(|| env_f32("NATIVELY_TALKOVER_MIN_ERLE_DB", 4.0));
/// A render frame within this window means the render pipeline is alive.
static RENDER_ALIVE_MS: Lazy<u64> = Lazy::new(|| env_u64("NATIVELY_RENDER_ALIVE_MS", 500));
/// How long after mic-session start the gate holds closed waiting for the
/// first render frame (SCK/tap init takes 5-7 s). After this, fail OPEN — a
/// broken system capture must never permanently mute the mic.
static RENDER_WAIT_MAX_MS: Lazy<u64> =
    Lazy::new(|| env_u64("NATIVELY_RENDER_WAIT_MAX_MS", 10_000));
static ALIGN_ENABLED: Lazy<bool> =
    Lazy::new(|| std::env::var("NATIVELY_ECHO_ALIGN").map(|v| v != "off").unwrap_or(true));

// ============================================================================
// Shared gate state (written by DSP threads, read anywhere)
// ============================================================================

/// Legacy gate: set by the system-audio SilenceSuppressor decisions
/// (Send → true, SendSilence/Suppress → false). Only consulted in Legacy mode.
pub static SPEAKER_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Counts 10 ms render frames pushed to the APM (stat; legacy warmup input).
pub static APM_RENDER_FRAMES: AtomicUsize = AtomicUsize::new(0);
pub const APM_WARMUP_FRAMES: usize = 10; // 100 ms — legacy mode only

/// Wall-clock ms (now_ms) of the last render frame whose RMS cleared
/// RENDER_ACTIVE_RMS. Drives the phase1/full_duplex gate hangover.
static LAST_RENDER_ACTIVE_MS: AtomicU64 = AtomicU64::new(0);
/// Wall-clock ms (now_ms) of the last render frame of ANY level (including
/// silence). Proves the render pipeline is alive — drives startup_hold.
static LAST_RENDER_FRAME_MS: AtomicU64 = AtomicU64::new(0);
/// Wall-clock ms (now_ms) when the current mic session started (0→1 capture
/// transition). Bounds how long startup_hold may keep the gate closed.
static MIC_SESSION_START_MS: AtomicU64 = AtomicU64::new(0);
/// One eprintln! per session when the render wait times out (fail-open).
static RENDER_WAIT_WARNED: AtomicBool = AtomicBool::new(false);

/// Render backend actually capturing (set by the system DSP thread after
/// SpeakerInput::new succeeds): 0 none, 1 core_audio_tap, 2 sck,
/// 3 wasapi_loopback.
static RENDER_BACKEND: AtomicU8 = AtomicU8::new(0);
const RENDER_BACKEND_SCK: u8 = 2;

/// Session alignment seed, RAW estimate space (i32::MIN = unseeded). Read by
/// MicGate::new so its AlignController measures divergence from the seed.
static ALIGN_SEED_RAW_MS: AtomicI32 = AtomicI32::new(i32::MIN);
/// Same seed in EFFECTIVE offset space (what stats report as align_seed_ms).
static ALIGN_SEED_EFF_MS: AtomicI32 = AtomicI32::new(i32::MIN);
/// ROUTE_GENERATION value at the moment the current seed was published. A
/// MicGate must only adopt the seed when the generation still matches —
/// otherwise the route watcher already zeroed the delay targets for a device
/// change and the seed belongs to the old route.
static ALIGN_SEED_GEN: AtomicU64 = AtomicU64::new(0);
/// Seed provided by JS (CaptureOptions.echoAlignSeedMs, EFFECTIVE space —
/// the persisted applied_align_offset_ms of a previous session). Set (or
/// CLEARED, when JS omits the seed — "start unseeded") on every mic-capture
/// construction, so a previous route's seed never leaks into a later
/// session. i32::MIN = none provided. NOTE: 0 is a REAL seed ("converged
/// with no alignment applied"), not "no seed".
static PENDING_ALIGN_SEED_MS: AtomicI32 = AtomicI32::new(i32::MIN);

static HEADPHONES_ACTIVE: AtomicBool = AtomicBool::new(false);
static ROUTE_INFO: Mutex<Option<OutputRouteInfo>> = Mutex::new(None);
/// Bumped on every output-route change; MicGate resets alignment/convergence
/// state when it observes a new generation (the echo path just changed).
static ROUTE_GENERATION: AtomicU64 = AtomicU64::new(0);
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);

/// Refcount of running MicrophoneCapture instances. The APM reset happens only
/// on the 0→1 transition so a settings audio-test cannot wipe a live meeting's
/// AEC state.
pub static ACTIVE_MIC_CAPTURES: AtomicUsize = AtomicUsize::new(0);

// Stats counters.
static FRAMES_TOTAL: AtomicU64 = AtomicU64::new(0);
static FRAMES_MUTED: AtomicU64 = AtomicU64::new(0);
static FRAMES_DUCKED: AtomicU64 = AtomicU64::new(0);
/// Frames where the talk-over escape held the mic open (diagnostic).
static TALKOVER_ESCAPES: AtomicU64 = AtomicU64::new(0);
/// Published gate state for stats: 0 bypass, 1 converged, 2 unconverged,
/// 3 legacy, 4 startup_hold, 5 converged_ducked.
static GATE_STATE: AtomicU8 = AtomicU8::new(2);
/// Convergence snapshot for stats (written by the mic thread's MicGate).
static CONVERGED_STAT: AtomicBool = AtomicBool::new(false);
static ERLE_EMA_BITS: AtomicU64 = AtomicU64::new(0); // f64 bits; 0 == 0.0

pub fn headphones_active() -> bool {
    HEADPHONES_ACTIVE.load(Ordering::Acquire)
}

fn rms_i16(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().step_by(4).map(|&s| (s as f64) * (s as f64)).sum();
    let count = samples.len().div_ceil(4);
    (sum / count as f64).sqrt() as f32
}

/// Called by the system-audio thread for EVERY resampled 16 kHz frame
/// (speech, silence — everything). Updates the RMS-driven gate timestamp and
/// pushes 10 ms envelope entries for the delay estimator.
pub fn note_render_frame(samples: &[i16], clock: &mut echo_align::EnvClock) {
    if samples.is_empty() {
        return;
    }
    // ANY frame (active or silent) proves the render pipeline is alive.
    LAST_RENDER_FRAME_MS.store(now_ms(), Ordering::Release);
    let ts = clock.stamp(now_ms(), samples.len());
    let mut active = false;
    for (i, sub) in samples.chunks(160).enumerate() {
        let r = rms_i16(sub);
        echo_align::push_render_env(ts + (i as u64) * echo_align::ENV_PERIOD_MS, r);
        if r >= *RENDER_ACTIVE_RMS {
            active = true;
        }
    }
    if active {
        LAST_RENDER_ACTIVE_MS.store(now_ms(), Ordering::Release);
    }
}

/// Called by the mic thread for every resampled 16 kHz frame BEFORE AEC —
/// the delay estimator correlates the raw echo against the render reference.
pub fn note_capture_frame(samples: &[i16], clock: &mut echo_align::EnvClock) {
    if samples.is_empty() {
        return;
    }
    let ts = clock.stamp(now_ms(), samples.len());
    for (i, sub) in samples.chunks(160).enumerate() {
        echo_align::push_capture_env(ts + (i as u64) * echo_align::ENV_PERIOD_MS, rms_i16(sub));
    }
}

/// Hangover window = base hangover + a margin covering the echo tail.
/// When the reference is EARLY (positive align estimate, the SCK case) the
/// acoustic echo trails the reference by that lead — extend the window by it
/// (clamped to 800 ms). Otherwise a fixed tail covers reverb + quiet passages
/// (on reference-late rigs the leading edge is already covered by the capture
/// DelayBuffer, since the gate decides on already-delayed capture frames).
fn gate_hangover_window_ms(last_estimate_ms: i32) -> u64 {
    let margin = if last_estimate_ms != i32::MIN && last_estimate_ms > 0 {
        (last_estimate_ms as u64).min(800)
    } else {
        *GATE_TAIL_MS
    };
    *GATE_HANGOVER_MS + margin
}

/// True while the speaker played audibly within the gate hangover window.
pub fn speaker_recently_active() -> bool {
    let last = LAST_RENDER_ACTIVE_MS.load(Ordering::Acquire);
    if last == 0 {
        return false;
    }
    let window = gate_hangover_window_ms(echo_align::LAST_ESTIMATE_MS.load(Ordering::Acquire));
    now_ms().saturating_sub(last) < window
}

/// True while the render pipeline delivered ANY frame within RENDER_ALIVE_MS.
pub fn render_pipeline_alive() -> bool {
    let last = LAST_RENDER_FRAME_MS.load(Ordering::Acquire);
    last != 0 && now_ms().saturating_sub(last) < *RENDER_ALIVE_MS
}

/// Startup/render-liveness policy for the full_duplex gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RenderAlivePolicy {
    /// Render frames flowing — run the normal converged/unconverged gate.
    Normal,
    /// No render frames yet and still within the startup wait — hold the
    /// gate closed (loud+VAD escape only; ERLE is unavailable without a
    /// render feed).
    Hold,
    /// Render never arrived (or died) past the wait budget — fail OPEN.
    FailOpen,
}

fn render_alive_policy(
    now: u64,
    session_start_ms: u64,
    last_render_frame_ms: u64,
    alive_window_ms: u64,
    wait_max_ms: u64,
) -> RenderAlivePolicy {
    let alive =
        last_render_frame_ms != 0 && now.saturating_sub(last_render_frame_ms) < alive_window_ms;
    if alive {
        RenderAlivePolicy::Normal
    } else if now.saturating_sub(session_start_ms) < wait_max_ms {
        RenderAlivePolicy::Hold
    } else {
        RenderAlivePolicy::FailOpen
    }
}

// ============================================================================
// Output-route watcher
// ============================================================================

/// Start the (single, process-wide) output-route poll thread. Reacts to
/// mid-meeting device changes (AirPods connect/disconnect) within ~2 s.
pub fn ensure_route_watcher(proc: Arc<Processor>) {
    if WATCHER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || {
        let mut last_kind: Option<RouteKind> = None;
        loop {
            let info = output_route::current_output_route();
            let hp = info.kind == RouteKind::Headphones;
            if last_kind != Some(info.kind) {
                println!(
                    "[EchoControl] output route: {} ({} · {:?})",
                    info.kind.as_str(),
                    info.transport,
                    info.name
                );
                HEADPHONES_ACTIVE.store(hp, Ordering::Release);
                if last_kind.is_some() {
                    // The physical echo path changed — old AEC filter state and
                    // delay estimates are invalid.
                    ROUTE_GENERATION.fetch_add(1, Ordering::AcqRel);
                    echo_align::reset_envelopes();
                    echo_align::reset_targets();
                    // The session seed belonged to the old route — drop it so
                    // a MicGate starting mid-change cannot adopt it (with the
                    // targets already zeroed above) and stats stop reporting
                    // a seed that is no longer applied.
                    ALIGN_SEED_RAW_MS.store(i32::MIN, Ordering::Release);
                    ALIGN_SEED_EFF_MS.store(i32::MIN, Ordering::Release);
                    if ACTIVE_MIC_CAPTURES.load(Ordering::Acquire) > 0 {
                        proc.reinitialize();
                        println!("[EchoControl] APM reset (output route changed)");
                    }
                }
                last_kind = Some(info.kind);
            }
            if let Ok(mut ri) = ROUTE_INFO.lock() {
                *ri = Some(info);
            }
            thread::sleep(Duration::from_secs(2));
        }
    });
}

// ============================================================================
// Convergence tracking (full_duplex)
// ============================================================================

/// One APM stats reading, decoupled from the crate type for testability.
#[derive(Debug, Clone, Copy, Default)]
pub struct StatsSample {
    pub erle_db: Option<f64>,
    pub delay_ms: Option<u32>,
    pub residual_echo_likelihood_recent_max: Option<f64>,
}

const ENTER_HOLD_MS: u64 = 2_000;
const EXIT_HOLD_MS: u64 = 1_500;
const DELAY_STABLE_STDDEV_MS: f64 = 20.0;
const RESIDUAL_ECHO_PANIC: f64 = 0.9;

pub struct Convergence {
    erle_ema: f64,
    delay_history: VecDeque<u32>,
    converged: bool,
    enter_hold_since: Option<u64>,
    exit_hold_since: Option<u64>,
}

impl Convergence {
    pub fn new() -> Self {
        Self {
            erle_ema: 0.0,
            delay_history: VecDeque::with_capacity(8),
            converged: false,
            enter_hold_since: None,
            exit_hold_since: None,
        }
    }

    pub fn converged(&self) -> bool {
        self.converged
    }

    pub fn erle_ema(&self) -> f64 {
        self.erle_ema
    }

    /// Force back to Unconverged (alignment shift, route change).
    pub fn invalidate(&mut self) {
        self.converged = false;
        self.enter_hold_since = None;
        self.exit_hold_since = None;
        self.delay_history.clear();
        self.erle_ema = 0.0;
    }

    fn delay_stable(&self) -> bool {
        if self.delay_history.len() < 8 {
            return false;
        }
        let n = self.delay_history.len() as f64;
        let mean = self.delay_history.iter().map(|&d| d as f64).sum::<f64>() / n;
        let var = self
            .delay_history
            .iter()
            .map(|&d| (d as f64 - mean).powi(2))
            .sum::<f64>()
            / n;
        var.sqrt() < DELAY_STABLE_STDDEV_MS
    }

    /// Feed one ~250 ms stats sample. Returns the new converged state.
    pub fn update(&mut self, now: u64, s: StatsSample) -> bool {
        if let Some(e) = s.erle_db {
            self.erle_ema = 0.7 * self.erle_ema + 0.3 * e;
        }
        if let Some(d) = s.delay_ms {
            self.delay_history.push_back(d);
            while self.delay_history.len() > 8 {
                self.delay_history.pop_front();
            }
        }

        if !self.converged {
            let criteria = self.erle_ema > *ERLE_ENTER_DB as f64 && self.delay_stable();
            if criteria {
                let since = *self.enter_hold_since.get_or_insert(now);
                if now.saturating_sub(since) >= ENTER_HOLD_MS {
                    self.converged = true;
                    self.exit_hold_since = None;
                    println!(
                        "[EchoGate] UNCONVERGED→CONVERGED erle={:.1}dB delay≈{}ms",
                        self.erle_ema,
                        self.delay_history.back().copied().unwrap_or(0)
                    );
                }
            } else {
                self.enter_hold_since = None;
            }
        } else {
            // Immediate exit on a residual-echo spike.
            if s.residual_echo_likelihood_recent_max
                .map(|r| r > RESIDUAL_ECHO_PANIC)
                .unwrap_or(false)
            {
                println!("[EchoGate] CONVERGED→UNCONVERGED (residual echo spike)");
                self.invalidate();
                return false;
            }
            // Timed exit on sustained low ERLE.
            if self.erle_ema < *ERLE_EXIT_DB as f64 {
                let since = *self.exit_hold_since.get_or_insert(now);
                if now.saturating_sub(since) >= EXIT_HOLD_MS {
                    println!(
                        "[EchoGate] CONVERGED→UNCONVERGED erle={:.1}dB",
                        self.erle_ema
                    );
                    self.invalidate();
                    return false;
                }
            } else {
                self.exit_hold_since = None;
            }
        }
        self.converged
    }
}

impl Default for Convergence {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Talk-over escape (full_duplex, Unconverged)
// ============================================================================

/// Recovers loud near-end speech while the hard gate is engaged: if the
/// post-AEC frame is well above the residual-echo baseline AND WebRTC VAD
/// calls it voice for ≥6 consecutive frames (120 ms), emit it anyway.
struct TalkOverDetector {
    echo_baseline: f32,
    voice_run: u32,
    escape_hold: u32,
    vad: Vad,
}

const TALKOVER_MIN_BASELINE: f32 = 30.0;
const TALKOVER_RUN_FRAMES: u32 = 6; // 120 ms of sustained voiced speech
const TALKOVER_HOLD_FRAMES: u32 = 10; // 200 ms of grace once triggered

impl TalkOverDetector {
    fn new() -> Self {
        Self {
            echo_baseline: TALKOVER_MIN_BASELINE,
            voice_run: 0,
            escape_hold: 0,
            vad: Vad::new_with_rate_and_mode(VadSampleRate::Rate16kHz, VadMode::Aggressive),
        }
    }

    /// `cleaned` is the post-AEC 20 ms frame; call only while speaker active.
    fn check(&mut self, cleaned: &[i16]) -> bool {
        self.check_inner(cleaned, true)
    }

    /// startup_hold variant: no render frames are flowing yet, so there is no
    /// post-AEC residual to baseline against — the adaptive baseline must NOT
    /// absorb the user's sustained speech (with the slow 0.02/frame up-track
    /// it would swallow a continuous greeting ~400 ms in and close the escape
    /// mid-sentence, chopping the exact audio the hold escape exists to pass
    /// in ~120 ms). The baseline still tracks DOWN fast so the loudness floor
    /// follows the quiet-room level.
    fn check_hold(&mut self, cleaned: &[i16]) -> bool {
        self.check_inner(cleaned, false)
    }

    fn check_inner(&mut self, cleaned: &[i16], absorb_up: bool) -> bool {
        let rms = rms_i16(cleaned);

        // Asymmetric EMA baseline of the residual: tracks down fast, up slowly
        // (never up during startup_hold — see check_hold).
        if rms < self.echo_baseline {
            self.echo_baseline += 0.2 * (rms - self.echo_baseline);
        } else if absorb_up {
            self.echo_baseline += 0.02 * (rms - self.echo_baseline);
        }
        self.echo_baseline = self.echo_baseline.max(1.0);

        let loud = rms > *TALKOVER_RMS_RATIO * self.echo_baseline.max(TALKOVER_MIN_BASELINE);
        let voiced = loud && {
            let take = cleaned.len().min(480);
            let target = if take >= 480 {
                480
            } else if take >= 320 {
                320
            } else if take >= 160 {
                160
            } else {
                0
            };
            target > 0 && self.vad.is_voice_segment(&cleaned[..target]).unwrap_or(false)
        };

        if voiced {
            self.voice_run += 1;
        } else {
            self.voice_run = 0;
        }

        if self.voice_run >= TALKOVER_RUN_FRAMES {
            self.escape_hold = TALKOVER_HOLD_FRAMES;
        } else if self.escape_hold > 0 {
            self.escape_hold -= 1;
        }
        self.escape_hold > 0
    }

    fn reset_frame(&mut self) {
        self.voice_run = 0;
        if self.escape_hold > 0 {
            self.escape_hold -= 1;
        }
    }
}

// ============================================================================
// GateAction — per-frame verdict
// ============================================================================

/// What the mic DSP loop must do with one post-AEC frame.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum GateAction {
    /// Emit the cleaned frame unchanged.
    Emit,
    /// Emit the cleaned frame scaled by the gain (converged residual duck).
    Duck(f32),
    /// Emit zeros.
    Mute,
}

/// Converged duck gain: −12 dB on top of ~10 dB ERLE ≈ 22 dB total on
/// residual far-end passages.
const DUCK_GAIN: f32 = 0.25;

/// Converged-state verdict. Residual far-end passages are ducked while AEC3's
/// cancellation is only moderate; sustained genuine double-talk upgrades to
/// Emit via the talk-over escape.
fn converged_action(speaker_active: bool, erle_ema: f64, escape: bool) -> GateAction {
    if speaker_active && erle_ema < *ERLE_STRONG_DB as f64 && !escape {
        GateAction::Duck(DUCK_GAIN)
    } else {
        GateAction::Emit
    }
}

/// Unconverged-state verdict. The talk-over escape may only open the mic once
/// there is AEC evidence (ERLE EMA ≥ TALKOVER_MIN_ERLE_DB) — with ERLE≈0 the
/// escape cannot distinguish double-talk from raw far-end speech.
fn unconverged_action(speaker_active: bool, erle_ema: f64, escape: bool) -> GateAction {
    if !speaker_active {
        return GateAction::Emit;
    }
    if escape && erle_ema >= *TALKOVER_MIN_ERLE_DB as f64 {
        GateAction::Emit
    } else {
        GateAction::Mute
    }
}

// ============================================================================
// MicGate — per-mic-thread gate driver
// ============================================================================

const STATS_SAMPLE_INTERVAL_MS: u64 = 250;
const CORRELATOR_INTERVAL_MS: u64 = 2_000;

/// True when the correlator should run: alignment enabled, NOT converged
/// (freeze — never disturb a working AEC state; re-estimation resumes
/// automatically when convergence is lost), and the interval elapsed.
fn correlator_due(align_enabled: bool, converged: bool, now: u64, last_corr_ms: u64) -> bool {
    align_enabled && !converged && now.saturating_sub(last_corr_ms) >= CORRELATOR_INTERVAL_MS
}

/// True when a published session seed may be adopted by a starting MicGate:
/// a seed exists AND it was published under the route generation the gate is
/// starting with (a route change in between invalidated it).
fn seed_valid_for_generation(seed_raw: i32, seed_gen: u64, current_gen: u64) -> bool {
    seed_raw != i32::MIN && seed_gen == current_gen
}

/// Owned by the microphone DSP thread. Every processed frame goes through
/// `decide()`, which returns the GateAction for that frame.
pub struct MicGate {
    proc: Arc<Processor>,
    convergence: Convergence,
    talkover: TalkOverDetector,
    align: echo_align::AlignController,
    last_stats_ms: u64,
    last_corr_ms: u64,
    last_muted: bool,
    route_generation: u64,
}

impl MicGate {
    pub fn new(proc: Arc<Processor>) -> Self {
        let route_generation = ROUTE_GENERATION.load(Ordering::Acquire);
        // Pick up the session alignment seed (published by on_mic_start) so
        // the controller measures divergence from it instead of from 0 — but
        // only when it was published for the CURRENT route generation. If the
        // route watcher observed a device change between on_mic_start and
        // this point, it already zeroed the delay targets; adopting the stale
        // seed here would leave the controller "confirming" an alignment that
        // is no longer applied (alignment silently disabled all session).
        let seed = ALIGN_SEED_RAW_MS.load(Ordering::Acquire);
        let align = if seed_valid_for_generation(
            seed,
            ALIGN_SEED_GEN.load(Ordering::Acquire),
            route_generation,
        ) {
            echo_align::AlignController::with_seed(seed)
        } else {
            echo_align::AlignController::new()
        };
        Self {
            proc,
            convergence: Convergence::new(),
            talkover: TalkOverDetector::new(),
            align,
            last_stats_ms: 0,
            last_corr_ms: 0,
            last_muted: false,
            route_generation,
        }
    }

    fn sample_stats(&mut self, now: u64) {
        if now.saturating_sub(self.last_stats_ms) < STATS_SAMPLE_INTERVAL_MS {
            return;
        }
        self.last_stats_ms = now;
        let stats = self.proc.get_stats();
        self.convergence.update(
            now,
            StatsSample {
                erle_db: stats.echo_return_loss_enhancement,
                delay_ms: stats.delay_ms,
                residual_echo_likelihood_recent_max: stats.residual_echo_likelihood_recent_max,
            },
        );
    }

    fn run_correlator(&mut self, now: u64) {
        // Frozen while converged: the one field-observed convergence success
        // was destroyed by a divergent re-estimate arriving 2 s later. A
        // converged AEC state is the ground truth — never disturb it. On
        // convergence loss (Convergence::update exits, route change) the
        // correlator resumes automatically, and the last applied delay stays
        // in place as the best prior.
        if !correlator_due(*ALIGN_ENABLED, self.convergence.converged(), now, self.last_corr_ms) {
            return;
        }
        self.last_corr_ms = now;
        if let Some(est) = echo_align::estimate_from_rings() {
            if let Some(applied) = self.align.feed(now, est) {
                echo_align::AlignController::publish(applied);
                println!(
                    "[EchoAlign] offset estimate {}ms → render_delay={}ms capture_delay={}ms",
                    applied,
                    echo_align::TARGET_RENDER_DELAY_MS.load(Ordering::Acquire),
                    echo_align::TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire),
                );
                // Re-converge against the newly aligned reference.
                self.convergence.invalidate();
            }
        }
    }

    fn check_route_generation(&mut self) {
        let gen = ROUTE_GENERATION.load(Ordering::Acquire);
        if gen != self.route_generation {
            self.route_generation = gen;
            self.convergence.invalidate();
            self.align = echo_align::AlignController::new();
            echo_align::AlignController::publish(0);
        }
    }

    /// Decide the fate of one post-AEC mic frame.
    pub fn decide(&mut self, cleaned: &[i16]) -> GateAction {
        let now = now_ms();
        let m = mode();
        self.check_route_generation();

        let action = match m {
            EchoMode::Legacy => {
                GATE_STATE.store(3, Ordering::Release);
                let speaker_on = SPEAKER_ACTIVE.load(Ordering::Acquire);
                let warming_up =
                    APM_RENDER_FRAMES.load(Ordering::Acquire) < APM_WARMUP_FRAMES;
                if speaker_on || warming_up {
                    GateAction::Mute
                } else {
                    GateAction::Emit
                }
            }
            EchoMode::Phase1 => {
                if headphones_active() {
                    GATE_STATE.store(0, Ordering::Release);
                    GateAction::Emit
                } else {
                    GATE_STATE.store(2, Ordering::Release);
                    if speaker_recently_active() {
                        GateAction::Mute
                    } else {
                        GateAction::Emit
                    }
                }
            }
            EchoMode::FullDuplex => {
                self.sample_stats(now);
                if headphones_active() {
                    GATE_STATE.store(0, Ordering::Release);
                    self.talkover.reset_frame();
                    GateAction::Emit
                } else {
                    self.decide_full_duplex(now, cleaned)
                }
            }
        };

        // Publish convergence snapshot for pipeline_stats_json.
        CONVERGED_STAT.store(self.convergence.converged(), Ordering::Release);
        ERLE_EMA_BITS.store(self.convergence.erle_ema().to_bits(), Ordering::Release);

        FRAMES_TOTAL.fetch_add(1, Ordering::Relaxed);
        match action {
            GateAction::Mute => {
                FRAMES_MUTED.fetch_add(1, Ordering::Relaxed);
            }
            GateAction::Duck(_) => {
                FRAMES_DUCKED.fetch_add(1, Ordering::Relaxed);
            }
            GateAction::Emit => {}
        }
        let mute = action == GateAction::Mute;
        if mute != self.last_muted {
            self.last_muted = mute;
            self.proc.set_output_will_be_muted(mute);
        }
        action
    }

    /// full_duplex speaker-path policy (headphone bypass already handled).
    fn decide_full_duplex(&mut self, now: u64, cleaned: &[i16]) -> GateAction {
        match render_alive_policy(
            now,
            MIC_SESSION_START_MS.load(Ordering::Acquire),
            LAST_RENDER_FRAME_MS.load(Ordering::Acquire),
            *RENDER_ALIVE_MS,
            *RENDER_WAIT_MAX_MS,
        ) {
            RenderAlivePolicy::Hold => {
                // startup_hold: SCK/tap init takes 5-7 s during which the gate
                // used to sit fully open and leak the far end into STT. ERLE
                // is unavailable without a render feed, so the escape here is
                // loud+VAD only — the user's real greeting passes in ~120 ms
                // (check_hold: the baseline must not absorb sustained speech).
                GATE_STATE.store(4, Ordering::Release);
                if self.talkover.check_hold(cleaned) {
                    TALKOVER_ESCAPES.fetch_add(1, Ordering::Relaxed);
                    GateAction::Emit
                } else {
                    GateAction::Mute
                }
            }
            policy => {
                if policy == RenderAlivePolicy::FailOpen
                    && !RENDER_WAIT_WARNED.swap(true, Ordering::AcqRel)
                {
                    eprintln!(
                        "[EchoGate] render pipeline produced no frames within {}ms — failing OPEN (mic will not be muted; echo protection degraded)",
                        *RENDER_WAIT_MAX_MS
                    );
                }
                self.run_correlator(now);
                let speaker = speaker_recently_active();
                let escape = if speaker {
                    self.talkover.check(cleaned)
                } else {
                    self.talkover.reset_frame();
                    false
                };
                let erle_ema = self.convergence.erle_ema();
                if self.convergence.converged() {
                    let action = converged_action(speaker, erle_ema, escape);
                    // Count the escape only when it upgraded a would-be duck.
                    if escape && speaker && erle_ema < *ERLE_STRONG_DB as f64 {
                        TALKOVER_ESCAPES.fetch_add(1, Ordering::Relaxed);
                    }
                    GATE_STATE.store(
                        if matches!(action, GateAction::Duck(_)) { 5 } else { 1 },
                        Ordering::Release,
                    );
                    action
                } else {
                    GATE_STATE.store(2, Ordering::Release);
                    let action = unconverged_action(speaker, erle_ema, escape);
                    if escape && action == GateAction::Emit {
                        TALKOVER_ESCAPES.fetch_add(1, Ordering::Relaxed);
                    }
                    action
                }
            }
        }
    }
}

// ============================================================================
// Lifecycle + stats
// ============================================================================

/// Store the JS-provided alignment seed (CaptureOptions.echoAlignSeedMs,
/// EFFECTIVE offset space — the applied_align_offset_ms value a previous
/// session persisted). Called on EVERY mic-capture construction: `None`
/// (JS omitted the seed — no persisted value for the current route) CLEARS
/// any previous seed so it cannot leak into a route it was never measured
/// on. `Some(0)` is a real seed ("converged with no alignment applied") and
/// must not fall through to the backend default. Applied on the next 0→1
/// mic-session transition.
pub fn set_pending_align_seed(seed_effective_ms: Option<i32>) {
    match seed_effective_ms {
        Some(s) if s != i32::MIN => {
            PENDING_ALIGN_SEED_MS.store(s, Ordering::Release);
            println!("[EchoAlign] pending session seed {}ms (effective)", s);
        }
        _ => {
            if PENDING_ALIGN_SEED_MS.swap(i32::MIN, Ordering::AcqRel) != i32::MIN {
                println!("[EchoAlign] pending session seed cleared (none provided)");
            }
        }
    }
}

/// Record which render backend is actually capturing. Called by the system
/// DSP thread right after SpeakerInput::new succeeds.
pub fn set_render_backend(name: &str) {
    let v = match name {
        "core_audio_tap" => 1,
        "sck" => RENDER_BACKEND_SCK,
        "wasapi_loopback" => 3,
        _ => 0,
    };
    RENDER_BACKEND.store(v, Ordering::Release);
    println!("[EchoControl] render backend: {}", render_backend_str());
}

fn render_backend_str() -> &'static str {
    match RENDER_BACKEND.load(Ordering::Acquire) {
        1 => "core_audio_tap",
        2 => "sck",
        3 => "wasapi_loopback",
        _ => "none",
    }
}

/// Signed effective alignment offset currently applied to the delay buffers:
/// positive = render delayed by that many ms, negative = capture delayed.
/// JS persists this and feeds it back as CaptureOptions.echoAlignSeedMs.
fn applied_align_offset_ms() -> i32 {
    let rd = echo_align::TARGET_RENDER_DELAY_MS.load(Ordering::Acquire);
    let cd = echo_align::TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire);
    if rd > 0 {
        rd
    } else {
        -cd
    }
}

/// Pick the RAW seed for a new session, if any. full_duplex ONLY — the
/// legacy/phase1 rollback modes always ran with zero delay targets and must
/// stay bit-identical (their fixed stream_delay hint assumes an undelayed
/// reference). Within full_duplex: the JS-provided seed wins when present
/// (applied verbatim, effective space; 0 is a real "no alignment needed"
/// seed). Otherwise, if the render backend is already known (system capture
/// started before the mic), apply its default: SCK reference leads by a
/// measured ~+324 ms (raw estimate space); core_audio_tap gets NO guess —
/// its offset is machine-dependent (observed NEGATIVE in the field) and must
/// come from persisted telemetry. If the backend is not known yet, start
/// unseeded.
fn seed_raw_for_session(m: EchoMode, pending_effective: i32, backend_is_sck: bool) -> Option<i32> {
    if m != EchoMode::FullDuplex {
        None
    } else if pending_effective != i32::MIN {
        Some(echo_align::seed_raw_from_effective(pending_effective))
    } else if backend_is_sck {
        Some(324)
    } else {
        None
    }
}

/// Pre-seed the alignment targets for a new session (policy in
/// seed_raw_for_session). Non-full_duplex modes clear the seed state so the
/// targets stay at the zeros reset_targets() just published.
fn seed_alignment() {
    let gen = ROUTE_GENERATION.load(Ordering::Acquire);
    let pending = PENDING_ALIGN_SEED_MS.load(Ordering::Acquire);
    let raw = seed_raw_for_session(
        mode(),
        pending,
        RENDER_BACKEND.load(Ordering::Acquire) == RENDER_BACKEND_SCK,
    );
    match raw {
        Some(r) => {
            echo_align::AlignController::publish(r);
            let eff = applied_align_offset_ms();
            ALIGN_SEED_RAW_MS.store(r, Ordering::Release);
            ALIGN_SEED_EFF_MS.store(eff, Ordering::Release);
            ALIGN_SEED_GEN.store(gen, Ordering::Release);
            println!(
                "[EchoAlign] session seeded: raw={}ms effective={}ms (render_delay={}ms capture_delay={}ms)",
                r,
                eff,
                echo_align::TARGET_RENDER_DELAY_MS.load(Ordering::Acquire),
                echo_align::TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire),
            );
        }
        None => {
            ALIGN_SEED_RAW_MS.store(i32::MIN, Ordering::Release);
            ALIGN_SEED_EFF_MS.store(i32::MIN, Ordering::Release);
        }
    }
}

/// Register a starting MicrophoneCapture. Resets APM/alignment state only on
/// the 0→1 transition (i.e., a genuinely new session — not a parallel
/// settings audio-test).
pub fn on_mic_start(proc: &Processor) {
    let prev = ACTIVE_MIC_CAPTURES.fetch_add(1, Ordering::AcqRel);
    if prev == 0 {
        proc.reinitialize();
        APM_RENDER_FRAMES.store(0, Ordering::SeqCst);
        FRAMES_TOTAL.store(0, Ordering::Relaxed);
        FRAMES_MUTED.store(0, Ordering::Relaxed);
        FRAMES_DUCKED.store(0, Ordering::Relaxed);
        TALKOVER_ESCAPES.store(0, Ordering::Relaxed);
        MIC_SESSION_START_MS.store(now_ms(), Ordering::Release);
        RENDER_WAIT_WARNED.store(false, Ordering::Release);
        echo_align::reset_envelopes();
        echo_align::reset_targets();
        // Seed AFTER the resets so the published targets survive. Seeding is
        // full_duplex-only; in legacy/phase1 this clears the seed state and
        // leaves the targets at zero (rollback modes must not change).
        seed_alignment();
        println!("[WebRtcAec] APM reset for new session");
    } else {
        println!(
            "[EchoControl] mic capture started with {} already active — APM state preserved",
            prev
        );
    }
}

pub fn on_mic_stop() {
    // Guard against underflow if stop() is called twice.
    let _ = ACTIVE_MIC_CAPTURES.fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| {
        if v > 0 {
            Some(v - 1)
        } else {
            None
        }
    });
}

/// Snapshot the whole pipeline as JSON (napi: getAudioPipelineStats()).
pub fn pipeline_stats_json(proc: &Processor) -> String {
    let stats = proc.get_stats();
    let total = FRAMES_TOTAL.load(Ordering::Relaxed);
    let muted = FRAMES_MUTED.load(Ordering::Relaxed);
    let gate_state = match GATE_STATE.load(Ordering::Acquire) {
        0 => "headphone_bypass",
        1 => "converged",
        3 => "legacy",
        4 => "startup_hold",
        5 => "converged_ducked",
        _ => "unconverged",
    };
    let (route_transport, route_name) = ROUTE_INFO
        .lock()
        .ok()
        .and_then(|ri| ri.clone())
        .map(|r| (r.transport, r.name))
        .unwrap_or_else(|| ("unknown".to_string(), String::new()));
    let last_est = echo_align::LAST_ESTIMATE_MS.load(Ordering::Acquire);
    let seed_eff = ALIGN_SEED_EFF_MS.load(Ordering::Acquire);
    let converged = CONVERGED_STAT.load(Ordering::Acquire);
    let last_render = LAST_RENDER_FRAME_MS.load(Ordering::Acquire);

    serde_json::json!({
        "mode": mode().as_str(),
        "gate_state": gate_state,
        "headphones": headphones_active(),
        "route_transport": route_transport,
        "route_name": route_name,
        "speaker_active": speaker_recently_active(),
        "erle_db": stats.echo_return_loss_enhancement,
        "erl_db": stats.echo_return_loss,
        // Our Convergence EMA — distinct from the raw APM erle_db passthrough
        // (which sits frozen at its init floor while AEC3 is not converging).
        "erle_ema": f64::from_bits(ERLE_EMA_BITS.load(Ordering::Acquire)),
        "converged": converged,
        "delay_ms": stats.delay_ms,
        "residual_echo_likelihood": stats.residual_echo_likelihood,
        "residual_echo_likelihood_recent_max": stats.residual_echo_likelihood_recent_max,
        "frames_total": total,
        "frames_muted": muted,
        "frames_ducked": FRAMES_DUCKED.load(Ordering::Relaxed),
        "muted_pct": if total > 0 { muted as f64 * 100.0 / total as f64 } else { 0.0 },
        "talkover_escapes": TALKOVER_ESCAPES.load(Ordering::Relaxed),
        "render_frames": APM_RENDER_FRAMES.load(Ordering::Acquire),
        "render_backend": render_backend_str(),
        "render_pipeline_alive": render_pipeline_alive(),
        "last_render_frame_age_ms":
            if last_render == 0 { None } else { Some(now_ms().saturating_sub(last_render)) },
        "estimated_offset_ms": if last_est == i32::MIN { None } else { Some(last_est) },
        "applied_render_delay_ms": echo_align::TARGET_RENDER_DELAY_MS.load(Ordering::Acquire),
        "applied_capture_delay_ms": echo_align::TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire),
        // SIGNED effective offset (positive = render delayed, negative =
        // capture delayed). JS persists this; round-trips via echoAlignSeedMs.
        "applied_align_offset_ms": applied_align_offset_ms(),
        "align_seed_ms": if seed_eff == i32::MIN { None } else { Some(seed_eff) },
        "align_frozen": converged && *ALIGN_ENABLED,
        "active_mic_captures": ACTIVE_MIC_CAPTURES.load(Ordering::Acquire),
    })
    .to_string()
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn good_sample() -> StatsSample {
        StatsSample {
            erle_db: Some(12.0),
            delay_ms: Some(320),
            residual_echo_likelihood_recent_max: Some(0.1),
        }
    }

    #[test]
    fn convergence_requires_sustained_good_stats() {
        let mut c = Convergence::new();
        let mut t = 0u64;
        // 8 samples to fill delay history + ERLE EMA, then the 2 s hold.
        for _ in 0..8 {
            c.update(t, good_sample());
            t += 250;
        }
        assert!(!c.converged(), "must not converge before hold elapses");
        for _ in 0..9 {
            c.update(t, good_sample());
            t += 250;
        }
        assert!(c.converged(), "should converge after sustained good stats");
    }

    #[test]
    fn convergence_exits_on_residual_echo_spike() {
        let mut c = Convergence::new();
        let mut t = 0u64;
        for _ in 0..20 {
            c.update(t, good_sample());
            t += 250;
        }
        assert!(c.converged());
        let spike = StatsSample {
            erle_db: Some(12.0),
            delay_ms: Some(320),
            residual_echo_likelihood_recent_max: Some(0.95),
        };
        assert!(!c.update(t, spike), "spike must exit immediately");
    }

    #[test]
    fn convergence_exits_on_sustained_low_erle() {
        let mut c = Convergence::new();
        let mut t = 0u64;
        for _ in 0..20 {
            c.update(t, good_sample());
            t += 250;
        }
        assert!(c.converged());
        let bad = StatsSample {
            erle_db: Some(0.5),
            delay_ms: Some(320),
            residual_echo_likelihood_recent_max: Some(0.2),
        };
        // ERLE EMA decays below the exit threshold, then the 1.5 s hold runs.
        let mut exited = false;
        for _ in 0..40 {
            if !c.update(t, bad) {
                exited = true;
                break;
            }
            t += 250;
        }
        assert!(exited, "sustained low ERLE must exit");
    }

    #[test]
    fn unstable_delay_blocks_convergence() {
        let mut c = Convergence::new();
        let mut t = 0u64;
        for i in 0..40u32 {
            let s = StatsSample {
                erle_db: Some(12.0),
                delay_ms: Some(if i % 2 == 0 { 100 } else { 400 }),
                residual_echo_likelihood_recent_max: Some(0.1),
            };
            c.update(t, s);
            t += 250;
        }
        assert!(!c.converged(), "wildly unstable delay must block convergence");
    }

    #[test]
    fn mode_parsing() {
        assert_eq!(EchoMode::parse("legacy"), Some(EchoMode::Legacy));
        assert_eq!(EchoMode::parse("Phase1"), Some(EchoMode::Phase1));
        assert_eq!(EchoMode::parse("full_duplex"), Some(EchoMode::FullDuplex));
        assert_eq!(EchoMode::parse("FULL-DUPLEX"), Some(EchoMode::FullDuplex));
        assert_eq!(EchoMode::parse("bogus"), None);
    }

    #[test]
    fn mic_refcount_guards_underflow() {
        // Isolated from other tests: only checks underflow behavior.
        ACTIVE_MIC_CAPTURES.store(0, Ordering::SeqCst);
        on_mic_stop();
        assert_eq!(ACTIVE_MIC_CAPTURES.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn startup_hold_policy_transitions() {
        const ALIVE: u64 = 500;
        const WAIT: u64 = 10_000;
        // Session started, no render frame ever → hold while within the wait.
        assert_eq!(render_alive_policy(1_000, 500, 0, ALIVE, WAIT), RenderAlivePolicy::Hold);
        assert_eq!(render_alive_policy(10_400, 500, 0, ALIVE, WAIT), RenderAlivePolicy::Hold);
        // Wait budget exhausted with no render → fail OPEN.
        assert_eq!(
            render_alive_policy(10_600, 500, 0, ALIVE, WAIT),
            RenderAlivePolicy::FailOpen
        );
        // Fresh render frame → normal gate.
        assert_eq!(
            render_alive_policy(6_000, 500, 5_800, ALIVE, WAIT),
            RenderAlivePolicy::Normal
        );
        // Render went stale but still inside the wait window → hold again.
        assert_eq!(
            render_alive_policy(6_000, 500, 5_000, ALIVE, WAIT),
            RenderAlivePolicy::Hold
        );
        // Render died mid-meeting long after start → fail OPEN, never a
        // permanent mute.
        assert_eq!(
            render_alive_policy(60_000, 500, 30_000, ALIVE, WAIT),
            RenderAlivePolicy::FailOpen
        );
    }

    #[test]
    fn correlator_frozen_while_converged() {
        // Due: aligned interval elapsed, not converged.
        assert!(correlator_due(true, false, 10_000, 0));
        // Frozen while converged — the highest-value stability rule.
        assert!(!correlator_due(true, true, 10_000, 0));
        // Disabled alignment never runs.
        assert!(!correlator_due(false, false, 10_000, 0));
        // Interval not elapsed yet.
        assert!(!correlator_due(true, false, 1_000, 0));
    }

    #[test]
    fn hangover_window_uses_estimate_margin() {
        // Positive estimate (reference early): margin = estimate, clamped.
        assert_eq!(gate_hangover_window_ms(300), *GATE_HANGOVER_MS + 300);
        assert_eq!(gate_hangover_window_ms(2_000), *GATE_HANGOVER_MS + 800);
        // Negative / zero / unknown estimate: fixed tail.
        assert_eq!(gate_hangover_window_ms(-90), *GATE_HANGOVER_MS + *GATE_TAIL_MS);
        assert_eq!(gate_hangover_window_ms(0), *GATE_HANGOVER_MS + *GATE_TAIL_MS);
        assert_eq!(gate_hangover_window_ms(i32::MIN), *GATE_HANGOVER_MS + *GATE_TAIL_MS);
    }

    #[test]
    fn seed_selection_policy() {
        // Rollback modes NEVER seed — not from a JS seed, not from the SCK
        // backend default (legacy/phase1 must keep zero delay targets).
        assert_eq!(seed_raw_for_session(EchoMode::Legacy, 284, true), None);
        assert_eq!(seed_raw_for_session(EchoMode::Legacy, i32::MIN, true), None);
        assert_eq!(seed_raw_for_session(EchoMode::Phase1, -90, true), None);
        assert_eq!(seed_raw_for_session(EchoMode::Phase1, i32::MIN, true), None);

        // full_duplex: the JS seed wins verbatim — including 0, which means
        // "converged with no alignment applied" and must NOT fall through to
        // the SCK backend default.
        assert_eq!(
            seed_raw_for_session(EchoMode::FullDuplex, 284, true),
            Some(echo_align::seed_raw_from_effective(284))
        );
        assert_eq!(
            seed_raw_for_session(EchoMode::FullDuplex, 0, true),
            Some(echo_align::seed_raw_from_effective(0))
        );
        assert_eq!(
            seed_raw_for_session(EchoMode::FullDuplex, -90, false),
            Some(echo_align::seed_raw_from_effective(-90))
        );

        // No JS seed: backend default only for SCK, else unseeded.
        assert_eq!(seed_raw_for_session(EchoMode::FullDuplex, i32::MIN, true), Some(324));
        assert_eq!(seed_raw_for_session(EchoMode::FullDuplex, i32::MIN, false), None);
    }

    #[test]
    fn seed_adoption_requires_matching_route_generation() {
        // Seed published under generation 3, gate starting at generation 3.
        assert!(seed_valid_for_generation(324, 3, 3));
        // Route changed between on_mic_start and MicGate::new → stale seed.
        assert!(!seed_valid_for_generation(324, 3, 4));
        // No seed at all.
        assert!(!seed_valid_for_generation(i32::MIN, 3, 3));
    }

    #[test]
    fn talkover_hold_does_not_absorb_sustained_speech() {
        // A continuous 20 ms frame at speech level (rms == 5000).
        let loud: Vec<i16> = vec![5000; 320];

        // startup_hold: 2 s of sustained speech must leave the baseline at
        // the floor — 'loud' (rms > ratio*baseline) stays true, so the escape
        // never collapses mid-greeting.
        let mut hold = TalkOverDetector::new();
        for _ in 0..100 {
            hold.check_hold(&loud);
        }
        assert!(
            hold.echo_baseline <= TALKOVER_MIN_BASELINE,
            "hold baseline absorbed sustained speech: {}",
            hold.echo_baseline
        );

        // Normal check keeps the slow up-track (residual-echo tracking).
        let mut normal = TalkOverDetector::new();
        for _ in 0..100 {
            normal.check(&loud);
        }
        assert!(
            normal.echo_baseline > TALKOVER_MIN_BASELINE,
            "normal baseline must track up: {}",
            normal.echo_baseline
        );

        // Both variants still track DOWN toward a quiet floor.
        let quiet: Vec<i16> = vec![4; 320];
        let mut down = TalkOverDetector::new();
        for _ in 0..100 {
            down.check_hold(&quiet);
        }
        assert!(down.echo_baseline < TALKOVER_MIN_BASELINE);
    }

    #[test]
    fn gate_action_mapping() {
        // Converged: residual far-end passages duck while ERLE is moderate…
        assert_eq!(converged_action(true, 10.0, false), GateAction::Duck(DUCK_GAIN));
        // …strong ERLE trusts AEC3 fully…
        assert_eq!(converged_action(true, 20.0, false), GateAction::Emit);
        // …double-talk (escape) upgrades to Emit, idle speaker emits.
        assert_eq!(converged_action(true, 10.0, true), GateAction::Emit);
        assert_eq!(converged_action(false, 0.0, false), GateAction::Emit);

        // Unconverged: the escape needs AEC evidence (ERLE ≥ 4 dB default).
        assert_eq!(unconverged_action(true, 0.0, true), GateAction::Mute);
        assert_eq!(unconverged_action(true, 6.0, true), GateAction::Emit);
        assert_eq!(unconverged_action(true, 6.0, false), GateAction::Mute);
        assert_eq!(unconverged_action(false, 0.0, false), GateAction::Emit);
    }
}
