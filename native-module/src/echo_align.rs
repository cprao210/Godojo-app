// Render/capture delay estimation + alignment for AEC3.
//
// AEC3 can only cancel echo when the render reference it receives is causally
// aligned (reference no more than a few tens of ms ahead of the echo in the
// mic). The system-audio reference offset is backend- and machine-dependent:
// the ScreenCaptureKit backend leads the acoustic echo by hundreds of ms
// (measured ~+324 ms), while the CoreAudio tap has been observed arriving
// LATE (negative offsets down to ~-90 ms in field telemetry). This module
// measures the actual offset at runtime by cross-correlating the energy
// envelopes of the two streams, and drives a delay buffer that re-aligns the
// render feed (reference early) or the capture feed (reference late).
//
// Everything here is pure data-in/data-out and unit-testable; lib.rs owns the
// wiring. Envelope entries are (timestamp_ms, rms) pairs; timestamps are
// sample-anchored wall-clock ms produced by `EnvClock`.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::Mutex;

/// Envelope sampling period. Both streams are 16 kHz; one RMS value is pushed
/// per 10 ms (160-sample) subframe.
pub const ENV_PERIOD_MS: u64 = 10;
const ENV_RING_CAP: usize = 1024; // ~10 s of 10 ms entries

/// Correlation search window: negative = reference LATE (the observed
/// CoreAudio-tap case), positive = reference EARLY (the SCK case).
/// The negative bound is tight on purpose: the user's own voice returning
/// from the far end shows up at the meeting RTT (300-1000 ms) and must fall
/// OUTSIDE the search range, and CAPTURE_DELAY_CAP_MS caps what we could
/// apply anyway. The positive bound comfortably covers the SCK lead (~324 ms).
const LAG_MIN_MS: i32 = -250;
const LAG_MAX_MS: i32 = 600;
const LAG_STEP_MS: i32 = 10;

/// Minimum overlapping envelope needed before attempting an estimate.
const MIN_OVERLAP_MS: u64 = 3_000;

/// Peak acceptance thresholds (see estimate_delay_ms).
/// Speech envelopes autocorrelate broadly (~±150 ms syllabic plateau), so the
/// dominance test compares the peak against lags OUTSIDE that neighborhood —
/// it rejects periodic material (music beats) without rejecting speech.
const MIN_PEAK_SCORE: f32 = 0.5;
const MIN_PEAK_DOMINANCE: f32 = 1.5;
const PEAK_NEIGHBORHOOD_MS: i32 = 150;

/// Keep AEC3 a comfortable causal residual to lock onto instead of aligning
/// to exactly zero.
pub const ALIGN_HEADROOM_MS: i32 = 40;
/// Below this measured lead, AEC3's own estimator handles it — do not align.
pub const ALIGN_MIN_MS: i32 = 60;
/// Never delay the mic capture path by more than this (adds STT latency).
pub const CAPTURE_DELAY_CAP_MS: i32 = 250;

// Published alignment targets, written by the mic thread's AlignController and
// read by whichever thread owns the corresponding DelayBuffer.
pub static TARGET_RENDER_DELAY_MS: AtomicI32 = AtomicI32::new(0);
pub static TARGET_CAPTURE_DELAY_MS: AtomicI32 = AtomicI32::new(0);
/// Latest raw estimate (ms, render-leads-positive) for stats; i32::MIN = none.
pub static LAST_ESTIMATE_MS: AtomicI32 = AtomicI32::new(i32::MIN);

static RENDER_ENV: Mutex<VecDeque<(u64, f32)>> = Mutex::new(VecDeque::new());
static CAPTURE_ENV: Mutex<VecDeque<(u64, f32)>> = Mutex::new(VecDeque::new());

fn push_env(ring: &Mutex<VecDeque<(u64, f32)>>, ts_ms: u64, rms: f32) {
    if let Ok(mut r) = ring.lock() {
        r.push_back((ts_ms, rms));
        while r.len() > ENV_RING_CAP {
            r.pop_front();
        }
    }
}

/// Push one envelope entry for the render (system-audio) stream.
pub fn push_render_env(ts_ms: u64, rms: f32) {
    push_env(&RENDER_ENV, ts_ms, rms);
}

/// Push one envelope entry for the capture (microphone) stream.
pub fn push_capture_env(ts_ms: u64, rms: f32) {
    push_env(&CAPTURE_ENV, ts_ms, rms);
}

/// Clear both rings + the last estimate (meeting start, route change).
/// Deliberately does NOT touch the applied delay targets — callers that also
/// want the buffers back at zero (or re-seeded) call `reset_targets()` and/or
/// `AlignController::publish` explicitly so the ordering is intentional.
pub fn reset_envelopes() {
    if let Ok(mut r) = RENDER_ENV.lock() {
        r.clear();
    }
    if let Ok(mut c) = CAPTURE_ENV.lock() {
        c.clear();
    }
    LAST_ESTIMATE_MS.store(i32::MIN, Ordering::Release);
}

/// Zero the applied delay-buffer targets.
pub fn reset_targets() {
    TARGET_RENDER_DELAY_MS.store(0, Ordering::Release);
    TARGET_CAPTURE_DELAY_MS.store(0, Ordering::Release);
}

/// Convert a persisted EFFECTIVE offset (the `applied_align_offset_ms` stats
/// value: positive = render delayed by that many ms, negative = capture
/// delayed) back to the RAW estimate space used by the correlator and
/// `AlignController`. `publish()` maps raw R → effective E = R −
/// ALIGN_HEADROOM_MS in both directions, so the inverse is uniform.
pub fn seed_raw_from_effective(effective_ms: i32) -> i32 {
    effective_ms + ALIGN_HEADROOM_MS
}

/// Snapshot both rings and estimate the current offset.
/// Positive result = render reference EARLY by that many ms.
pub fn estimate_from_rings() -> Option<i32> {
    let render: Vec<(u64, f32)> = RENDER_ENV.lock().ok()?.iter().copied().collect();
    let capture: Vec<(u64, f32)> = CAPTURE_ENV.lock().ok()?.iter().copied().collect();
    let est = estimate_delay_ms(&render, &capture);
    if let Some(d) = est {
        LAST_ESTIMATE_MS.store(d, Ordering::Release);
    }
    est
}

// ============================================================================
// EnvClock — sample-anchored wall-clock timestamps
// ============================================================================

/// Maps a monotonically growing 16 kHz sample count onto wall-clock ms.
/// Sample-derived positions keep the envelope grid regular even when the DSP
/// loop drains several chunks in one poll; a slow EMA re-anchor absorbs
/// device-clock vs wall-clock drift.
pub struct EnvClock {
    anchor_ms: f64,
    total_samples: u64,
    initialized: bool,
}

impl EnvClock {
    pub fn new() -> Self {
        Self {
            anchor_ms: 0.0,
            total_samples: 0,
            initialized: false,
        }
    }

    /// Stamp a chunk of `nsamples` 16 kHz samples processed "now".
    /// Returns the wall-clock ms of the chunk START.
    pub fn stamp(&mut self, now_ms: u64, nsamples: usize) -> u64 {
        let pos_ms = self.total_samples as f64 / 16.0;
        let implied_anchor = now_ms as f64 - pos_ms;
        if !self.initialized {
            self.anchor_ms = implied_anchor;
            self.initialized = true;
        } else {
            // Slow correction (~2% per chunk) toward the implied anchor.
            self.anchor_ms += 0.02 * (implied_anchor - self.anchor_ms);
        }
        let ts = (self.anchor_ms + pos_ms).max(0.0) as u64;
        self.total_samples += nsamples as u64;
        ts
    }
}

impl Default for EnvClock {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Correlator — normalized cross-correlation of the two envelopes
// ============================================================================

/// Resample an (ts, rms) series onto a uniform grid [t0, t1) with ENV_PERIOD_MS
/// step using nearest-entry lookup (entries are already ~10 ms apart).
fn to_grid(series: &[(u64, f32)], t0: u64, n: usize) -> Vec<f32> {
    let mut out = vec![0.0f32; n];
    if series.is_empty() {
        return out;
    }
    let mut idx = 0usize;
    for (i, slot) in out.iter_mut().enumerate() {
        let t = t0 + (i as u64) * ENV_PERIOD_MS;
        while idx + 1 < series.len() && series[idx + 1].0 <= t {
            idx += 1;
        }
        *slot = series[idx].1;
    }
    out
}

/// Estimate the offset between the render and capture envelopes.
/// Returns Some(lag_ms) where POSITIVE lag means the render reference LEADS
/// the capture echo (reference early). None when there is not enough signal
/// or no unambiguous correlation peak.
pub fn estimate_delay_ms(render: &[(u64, f32)], capture: &[(u64, f32)]) -> Option<i32> {
    if render.len() < 8 || capture.len() < 8 {
        return None;
    }

    let r_start = render.first()?.0;
    let r_end = render.last()?.0;
    let c_start = capture.first()?.0;
    let c_end = capture.last()?.0;

    // Common span, padded so all lags in [LAG_MIN, LAG_MAX] stay in range for
    // the capture grid.
    let t0 = r_start.max(c_start);
    let t1 = r_end.min(c_end);
    if t1 <= t0 || t1 - t0 < MIN_OVERLAP_MS {
        return None;
    }

    let n = ((t1 - t0) / ENV_PERIOD_MS) as usize;
    if n < (MIN_OVERLAP_MS / ENV_PERIOD_MS) as usize {
        return None;
    }

    let r_grid = to_grid(render, t0, n);
    // Capture grid extended on both sides by the lag range.
    let pad_neg = (-LAG_MIN_MS).max(0) as u64;
    let pad_pos = LAG_MAX_MS.max(0) as u64;
    let c_t0 = t0.saturating_sub(pad_neg);
    let c_n = n + ((pad_neg + pad_pos) / ENV_PERIOD_MS) as usize;
    let c_grid = to_grid(capture, c_t0, c_n);
    // Index in c_grid corresponding to render grid t0.
    let c_origin = ((t0 - c_t0) / ENV_PERIOD_MS) as usize;

    // Mean-center; require real energy variation on both sides (a flat
    // envelope correlates with everything).
    let center = |v: &[f32]| -> (Vec<f32>, f32) {
        let mean = v.iter().sum::<f32>() / v.len() as f32;
        let cent: Vec<f32> = v.iter().map(|x| x - mean).collect();
        let var = cent.iter().map(|x| x * x).sum::<f32>() / v.len() as f32;
        (cent, var)
    };
    let (r_c, r_var) = center(&r_grid);
    let (c_c, c_var) = center(&c_grid);
    if r_var < 1.0 || c_var < 1.0 {
        return None; // effectively silence on one side
    }

    let r_norm = (r_c.iter().map(|x| x * x).sum::<f32>()).sqrt();

    let mut best: (i32, f32) = (0, f32::MIN);
    let mut scores: Vec<(i32, f32)> = Vec::new();
    let mut lag = LAG_MIN_MS;
    while lag <= LAG_MAX_MS {
        let shift = lag / LAG_STEP_MS; // capture index offset in grid steps
        let mut dot = 0.0f32;
        let mut c_energy = 0.0f32;
        for (i, rv) in r_c.iter().enumerate() {
            let ci = c_origin as i64 + i as i64 + shift as i64;
            if ci < 0 || ci as usize >= c_c.len() {
                continue;
            }
            let cv = c_c[ci as usize];
            dot += rv * cv;
            c_energy += cv * cv;
        }
        let denom = r_norm * c_energy.sqrt();
        let score = if denom > 1e-6 { dot / denom } else { 0.0 };
        scores.push((lag, score));
        if score > best.1 {
            best = (lag, score);
        }
        lag += LAG_STEP_MS;
    }

    if best.1 < MIN_PEAK_SCORE {
        return None;
    }

    // Peak dominance: best must beat everything outside its syllabic
    // neighborhood by MIN_PEAK_DOMINANCE.
    let second = scores
        .iter()
        .filter(|(l, _)| (l - best.0).abs() > PEAK_NEIGHBORHOOD_MS)
        .map(|&(_, s)| s)
        .fold(f32::MIN, f32::max);
    if second > 0.0 && best.1 / second.max(1e-6) < MIN_PEAK_DOMINANCE {
        return None;
    }

    Some(best.0)
}

// ============================================================================
// AlignController — median smoothing + hysteresis over raw estimates
// ============================================================================

/// Smoothed-estimate divergence needed before a re-apply is even considered.
const APPLY_DIVERGENCE_MS: i32 = 50;
/// Minimum spacing between applies. A re-apply invalidates AEC3 convergence,
/// so it must be rare; the first apply of a session is exempt.
const APPLY_MIN_INTERVAL_MS: u64 = 10_000;

pub struct AlignController {
    history: VecDeque<i32>,
    applied_ms: i32,
    divergent_feeds: u32,
    /// now_ms of the last apply; 0 = never applied (first apply is exempt
    /// from APPLY_MIN_INTERVAL_MS).
    last_apply_ms: u64,
}

impl AlignController {
    pub fn new() -> Self {
        Self {
            history: VecDeque::with_capacity(5),
            applied_ms: 0,
            divergent_feeds: 0,
            last_apply_ms: 0,
        }
    }

    /// Start from a known-good prior (persisted telemetry or backend default,
    /// RAW estimate space). `feed()` then measures divergence from the seed,
    /// so estimates that merely confirm it never trigger a re-apply.
    pub fn with_seed(seed_raw_ms: i32) -> Self {
        Self {
            history: VecDeque::with_capacity(5),
            applied_ms: seed_raw_ms,
            divergent_feeds: 0,
            last_apply_ms: 0,
        }
    }

    pub fn applied_ms(&self) -> i32 {
        self.applied_ms
    }

    /// Feed one raw estimate at wall-clock `now_ms`. Returns
    /// Some(new_applied_ms) when the smoothed estimate has diverged from the
    /// applied value by >APPLY_DIVERGENCE_MS for 3 consecutive feeds
    /// (hysteresis against jitter and false peaks) AND at least
    /// APPLY_MIN_INTERVAL_MS passed since the previous apply (damping — every
    /// apply costs a full AEC3 re-convergence).
    pub fn feed(&mut self, now_ms: u64, estimate_ms: i32) -> Option<i32> {
        self.history.push_back(estimate_ms);
        while self.history.len() > 5 {
            self.history.pop_front();
        }
        if self.history.len() < 3 {
            return None;
        }
        let mut sorted: Vec<i32> = self.history.iter().copied().collect();
        sorted.sort_unstable();
        let median = sorted[sorted.len() / 2];

        if (median - self.applied_ms).abs() > APPLY_DIVERGENCE_MS {
            self.divergent_feeds += 1;
            if self.divergent_feeds >= 3 {
                if self.last_apply_ms != 0
                    && now_ms.saturating_sub(self.last_apply_ms) < APPLY_MIN_INTERVAL_MS
                {
                    // Damped: strikes stay armed, the apply fires once the
                    // interval elapses (if the estimates still diverge).
                    return None;
                }
                self.divergent_feeds = 0;
                self.applied_ms = median;
                self.last_apply_ms = now_ms.max(1);
                return Some(median);
            }
        } else {
            self.divergent_feeds = 0;
        }
        None
    }

    /// Translate an applied raw offset into buffer targets and publish them.
    /// Positive offset (reference early, the observed case) delays the RENDER
    /// feed; negative (reference late, contingency) delays the CAPTURE feed.
    pub fn publish(applied_ms: i32) {
        if applied_ms > ALIGN_MIN_MS {
            TARGET_RENDER_DELAY_MS.store(applied_ms - ALIGN_HEADROOM_MS, Ordering::Release);
            TARGET_CAPTURE_DELAY_MS.store(0, Ordering::Release);
        } else if applied_ms < 0 {
            TARGET_RENDER_DELAY_MS.store(0, Ordering::Release);
            TARGET_CAPTURE_DELAY_MS.store(
                (-applied_ms + ALIGN_HEADROOM_MS).min(CAPTURE_DELAY_CAP_MS),
                Ordering::Release,
            );
        } else {
            // Small positive lead — AEC3's own estimator handles it.
            TARGET_RENDER_DELAY_MS.store(0, Ordering::Release);
            TARGET_CAPTURE_DELAY_MS.store(0, Ordering::Release);
        }
    }
}

impl Default for AlignController {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// DelayBuffer — gradual-step sample delay line
// ============================================================================

/// FIFO sample delay. The delay ramps toward the target by at most one 10 ms
/// frame (160 samples) per process() call so the downstream timeline never
/// jumps discontinuously.
pub struct DelayBuffer {
    buf: VecDeque<i16>,
    current_delay_samples: usize,
}

const DELAY_STEP_SAMPLES: usize = 160; // 10 ms at 16 kHz

impl DelayBuffer {
    pub fn new() -> Self {
        Self {
            buf: VecDeque::new(),
            current_delay_samples: 0,
        }
    }

    pub fn current_delay_ms(&self) -> i32 {
        (self.current_delay_samples / 16) as i32
    }

    /// Push input, pop output delayed by ~current_delay (ramping toward
    /// `target_ms`). Output length varies while ramping and equals input
    /// length at steady state.
    pub fn process(&mut self, input: &[i16], target_ms: i32) -> Vec<i16> {
        let target_samples = (target_ms.max(0) as usize) * 16;

        if self.current_delay_samples < target_samples {
            self.current_delay_samples = (self.current_delay_samples + DELAY_STEP_SAMPLES)
                .min(target_samples);
        } else if self.current_delay_samples > target_samples {
            self.current_delay_samples = self
                .current_delay_samples
                .saturating_sub(DELAY_STEP_SAMPLES)
                .max(target_samples);
        }

        self.buf.extend(input.iter().copied());
        let excess = self.buf.len().saturating_sub(self.current_delay_samples);
        self.buf.drain(..excess).collect()
    }
}

impl Default for DelayBuffer {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a bursty speech-like envelope: aperiodic level plateaus of
    /// 100-500 ms (like syllables/pauses), sampled every 10 ms starting at t0.
    /// Deliberately NOT periodic — a fixed burst period would create genuine
    /// ambiguous correlation peaks at multiples of the period.
    fn synth_envelope(t0: u64, dur_ms: u64, seed: u64) -> Vec<(u64, f32)> {
        let mut out = Vec::new();
        let mut state = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let mut next_rand = move || {
            state = state
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            (state >> 33) as u32
        };
        let mut level = 0.0f32;
        let mut next_change = t0;
        let mut t = t0;
        while t < t0 + dur_ms {
            if t >= next_change {
                level = (next_rand() % 1000) as f32;
                next_change = t + 100 + (next_rand() % 400) as u64; // 100-500 ms plateau
            }
            out.push((t, level));
            t += ENV_PERIOD_MS;
        }
        out
    }

    fn shifted(env: &[(u64, f32)], shift_ms: i64, atten: f32) -> Vec<(u64, f32)> {
        env.iter()
            .map(|&(t, v)| ((t as i64 + shift_ms).max(0) as u64, v * atten))
            .collect()
    }

    /// Serializes tests that mutate the global TARGET_* atomics.
    static TEST_TARGET_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn estimates_known_lags() {
        // All within the tightened search window [-250, 600].
        for lag in [0i64, 40, 120, 324, 560] {
            let render = synth_envelope(10_000, 8_000, 42);
            let capture = shifted(&render, lag, 0.3); // echo is attenuated copy
            let est = estimate_delay_ms(&render, &capture)
                .unwrap_or_else(|| panic!("no estimate for lag {lag}"));
            assert!(
                (est as i64 - lag).abs() <= 10,
                "lag {lag}: estimated {est}"
            );
        }
    }

    #[test]
    fn estimates_negative_lag() {
        let render = synth_envelope(10_000, 8_000, 7);
        let capture = shifted(&render, -80, 0.5); // reference LATE contingency
        let est = estimate_delay_ms(&render, &capture).expect("no estimate");
        assert!((est - (-80)).abs() <= 10, "estimated {est}");
    }

    #[test]
    fn rejects_silence_and_short_overlap() {
        let flat: Vec<(u64, f32)> = (0..800).map(|i| (i * 10, 5.0)).collect();
        let render = synth_envelope(0, 8_000, 3);
        assert_eq!(estimate_delay_ms(&render, &flat), None, "flat capture");

        let short = synth_envelope(0, 1_000, 3);
        let short_c = shifted(&short, 100, 0.5);
        assert_eq!(estimate_delay_ms(&short, &short_c), None, "short overlap");
    }

    #[test]
    fn controller_applies_median_with_hysteresis() {
        let mut ctl = AlignController::new();
        let mut t = 0u64;
        let mut feed = |ctl: &mut AlignController, est: i32| {
            t += 2_000; // real correlator cadence
            ctl.feed(t, est)
        };
        // Warm-up: not enough history.
        assert_eq!(feed(&mut ctl, 320), None);
        assert_eq!(feed(&mut ctl, 324), None);
        // Third feed: median 320+ diverges from applied 0 → strike 1... 3.
        assert_eq!(feed(&mut ctl, 330), None);
        assert_eq!(feed(&mut ctl, 318), None);
        let applied = feed(&mut ctl, 325);
        assert!(applied.is_some(), "should apply after 3 divergent feeds");
        let a = applied.unwrap();
        assert!((a - 324).abs() <= 10, "applied {a}");

        // Jitter around the applied value (within ±50 ms) must not re-trigger.
        assert_eq!(feed(&mut ctl, a + 40), None);
        assert_eq!(feed(&mut ctl, a - 35), None);
        assert_eq!(feed(&mut ctl, a + 45), None);

        // One outlier is absorbed by the median + strike counter.
        assert_eq!(feed(&mut ctl, 900), None);
        assert_eq!(feed(&mut ctl, a + 5), None);
    }

    #[test]
    fn seeded_controller_measures_divergence_from_seed() {
        let mut ctl = AlignController::with_seed(324);
        assert_eq!(ctl.applied_ms(), 324);

        // Estimates confirming the seed must never re-apply.
        let mut t = 0u64;
        for est in [320, 330, 310, 340, 324, 318] {
            t += 2_000;
            assert_eq!(ctl.feed(t, est), None, "confirming estimate {est}");
        }

        // Genuinely divergent estimates re-apply after the median flips and
        // 3 strikes accumulate (first apply of the session is exempt from
        // the interval damping).
        let mut applied = None;
        for _ in 0..6 {
            t += 2_000;
            applied = ctl.feed(t, 100);
            if applied.is_some() {
                break;
            }
        }
        assert_eq!(applied, Some(100), "divergent estimates must re-apply");
    }

    #[test]
    fn min_apply_interval_damps_reapplies() {
        let mut ctl = AlignController::new();
        let mut t = 0u64;

        // First apply: exempt from the interval.
        let mut first = None;
        while first.is_none() {
            t += 500;
            first = ctl.feed(t, 300);
            assert!(t < 10_000, "first apply must not be interval-damped");
        }
        assert_eq!(first, Some(300));
        let apply_t = t;

        // Hard divergence immediately after: strikes accumulate but the
        // re-apply must stay damped for APPLY_MIN_INTERVAL_MS.
        let mut second = None;
        while second.is_none() && t + 500 < apply_t + APPLY_MIN_INTERVAL_MS {
            t += 500;
            second = ctl.feed(t, -50);
        }
        assert_eq!(second, None, "re-apply within the interval must be damped");

        // Once the interval elapses the pending divergence applies.
        while second.is_none() && t < apply_t + 3 * APPLY_MIN_INTERVAL_MS {
            t += 500;
            second = ctl.feed(t, -50);
        }
        assert_eq!(second, Some(-50), "re-apply after the damping interval");
    }

    #[test]
    fn seed_roundtrip_preserves_effective_offset() {
        let _guard = TEST_TARGET_LOCK.lock().unwrap();
        // publish(seed_raw_from_effective(E)) must reproduce the exact buffer
        // targets a previous session persisted as applied_align_offset_ms=E.
        for eff in [-250, -90, -41, 120, 284] {
            AlignController::publish(seed_raw_from_effective(eff));
            let rd = TARGET_RENDER_DELAY_MS.load(Ordering::Acquire);
            let cd = TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire);
            let roundtrip = if rd > 0 { rd } else { -cd };
            assert_eq!(roundtrip, eff, "effective offset {eff}");
        }
        // Restore for other tests.
        AlignController::publish(0);
    }

    #[test]
    fn publish_maps_offsets_to_buffer_targets() {
        let _guard = TEST_TARGET_LOCK.lock().unwrap();
        AlignController::publish(324);
        assert_eq!(TARGET_RENDER_DELAY_MS.load(Ordering::Acquire), 324 - ALIGN_HEADROOM_MS);
        assert_eq!(TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire), 0);

        AlignController::publish(30); // within AEC3's own range
        assert_eq!(TARGET_RENDER_DELAY_MS.load(Ordering::Acquire), 0);
        assert_eq!(TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire), 0);

        AlignController::publish(-80);
        assert_eq!(TARGET_RENDER_DELAY_MS.load(Ordering::Acquire), 0);
        assert_eq!(TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire), 120);

        AlignController::publish(-400); // capped
        assert_eq!(
            TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire),
            CAPTURE_DELAY_CAP_MS
        );
        // Restore for other tests.
        AlignController::publish(0);
    }

    #[test]
    fn delay_buffer_ramps_and_preserves_samples() {
        let mut db = DelayBuffer::new();
        let chunk: Vec<i16> = (0..320).map(|i| i as i16).collect();

        let mut total_in = 0usize;
        let mut total_out = 0usize;
        // Ramp up to 100 ms (1600 samples): 10 calls to reach target.
        for _ in 0..20 {
            let out = db.process(&chunk, 100);
            total_in += chunk.len();
            total_out += out.len();
        }
        assert_eq!(db.current_delay_ms(), 100);
        assert_eq!(total_in - total_out, 1600, "held-back samples == delay");

        // Ramp back down: all samples come back out.
        for _ in 0..20 {
            let out = db.process(&chunk, 0);
            total_in += chunk.len();
            total_out += out.len();
        }
        assert_eq!(db.current_delay_ms(), 0);
        assert_eq!(total_in, total_out);
    }
}
