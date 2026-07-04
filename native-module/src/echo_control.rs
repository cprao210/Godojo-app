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
//                  open even while the far end speaks. Falls back to the hard
//                  gate whenever convergence is lost, with a talk-over escape
//                  hatch so loud near-end speech still gets through.
//
// Mode source of truth: CaptureOptions.echoMode from JS, falling back to the
// NATIVELY_ECHO_MODE env var, falling back to phase1.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use webrtc_audio_processing::Processor;
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

static MODE: Lazy<AtomicU8> = Lazy::new(|| {
    let m = std::env::var("NATIVELY_ECHO_MODE")
        .ok()
        .and_then(|v| EchoMode::parse(&v))
        .unwrap_or(EchoMode::Phase1);
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
static RENDER_ACTIVE_RMS: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_RENDER_ACTIVE_RMS", 25.0));
static ERLE_ENTER_DB: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_ERLE_ENTER_DB", 8.0));
static ERLE_EXIT_DB: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_ERLE_EXIT_DB", 3.0));
static TALKOVER_RMS_RATIO: Lazy<f32> = Lazy::new(|| env_f32("NATIVELY_TALKOVER_RMS_RATIO", 2.0));
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
/// Published gate state for stats: 0 bypass, 1 converged, 2 unconverged, 3 legacy.
static GATE_STATE: AtomicU8 = AtomicU8::new(2);

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

/// True while the speaker played audibly within the gate hangover window.
pub fn speaker_recently_active() -> bool {
    let last = LAST_RENDER_ACTIVE_MS.load(Ordering::Acquire);
    if last == 0 {
        return false;
    }
    now_ms().saturating_sub(last) < *GATE_HANGOVER_MS
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
/// calls it voice for ≥3 consecutive frames, emit it anyway.
struct TalkOverDetector {
    echo_baseline: f32,
    voice_run: u32,
    escape_hold: u32,
    vad: Vad,
}

const TALKOVER_MIN_BASELINE: f32 = 30.0;
const TALKOVER_RUN_FRAMES: u32 = 3;
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
        let rms = rms_i16(cleaned);

        // Asymmetric EMA baseline of the residual: tracks down fast, up slowly
        // so sustained user speech does not get absorbed into the baseline.
        if rms < self.echo_baseline {
            self.echo_baseline += 0.2 * (rms - self.echo_baseline);
        } else {
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
// MicGate — per-mic-thread gate driver
// ============================================================================

const STATS_SAMPLE_INTERVAL_MS: u64 = 250;
const CORRELATOR_INTERVAL_MS: u64 = 2_000;

/// Owned by the microphone DSP thread. Every processed frame goes through
/// `decide()`, which returns true when the frame must be emitted as zeros.
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
        Self {
            proc,
            convergence: Convergence::new(),
            talkover: TalkOverDetector::new(),
            align: echo_align::AlignController::new(),
            last_stats_ms: 0,
            last_corr_ms: 0,
            last_muted: false,
            route_generation: ROUTE_GENERATION.load(Ordering::Acquire),
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
        if !*ALIGN_ENABLED || now.saturating_sub(self.last_corr_ms) < CORRELATOR_INTERVAL_MS {
            return;
        }
        self.last_corr_ms = now;
        if let Some(est) = echo_align::estimate_from_rings() {
            if let Some(applied) = self.align.feed(est) {
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

    /// Decide the fate of one post-AEC mic frame. Returns true = emit zeros.
    pub fn decide(&mut self, cleaned: &[i16]) -> bool {
        let now = now_ms();
        let m = mode();
        self.check_route_generation();

        let mute = match m {
            EchoMode::Legacy => {
                GATE_STATE.store(3, Ordering::Release);
                let speaker_on = SPEAKER_ACTIVE.load(Ordering::Acquire);
                let warming_up =
                    APM_RENDER_FRAMES.load(Ordering::Acquire) < APM_WARMUP_FRAMES;
                speaker_on || warming_up
            }
            EchoMode::Phase1 => {
                if headphones_active() {
                    GATE_STATE.store(0, Ordering::Release);
                    false
                } else {
                    GATE_STATE.store(2, Ordering::Release);
                    speaker_recently_active()
                }
            }
            EchoMode::FullDuplex => {
                self.sample_stats(now);
                if headphones_active() {
                    GATE_STATE.store(0, Ordering::Release);
                    self.talkover.reset_frame();
                    false
                } else {
                    self.run_correlator(now);
                    if self.convergence.converged() {
                        GATE_STATE.store(1, Ordering::Release);
                        self.talkover.reset_frame();
                        false
                    } else {
                        GATE_STATE.store(2, Ordering::Release);
                        if speaker_recently_active() {
                            // Hard gate — unless the talk-over escape fires.
                            !self.talkover.check(cleaned)
                        } else {
                            self.talkover.reset_frame();
                            false
                        }
                    }
                }
            }
        };

        FRAMES_TOTAL.fetch_add(1, Ordering::Relaxed);
        if mute {
            FRAMES_MUTED.fetch_add(1, Ordering::Relaxed);
        }
        if mute != self.last_muted {
            self.last_muted = mute;
            self.proc.set_output_will_be_muted(mute);
        }
        mute
    }
}

// ============================================================================
// Lifecycle + stats
// ============================================================================

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
        echo_align::reset_envelopes();
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
        _ => "unconverged",
    };
    let (route_transport, route_name) = ROUTE_INFO
        .lock()
        .ok()
        .and_then(|ri| ri.clone())
        .map(|r| (r.transport, r.name))
        .unwrap_or_else(|| ("unknown".to_string(), String::new()));
    let last_est = echo_align::LAST_ESTIMATE_MS.load(Ordering::Acquire);

    serde_json::json!({
        "mode": mode().as_str(),
        "gate_state": gate_state,
        "headphones": headphones_active(),
        "route_transport": route_transport,
        "route_name": route_name,
        "speaker_active": speaker_recently_active(),
        "erle_db": stats.echo_return_loss_enhancement,
        "erl_db": stats.echo_return_loss,
        "delay_ms": stats.delay_ms,
        "residual_echo_likelihood": stats.residual_echo_likelihood,
        "residual_echo_likelihood_recent_max": stats.residual_echo_likelihood_recent_max,
        "frames_total": total,
        "frames_muted": muted,
        "muted_pct": if total > 0 { muted as f64 * 100.0 / total as f64 } else { 0.0 },
        "render_frames": APM_RENDER_FRAMES.load(Ordering::Acquire),
        "estimated_offset_ms": if last_est == i32::MIN { None } else { Some(last_est) },
        "applied_render_delay_ms": echo_align::TARGET_RENDER_DELAY_MS.load(Ordering::Acquire),
        "applied_capture_delay_ms": echo_align::TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire),
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
}
