//! Windows-only no-op stub for the `webrtc-audio-processing` APM.
//!
//! `webrtc-audio-processing` (bundled) compiles a WebRTC C++ library and only
//! supports Unix/GNU toolchains — it does not build on Windows/MSVC. On Windows
//! we therefore compile against this passthrough mirror of the exact API surface
//! used by `webrtc_aec.rs`, `echo_control.rs`, and `lib.rs`, swapped in via the
//! `crate::apm` re-export.
//!
//! Consequence: WebRTC echo cancellation (AEC3) is disabled on Windows. The mic
//! path relies on the Processor-free hard-gate (`echo_control` `Phase1`, the
//! Windows default). Muting still works — it is done by emitting zeros in
//! `lib.rs::emit_gated` from `GateAction::Mute`, not by the APM.

/// Stub error type. `Processor::new` never fails here, but the signature must
/// match the real crate so `webrtc_aec::create_processor`'s `.expect(...)` compiles.
#[derive(Debug)]
pub struct Error;

/// No-op stand-in for `webrtc_audio_processing::Processor`.
///
/// Zero-sized, so it is trivially `Send + Sync` and can be shared via `Arc`
/// across the microphone and system-audio DSP threads exactly like the real one.
pub struct Processor;

impl Processor {
    pub fn new(_sample_rate_hz: u32) -> Result<Self, Error> {
        Ok(Processor)
    }

    pub fn set_config(&self, _config: Config) {}

    /// Passthrough: the capture frame is left untouched (no echo cancellation).
    pub fn process_capture_frame(&self, _frame: &mut Vec<Vec<f32>>) -> Result<(), Error> {
        Ok(())
    }

    /// No-op: there is no far-end render path to feed without an APM.
    pub fn process_render_frame(&self, _frame: &mut Vec<Vec<f32>>) -> Result<(), Error> {
        Ok(())
    }

    pub fn get_stats(&self) -> Stats {
        Stats::default()
    }

    pub fn reinitialize(&self) {}

    pub fn set_output_will_be_muted(&self, _muted: bool) {}
}

/// Mirror of `webrtc_audio_processing::Stats` — only the fields our code reads.
/// All `None` on Windows: convergence-based logic (`FullDuplex`) degrades to the
/// hard-gate, and `getAudioPipelineStats` reports null APM fields.
#[derive(Debug, Default)]
pub struct Stats {
    pub echo_return_loss: Option<f64>,
    pub echo_return_loss_enhancement: Option<f64>,
    pub residual_echo_likelihood: Option<f64>,
    pub residual_echo_likelihood_recent_max: Option<f64>,
    pub delay_ms: Option<u32>,
}

/// Mirror of `webrtc_audio_processing::config::Config` — only the fields set in
/// `webrtc_aec::apply_mode_config`. `..Default::default()` at the call site
/// covers everything else. `high_pass_filter`/`noise_suppression` are typed as
/// `Option<()>` because their concrete values are never inspected on Windows.
#[derive(Default)]
pub struct Config {
    pub echo_canceller: Option<EchoCanceller>,
    pub high_pass_filter: Option<()>,
    pub noise_suppression: Option<()>,
}

/// Mirror of `webrtc_audio_processing::config::EchoCanceller` — only the `Full`
/// variant is constructed by our code.
pub enum EchoCanceller {
    Full { stream_delay_ms: Option<u16> },
}
