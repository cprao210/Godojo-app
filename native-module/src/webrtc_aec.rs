#[cfg(not(target_os = "windows"))]
mod real {
    use std::sync::Arc;
    use webrtc_audio_processing::{
        config::{Config, EchoCanceller},
        Processor, Stats,
    };

    const SAMPLE_RATE_HZ: u32 = 16_000;
    const FRAME_SAMPLES: usize = 160; // 10 ms at 16 kHz  (sample_rate / 100)

    /// Create and configure the shared WebRTC APM Processor.
    /// Processor is Send + Sync; both DSP threads hold an Arc clone.
    pub fn create_processor() -> Arc<Processor> {
        let p = Processor::new(SAMPLE_RATE_HZ).expect("[WebRtcAec] Processor init failed");
        p.set_config(Config {
            // stream_delay_ms = 40: hint to AEC3 that echo arrives ~40ms after render.
            // For MacBook built-in speakers the acoustic + buffer delay is ~20-60ms.
            // Without this hint, AEC3 uses automatic delay estimation which takes
            // several seconds to converge — allowing echo to leak through to STT.
            // A correct hint locks AEC3 onto the right delay immediately.
            echo_canceller: Some(EchoCanceller::Full { stream_delay_ms: Some(40) }),
            // HPF removes sub-80 Hz rumble (HVAC, desk vibration, 60 Hz hum).
            // No STT content below 80 Hz; negligible CPU cost.
            high_pass_filter: Some(Default::default()),
            // Noise suppression disabled: NoiseSuppression::High degrades Deepgram
            // WER 8-15% on fricatives and proper nouns. Neural STT handles SNR natively.
            noise_suppression: None,
            ..Default::default()
        });
        Arc::new(p)
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
                if self.frame_count % 50 == 0 {
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
}

#[cfg(not(target_os = "windows"))]
pub use real::{ApmCapture, ApmRender, create_processor};

#[cfg(target_os = "windows")]
pub use windows_stub::{ApmCapture, ApmRender, create_processor};

#[cfg(target_os = "windows")]
mod windows_stub {
    // Must match `real::FRAME_SAMPLES` (10 ms @ 16 kHz) so the frame count
    // returned here advances `APM_RENDER_FRAMES` in lib.rs at the same rate
    // the real AEC path would. Without this, `push` always returns 0,
    // `warming_up` in the mic DSP loop never clears, and the mic is
    // permanently gated to silence on Windows.
    const FRAME_SAMPLES: usize = 160;

    /// On Windows, AEC is a no-op passthrough. WASAPI loopback capture
    /// handles echo at the driver level (system mix excludes loopback from mic).
    pub struct ApmCapture;
    pub struct ApmRender;

    pub fn create_processor() -> std::sync::Arc<()> {
        std::sync::Arc::new(())
    }

    impl ApmCapture {
        pub fn new(_apm: std::sync::Arc<()>) -> Self { Self }
        pub fn process(&mut self, samples: &[i16]) -> Vec<i16> {
            samples.to_vec() // passthrough
        }
    }

    impl ApmRender {
        pub fn new(_apm: std::sync::Arc<()>) -> Self { Self }
        pub fn push(&mut self, samples: &[i16]) -> usize {
            // No real AEC buffering on Windows — just report how many 10ms
            // frames this call's worth of samples represents, so the caller's
            // `APM_RENDER_FRAMES.fetch_add(frames, ...)` behaves as if a real
            // processor were running and the warmup window closes.
            samples.len() / FRAME_SAMPLES
        }
    }
}