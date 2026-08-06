//! Platform shim for the WebRTC APM (AEC3) processor.
//!
//! `webrtc-audio-processing` (bundled C++ AEC3) only builds on macOS/Linux —
//! see the target-specific dependency in Cargo.toml. Windows doesn't need
//! AEC at all (no speaker-bleed-into-mic scenario there), so this module
//! re-exports the real types on macOS and provides no-op stand-ins with an
//! identical API on Windows, so `lib.rs` / `echo_control.rs` / `webrtc_aec.rs`
//! don't need any `#[cfg]` branching at their call sites.

#[cfg(not(target_os = "windows"))]
pub use webrtc_audio_processing::{config, Processor, Stats};

#[cfg(target_os = "windows")]
pub mod config {
    #[derive(Default)]
    pub struct Config {
        pub echo_canceller: Option<EchoCanceller>,
        pub high_pass_filter: Option<HighPassFilter>,
        pub noise_suppression: Option<()>,
    }

    #[derive(Default)]
    pub struct HighPassFilter;

    pub enum EchoCanceller {
        Full { stream_delay_ms: Option<u16> },
    }
}

#[cfg(target_os = "windows")]
#[derive(Default, Clone, Copy)]
pub struct Stats {
    pub echo_return_loss_enhancement: Option<f64>,
    pub echo_return_loss: Option<f64>,
    pub delay_ms: Option<u32>,
    pub residual_echo_likelihood: Option<f64>,
    pub residual_echo_likelihood_recent_max: Option<f64>,
}

/// No-op stand-in on Windows: audio passes through unmodified, stats are empty.
#[cfg(target_os = "windows")]
pub struct Processor;

#[cfg(target_os = "windows")]
impl Processor {
    pub fn new(_sample_rate_hz: u32) -> anyhow::Result<Self> {
        Ok(Processor)
    }

    pub fn set_config(&self, _config: config::Config) {}

    pub fn process_render_frame(&self, _frame: &mut Vec<Vec<f32>>) -> anyhow::Result<()> {
        Ok(())
    }

    pub fn process_capture_frame(&self, _frame: &mut Vec<Vec<f32>>) -> anyhow::Result<()> {
        Ok(())
    }

    pub fn set_output_will_be_muted(&self, _mute: bool) {}

    pub fn reinitialize(&self) {}

    pub fn get_stats(&self) -> Stats {
        Stats::default()
    }
}