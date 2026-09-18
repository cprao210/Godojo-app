// removed unused anyhow::Result

#[cfg(target_os = "macos")]
mod core_audio;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
mod sck;
#[cfg(target_os = "macos")]
pub use macos::list_output_devices;
#[cfg(target_os = "macos")]
#[cfg(target_os = "macos")]
#[cfg(target_os = "macos")]
pub use macos::SpeakerInput;
#[cfg(target_os = "macos")]
pub use macos::SpeakerStream;

#[cfg(target_os = "windows")]
pub mod windows;
#[cfg(target_os = "windows")]
pub use windows::list_output_devices;
#[cfg(target_os = "windows")]
pub use windows::SpeakerInput;
#[cfg(target_os = "windows")]
pub use windows::SpeakerStream;

#[cfg(target_os = "linux")]
pub mod linux;
// Also used by output_route.rs to classify the active sink.
#[cfg(target_os = "linux")]
pub mod pulse;
#[cfg(target_os = "linux")]
pub use linux::list_output_devices;
#[cfg(target_os = "linux")]
pub use linux::SpeakerInput;
#[cfg(target_os = "linux")]
pub use linux::SpeakerStream;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub mod fallback {
    use anyhow::Result;

    // A zero-sized consumer that satisfies the trait bounds lib.rs needs at
    // compile time. This code path is never reached at runtime because
    // SpeakerInput::new() always returns Err, so the thread exits before
    // take_consumer() / try_pop() are ever called.
    pub struct DummyConsumer;

    impl DummyConsumer {
        pub fn try_pop(&mut self) -> Option<f32> {
            None
        }

        pub fn backend_name(&self) -> &'static str {
            "none"
        }
    }

    pub struct SpeakerStream;

    impl SpeakerStream {
        pub fn take_consumer(&mut self) -> Option<DummyConsumer> {
            None  // triggers the `None =>` early-return in lib.rs:161-164
        }
        pub fn sample_rate(&self) -> u32 {
            48000
        }
    }

    pub struct SpeakerInput;

    impl SpeakerInput {
        pub fn new(_device_id: Option<String>) -> Result<Self> {
            Err(anyhow::anyhow!("Speaker capture is not supported on this platform"))
        }
        pub fn stream(self) -> SpeakerStream {
            SpeakerStream
        }
        pub fn backend_name(&self) -> &'static str {
            "none"
        }
    }

    pub fn list_output_devices() -> Result<Vec<(String, String)>> {
        Ok(Vec::new())
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use fallback::list_output_devices;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use fallback::SpeakerInput;
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub use fallback::SpeakerStream;