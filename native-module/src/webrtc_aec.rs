use std::sync::Arc;
use crate::apm_shim::{
    config::{Config, EchoCanceller},
    Processor, Stats,
};

const SAMPLE_RATE_HZ: u32 = 16_000;
const FRAME_SAMPLES: usize = 160; // 10 ms at 16 kHz  (sample_rate / 100)

/// Create and configure the shared WebRTC APM Processor.
/// Processor is Send + Sync; both DSP threads hold an Arc clone.
pub fn create_processor() -> Arc<Processor> {
    let p = Processor::new(SAMPLE_RATE_HZ).expect("[WebRtcAec] Processor init failed");
    let full_duplex = crate::echo_control::mode() == crate::echo_control::EchoMode::FullDuplex;
    apply_mode_config(&p, full_duplex);
    Arc::new(p)
}

/// Apply the APM configuration for the active echo mode. Safe to call at any
/// time (set_config takes effect on the next processed frame).
pub fn apply_mode_config(p: &Processor, full_duplex: bool) {
    // Opt-in escape hatch for field experiments: NATIVELY_APM_STREAM_DELAY_MS
    // forces a fixed stream-delay hint in full_duplex. Default (unset) keeps
    // the hint off — the echo_align buffers + AEC3's own estimator own the
    // alignment, and a fixed hint would fight them.
    let full_duplex_hint: Option<u16> = std::env::var("NATIVELY_APM_STREAM_DELAY_MS")
        .ok()
        .and_then(|v| v.parse::<u16>().ok());
    p.set_config(Config {
        // legacy/phase1: stream_delay_ms = 40 hints that echo arrives ~40ms
        // after render — correct for MacBook built-in speakers and it locks
        // AEC3 onto the right delay immediately.
        //
        // full_duplex: no fixed hint by default. The echo_align delay buffer
        // keeps the reference within a small causal residual of the acoustic
        // echo, and AEC3's own delay estimator (fed a continuous render
        // timeline) locks onto the remainder. A fixed hint would fight the
        // estimator whenever the aligned residual differs from 40ms.
        echo_canceller: Some(EchoCanceller::Full {
            stream_delay_ms: if full_duplex { full_duplex_hint } else { Some(40) },
        }),
        // HPF removes sub-80 Hz rumble (HVAC, desk vibration, 60 Hz hum).
        // No STT content below 80 Hz; negligible CPU cost.
        high_pass_filter: Some(Default::default()),
        // Noise suppression disabled: NoiseSuppression::High degrades Deepgram
        // WER 8-15% on fricatives and proper nouns. Neural STT handles SNR natively.
        noise_suppression: None,
        ..Default::default()
    });
}

/// Owned exclusively by the SystemAudioCapture DSP thread.
/// Feeds speaker audio (far-end reference) into the AEC3 render path.
/// Not Send — never shared across threads.
pub struct ApmRender {
    proc: Arc<Processor>,
    buf: Vec<f32>,
}

impl ApmRender {
    pub fn new(proc: Arc<Processor>) -> Self {
        Self { proc, buf: Vec::new() }
    }

    /// Push 16 kHz i16 mono samples from the speaker into the AEC3 render path.
    /// Returns the number of 10 ms render frames submitted to the APM.
    pub fn push(&mut self, samples: &[i16]) -> usize {
        self.buf.extend(samples.iter().map(|&s| s as f32 / 32768.0));
        let mut count = 0;
        while self.buf.len() >= FRAME_SAMPLES {
            let mut frame = vec![self.buf.drain(..FRAME_SAMPLES).collect::<Vec<f32>>()];
            let _ = self.proc.process_render_frame(&mut frame);
            count += 1;
        }
        count
    }
}

/// Owned exclusively by the MicrophoneCapture DSP thread.
/// Runs microphone audio (near-end) through the AEC3 capture path.
/// Not Send — never shared across threads.
pub struct ApmCapture {
    proc: Arc<Processor>,
    buf: Vec<f32>,
    frame_count: u32,
}

impl ApmCapture {
    pub fn new(proc: Arc<Processor>) -> Self {
        Self { proc, buf: Vec::new(), frame_count: 0 }
    }

    /// Process 16 kHz i16 mono mic samples through AEC3.
    /// Returns echo-cancelled i16 samples. Output length equals input length once
    /// the accumulator has filled its first 10 ms frame (160 samples). Partial
    /// frames are held in the buffer until the next call completes them.
    pub fn process(&mut self, samples: &[i16]) -> Vec<i16> {
        self.buf.extend(samples.iter().map(|&s| s as f32 / 32768.0));
        let mut out = Vec::with_capacity(samples.len());
        while self.buf.len() >= FRAME_SAMPLES {
            let mut frame = vec![self.buf.drain(..FRAME_SAMPLES).collect::<Vec<f32>>()];
            let _ = self.proc.process_capture_frame(&mut frame);
            self.frame_count += 1;

            // Log ERLE every 50 frames (~500ms) so we can verify AEC3 is converging.
            // ERLE > 20dB = good cancellation. ERLE ~0dB = AEC3 not working.
            if self.frame_count.is_multiple_of(50) {
                let stats: Stats = self.proc.get_stats();
                println!(
                    "[WebRtcAec] frame={} ERLE={:.1}dB delay={}ms",
                    self.frame_count,
                    stats.echo_return_loss_enhancement.unwrap_or(0.0),
                    stats.delay_ms.map(|d| d as i64).unwrap_or(-1),
                );
            }

            out.extend(
                frame[0].iter().map(|&f| (f * 32768.0).clamp(-32768.0, 32767.0) as i16),
            );
        }
        out
    }
}