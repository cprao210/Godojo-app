//! Single point where the APM (WebRTC AudioProcessing) types are selected per
//! platform. Non-Windows uses the real `webrtc-audio-processing` crate; Windows
//! uses the no-op passthrough in [`crate::apm_stub`] because that crate does not
//! build on MSVC (see `Cargo.toml`). All other modules import the APM types from
//! here (`crate::apm::…`) so the platform swap lives in exactly one place.

#[cfg(not(target_os = "windows"))]
pub use webrtc_audio_processing::{
    config::{Config, EchoCanceller},
    Processor, Stats,
};

#[cfg(target_os = "windows")]
pub use crate::apm_stub::{Config, EchoCanceller, Processor, Stats};
