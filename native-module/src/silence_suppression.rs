// Silence Suppression for Streaming STT - Low Latency Optimized
//
// TWO-STAGE GATING:
// 1. RMS volume check (fast, catches obvious silence)
// 2. WebRTC VAD (ML-based, rejects non-speech noise like typing/dogs)
// Only if BOTH pass do we open the gate. This eliminates false triggers.
//
// DESIGN PRINCIPLES:
// 1. Google STT requires timing continuity - never send gaps
// 2. During silence, send keepalive frames every 100ms
// 3. During speech, send ALL frames immediately with NO delay
// 4. Hangover is for cost savings only, NOT for first-word accuracy
//
// LATENCY BUDGET:
// - Speech onset: 0ms delay (immediate)
// - Hangover: Only affects AFTER speech ends (no latency impact)

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use webrtc_vad::{SampleRate as VadSampleRate, Vad, VadMode};

// ── Mic-gate telemetry ───────────────────────────────────────────────────────
//
// The two-stage gate is the single biggest thing standing between the
// microphone and the STT provider, and until now it reported nothing. A call
// where `frames_total` (echo_control's post-gate counter) sat at 18 over three
// minutes was indistinguishable from three different faults:
//
//   * the rep genuinely never spoke,
//   * the mic delivered near-silence (muted in Windows, wrong input device,
//     input level at zero),
//   * or the gate itself rejected real speech — stage 1 because
//     `adaptive_threshold` (= noise_floor_ema × 3, floored at 20) outran a quiet
//     mic, or stage 2 because `VadMode::Aggressive` refused to call it voice.
//
// Those need completely different fixes, so guessing was not an option. These
// counters separate them, and land in getAudioPipelineStats() where main's 5 s
// poll already prints them:
//
//   peak_rms ≈ 0                      → the mic is delivering nothing
//   peak_rms healthy, rms_rejects ≈ frames → stage 1 threshold is too high
//   rms_rejects low, vad_rejects high → stage 2 (Aggressive VAD) is the filter
//   speech high but frames_total low  → the problem is downstream of the gate
//
// Published only by the microphone suppressor (`publish_telemetry`), never the
// system-audio one — two writers would make every number meaningless. Relaxed
// ordering: diagnostics read from a different thread, where exact-instant
// coherence buys nothing.

/// Frames the gate examined this mic session.
pub static GATE_FRAMES: AtomicU64 = AtomicU64::new(0);
/// Frames that passed BOTH stages (RMS and VAD) — real detected speech.
pub static GATE_SPEECH: AtomicU64 = AtomicU64::new(0);
/// Frames rejected by stage 1: RMS below the adaptive threshold.
pub static GATE_RMS_REJECTS: AtomicU64 = AtomicU64::new(0);
/// Frames that cleared stage 1 but which the WebRTC VAD did not call voice.
pub static GATE_VAD_REJECTS: AtomicU64 = AtomicU64::new(0);
/// Loudest frame RMS seen this session, f32 bits. The one number that says
/// whether the microphone is producing signal at all.
static GATE_PEAK_RMS_BITS: AtomicU32 = AtomicU32::new(0);
/// Most recent frame RMS, f32 bits.
static GATE_LAST_RMS_BITS: AtomicU32 = AtomicU32::new(0);
/// Current adaptive threshold, f32 bits — what stage 1 is comparing against.
static GATE_THRESHOLD_BITS: AtomicU32 = AtomicU32::new(0);

/// Zero the counters at the start of a mic session, so the ratios describe this
/// call rather than every call since launch. Called from
/// `echo_control::on_mic_start` alongside the other per-session resets.
pub fn reset_gate_stats() {
    GATE_FRAMES.store(0, Ordering::Relaxed);
    GATE_SPEECH.store(0, Ordering::Relaxed);
    GATE_RMS_REJECTS.store(0, Ordering::Relaxed);
    GATE_VAD_REJECTS.store(0, Ordering::Relaxed);
    GATE_PEAK_RMS_BITS.store(0, Ordering::Relaxed);
    GATE_LAST_RMS_BITS.store(0, Ordering::Relaxed);
    GATE_THRESHOLD_BITS.store(0, Ordering::Relaxed);
}

/// Snapshot for the pipeline stats JSON: (frames, speech, rms_rejects,
/// vad_rejects, peak_rms, last_rms, threshold).
pub fn gate_stats() -> (u64, u64, u64, u64, f32, f32, f32) {
    (
        GATE_FRAMES.load(Ordering::Relaxed),
        GATE_SPEECH.load(Ordering::Relaxed),
        GATE_RMS_REJECTS.load(Ordering::Relaxed),
        GATE_VAD_REJECTS.load(Ordering::Relaxed),
        f32::from_bits(GATE_PEAK_RMS_BITS.load(Ordering::Relaxed)),
        f32::from_bits(GATE_LAST_RMS_BITS.load(Ordering::Relaxed)),
        f32::from_bits(GATE_THRESHOLD_BITS.load(Ordering::Relaxed)),
    )
}

/// Configuration for silence suppression
/// Optimized for low latency with adaptive threshold
pub struct SilenceSuppressionConfig {
    /// Initial RMS threshold for speech detection (i16 scale: 0-32767)
    /// Acts as starting value; adaptive tracking adjusts this over time.
    pub speech_threshold_rms: f32,

    /// Duration to continue sending full audio after speech ends
    /// This does NOT add latency - only affects when we switch to keepalives
    pub speech_hangover: Duration,

    /// How often to send a keepalive frame during silence
    pub silence_keepalive_interval: Duration,

    /// Multiplier above the noise floor EMA to detect speech (default: 3.0)
    pub adaptive_multiplier: f32,

    /// Minimum floor for the adaptive threshold (prevents false triggers in dead silence)
    pub adaptive_min_floor: f32,

    /// EMA smoothing factor (0..1). Lower = slower adaptation. Default 0.02.
    pub ema_alpha: f32,

    /// Native sample rate of the audio being processed (e.g. 48000)
    /// Used to calculate decimation ratio for 16kHz VAD input.
    pub native_sample_rate: u32,

    /// Publish this suppressor's gate decisions to the module-level telemetry
    /// counters. True for the microphone only — the counters describe one gate,
    /// and the system-audio suppressor writing to them too would make every
    /// ratio meaningless.
    pub publish_telemetry: bool,
}

impl Default for SilenceSuppressionConfig {
    fn default() -> Self {
        Self {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(200),
            silence_keepalive_interval: Duration::from_millis(100),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 48000,
            publish_telemetry: false,
        }
    }
}

impl SilenceSuppressionConfig {
    /// Create config for system audio (very permissive - system audio is quieter)
    pub fn for_system_audio() -> Self {
        Self {
            speech_threshold_rms: 30.0,
            speech_hangover: Duration::from_millis(300),
            silence_keepalive_interval: Duration::from_millis(100),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 10.0,
            ema_alpha: 0.02,
            native_sample_rate: 48000,
            publish_telemetry: false,
        }
    }

    /// Create config for microphone (standard)
    pub fn for_microphone() -> Self {
        Self {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(150),
            silence_keepalive_interval: Duration::from_millis(100),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 48000,
            // The mic gate is the one on the STT-critical path, so it is the one
            // worth instrumenting. See the telemetry block at the top.
            publish_telemetry: true,
        }
    }
}

/// Silence suppression state machine with adaptive threshold + WebRTC VAD
pub struct SilenceSuppressor {
    config: SilenceSuppressionConfig,
    state: SuppressionState,
    last_speech_time: Instant,
    last_keepalive_time: Instant,
    frames_sent: u64,
    frames_suppressed: u64,
    /// Exponential moving average of ambient noise floor RMS
    noise_floor_ema: f32,
    /// Current adaptive speech threshold
    adaptive_threshold: f32,
    /// Tracks whether we were speaking in the previous frame (for edge detection)
    was_speaking: bool,
    /// WebRTC Voice Activity Detector (ML-based, 16kHz)
    vad: Vad,
    /// Decimation factor: native_sample_rate / 16000 (may be non-integer, e.g. 44100/16000 = 2.75625)
    decimation_factor: f64,
    /// Reusable buffer for decimated 16kHz samples (avoids allocation per frame)
    vad_buf: Vec<i16>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SuppressionState {
    Active,     // Speech detected, send everything
    Hangover,   // Speech ended recently, still sending
    Suppressed, // Confirmed silence, send keepalives only
}

/// Result of processing a frame
#[derive(Debug, Clone)]
pub enum FrameAction {
    /// Send this frame to STT
    Send(Vec<i16>),
    /// Replace with silence keepalive frame
    SendSilence,
    /// Suppress this frame (timing maintained by keepalives)
    Suppress,
}

impl SilenceSuppressor {
    pub fn new(config: SilenceSuppressionConfig) -> Self {
        let now = Instant::now();
        let initial_threshold = config.speech_threshold_rms;
        let decimation_factor = config.native_sample_rate as f64 / 16000.0;

        let vad = Vad::new_with_rate_and_mode(VadSampleRate::Rate16kHz, VadMode::Aggressive);

        crate::vlog!(
            "[SilenceSuppressor] Created: threshold={} (adaptive), hangover={}ms, \
             keepalive={}ms, native_rate={}Hz, decimation={:.2}x, VAD=Aggressive",
            config.speech_threshold_rms,
            config.speech_hangover.as_millis(),
            config.silence_keepalive_interval.as_millis(),
            config.native_sample_rate,
            decimation_factor,
        );

        Self {
            noise_floor_ema: config.adaptive_min_floor,
            adaptive_threshold: initial_threshold,
            vad_buf: Vec::with_capacity(480), // Max VAD frame size at 16kHz (30ms)
            decimation_factor,
            vad,
            config,
            state: SuppressionState::Active, // Start in active to not miss first words
            last_speech_time: now,
            last_keepalive_time: now,
            frames_sent: 0,
            frames_suppressed: 0,
            was_speaking: true,
        }
    }

    /// Process a frame and determine what to do with it.
    /// Returns (FrameAction, speech_just_ended)
    /// `speech_just_ended` is true on the exact frame where speech transitions to silence.
    /// CRITICAL: Speech frames are NEVER delayed.
    ///
    /// The frame can be at ANY native sample rate. Internally, we decimate
    /// to 16kHz for the WebRTC VAD check only.
    pub fn process(&mut self, frame: &[i16]) -> (FrameAction, bool) {
        let now = Instant::now();
        let rms = calculate_rms(frame);

        // ── TWO-STAGE GATE ──────────────────────────────────────────────
        // Stage 1: Fast RMS check (rejects obvious silence cheaply)
        // Stage 2: WebRTC VAD (rejects non-speech noise: typing, dogs, fans)
        let passed_rms = rms >= self.adaptive_threshold;
        let has_speech = if passed_rms {
            // Stage 2: Decimate to 16kHz and run ML-based voice detection
            self.is_voice(frame)
        } else {
            false
        };

        // Record which stage decided, before the state machine runs — this is
        // the only place that distinction exists.
        if self.config.publish_telemetry {
            GATE_FRAMES.fetch_add(1, Ordering::Relaxed);
            if !passed_rms {
                GATE_RMS_REJECTS.fetch_add(1, Ordering::Relaxed);
            } else if has_speech {
                GATE_SPEECH.fetch_add(1, Ordering::Relaxed);
            } else {
                GATE_VAD_REJECTS.fetch_add(1, Ordering::Relaxed);
            }
            GATE_LAST_RMS_BITS.store(rms.to_bits(), Ordering::Relaxed);
            GATE_THRESHOLD_BITS.store(self.adaptive_threshold.to_bits(), Ordering::Relaxed);
            let peak = f32::from_bits(GATE_PEAK_RMS_BITS.load(Ordering::Relaxed));
            if rms > peak {
                GATE_PEAK_RMS_BITS.store(rms.to_bits(), Ordering::Relaxed);
            }
        }

        // ALWAYS check for speech first - immediate response
        if has_speech {
            self.state = SuppressionState::Active;
            self.last_speech_time = now;
            self.frames_sent += 1;
            self.was_speaking = true;
            return (FrameAction::Send(frame.to_vec()), false);
        }

        // No speech detected - check state
        let mut speech_just_ended = false;
        match self.state {
            SuppressionState::Active | SuppressionState::Hangover => {
                // Check if hangover period has elapsed
                if now.duration_since(self.last_speech_time) > self.config.speech_hangover {
                    self.state = SuppressionState::Suppressed;
                    // Detect the edge: was speaking, now suppressed
                    if self.was_speaking {
                        speech_just_ended = true;
                        self.was_speaking = false;
                    }
                    // Fall through to check keepalive
                } else {
                    // Still in hangover - send full frame
                    self.state = SuppressionState::Hangover;
                    self.frames_sent += 1;
                    return (FrameAction::Send(frame.to_vec()), false);
                }
            }
            SuppressionState::Suppressed => {
                // Already suppressed
            }
        }

        // In suppressed state - update adaptive noise floor EMA
        // Only adapt during confirmed silence to avoid tracking speech levels
        let alpha = self.config.ema_alpha;
        self.noise_floor_ema = self.noise_floor_ema * (1.0 - alpha) + rms * alpha;
        self.adaptive_threshold = (self.noise_floor_ema * self.config.adaptive_multiplier)
            .max(self.config.adaptive_min_floor);

        // Check if time for keepalive
        if now.duration_since(self.last_keepalive_time) >= self.config.silence_keepalive_interval {
            self.last_keepalive_time = now;
            self.frames_sent += 1;
            (FrameAction::SendSilence, speech_just_ended)
        } else {
            self.frames_suppressed += 1;
            (FrameAction::Suppress, speech_just_ended)
        }
    }

    /// Decimate the native-rate frame to ~16kHz and run WebRTC VAD.
    /// WebRTC VAD requires exactly 160/320/480 samples at 16kHz (10/20/30ms).
    /// We dynamically choose the closest valid frame size based on the actual
    /// decimated sample count, handling non-integer ratios (e.g. 44.1kHz).
    #[inline]
    fn is_voice(&mut self, frame: &[i16]) -> bool {
        self.vad_buf.clear();

        // Decimate: take samples at 16kHz intervals using floating-point stepping.
        // This correctly handles non-integer ratios like 44100/16000 = 2.75625.
        let factor = self.decimation_factor;
        if factor <= 1.0 {
            // Native rate IS 16kHz (or lower) — use frame directly
            self.vad_buf.extend_from_slice(frame);
        } else {
            let mut pos = 0.0_f64;
            while (pos as usize) < frame.len() {
                self.vad_buf.push(frame[pos as usize]);
                pos += factor;
            }
        }

        // WebRTC VAD accepts exactly 160 (10ms), 320 (20ms), or 480 (30ms) samples.
        // Pick the largest valid size that fits our decimated data.
        let len = self.vad_buf.len();
        let target = if len >= 480 {
            480
        } else if len >= 320 {
            320
        } else if len >= 160 {
            160
        } else {
            // Frame too small for VAD — fall back to RMS-only
            return true;
        };

        // On VAD error, fall back to RMS-only (don't block audio)
        self.vad.is_voice_segment(&self.vad_buf[..target]).unwrap_or(true)
    }

    /// Get statistics
    pub fn stats(&self) -> (u64, u64) {
        (self.frames_sent, self.frames_suppressed)
    }

    /// Get current state for UI
    pub fn is_speech(&self) -> bool {
        matches!(
            self.state,
            SuppressionState::Active | SuppressionState::Hangover
        )
    }

    /// Get the current adaptive speech threshold
    pub fn adaptive_threshold(&self) -> f32 {
        self.adaptive_threshold
    }

    /// Reset state (e.g., when meeting ends)
    pub fn reset(&mut self) {
        let now = Instant::now();
        self.state = SuppressionState::Active;
        self.last_speech_time = now;
        self.last_keepalive_time = now;
        self.noise_floor_ema = self.config.adaptive_min_floor;
        self.adaptive_threshold = self.config.speech_threshold_rms;
        self.was_speaking = true;
    }
}

/// Calculate RMS of i16 samples efficiently
fn calculate_rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    // Sample every 4th sample for speed (320/4 = 80 samples is plenty for RMS)
    let sum_of_squares: f64 = samples
        .iter()
        .step_by(4)
        .map(|&s| (s as f64) * (s as f64))
        .sum();

    let count = samples.len().div_ceil(4);
    (sum_of_squares / count as f64).sqrt() as f32
}

/// Generate a silence frame of given size
pub fn generate_silence_frame(size: usize) -> Vec<i16> {
    vec![0i16; size]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_speech_immediate() {
        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            native_sample_rate: 16000, // Use 16kHz for test to avoid decimation issues
            ..SilenceSuppressionConfig::default()
        });

        // Loud frame should be sent immediately (high amplitude sine-ish wave)
        let loud_frame: Vec<i16> = (0..320)
            .map(|i| ((i as f32 * 0.1).sin() * 10000.0) as i16)
            .collect();
        let (action, ended) = suppressor.process(&loud_frame);
        assert!(matches!(action, FrameAction::Send(_)));
        assert!(!ended, "Speech should not have 'ended' on a loud frame");
        assert!(suppressor.is_speech());
    }

    #[test]
    fn test_silence_keepalive() {
        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(0),
            silence_keepalive_interval: Duration::from_millis(50),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 16000,
            // Off in tests: the counters are process-global, so a test writing
            // to them would make `cargo test` order affect their values.
            publish_telemetry: false,
        });

        let silent_frame: Vec<i16> = vec![0; 320];
        let (action, _ended) = suppressor.process(&silent_frame);
        assert!(matches!(
            action,
            FrameAction::SendSilence | FrameAction::Suppress
        ));
    }

    #[test]
    fn test_speech_ended_detection() {
        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            speech_threshold_rms: 100.0,
            speech_hangover: Duration::from_millis(0),
            silence_keepalive_interval: Duration::from_millis(50),
            adaptive_multiplier: 3.0,
            adaptive_min_floor: 20.0,
            ema_alpha: 0.02,
            native_sample_rate: 16000,
            publish_telemetry: false,
        });

        // Send a loud speech-like frame
        let loud_frame: Vec<i16> = (0..320)
            .map(|i| ((i as f32 * 0.1).sin() * 10000.0) as i16)
            .collect();
        let (_, ended) = suppressor.process(&loud_frame);
        assert!(!ended, "Speech should not end on a loud frame");

        // Send a silent frame (should trigger speech_ended)
        let silent_frame: Vec<i16> = vec![0; 320];
        let (_, ended) = suppressor.process(&silent_frame);
        assert!(ended, "Speech should have ended on transition to silence");

        // Another silent frame should NOT trigger speech_ended again
        let (_, ended) = suppressor.process(&silent_frame);
        assert!(!ended, "Speech_ended should only fire once per transition");
    }

    /// The telemetry exists to answer one question — *which* stage dropped the
    /// frame — so the thing worth testing is the attribution, not the totals.
    ///
    /// Safe to run in parallel with the tests above because `publish_telemetry`
    /// is off everywhere else in the crate (only `for_microphone()` turns it on,
    /// and no test builds that), making this the process's only writer.
    #[test]
    fn test_gate_stats_attribute_the_rejecting_stage() {
        reset_gate_stats();

        let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
            speech_threshold_rms: 100.0,
            native_sample_rate: 16000,
            publish_telemetry: true,
            ..SilenceSuppressionConfig::default()
        });

        // Silence is below the stage-1 RMS threshold, so it must never reach
        // the VAD — a silent frame counted as a VAD reject would mean the two
        // stages are being conflated and the field could not be trusted.
        let silent_frame: Vec<i16> = vec![0; 320];
        suppressor.process(&silent_frame);

        let (frames, speech, rms_rejects, vad_rejects, _peak, _last, _thresh) = gate_stats();
        assert_eq!(frames, 1, "every examined frame should be counted");
        assert_eq!(rms_rejects, 1, "silence should be rejected at stage 1");
        assert_eq!(vad_rejects, 0, "stage 2 should not have seen the frame");
        assert_eq!(speech, 0);

        // A frame loud enough to clear both stages moves the speech counter,
        // and peak_rms holds the loudest RMS the mic actually produced — the
        // field that tells "nobody spoke" apart from "the gate was too strict".
        let loud_frame: Vec<i16> = (0..320)
            .map(|i| ((i as f32 * 0.1).sin() * 10000.0) as i16)
            .collect();
        suppressor.process(&loud_frame);

        let (frames, speech, rms_rejects, _vad_rejects, peak, last, _thresh) = gate_stats();
        assert_eq!(frames, 2);
        assert_eq!(speech, 1, "a loud voiced frame should count as speech");
        assert_eq!(rms_rejects, 1, "the earlier reject should still stand");
        assert!(peak > 100.0, "peak_rms should track the loud frame, got {peak}");
        assert_eq!(peak, last, "the loud frame is both the latest and the peak");

        reset_gate_stats();
        let (frames, ..) = gate_stats();
        assert_eq!(frames, 0, "reset should clear the counters between sessions");
    }
}
