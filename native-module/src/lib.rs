#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use once_cell::sync::Lazy;
use ringbuf::traits::Consumer;

pub mod audio_config;
pub mod license;
pub mod microphone;
pub mod silence_suppression;
pub mod speaker;
pub mod resampler;
pub mod webrtc_aec;
use crate::resampler::Resampler;
use crate::webrtc_aec::{ApmCapture, ApmRender};

// Shared WebRTC APM (AEC3) Processor.
// Processor is Send + Sync; both DSP threads hold an Arc clone.
// SystemAudioCapture owns an ApmRender (per-thread render accumulator).
// MicrophoneCapture owns an ApmCapture (per-thread capture accumulator).
#[cfg(not(target_os = "windows"))]
static WEBRTC_APM: Lazy<std::sync::Arc<webrtc_audio_processing::Processor>> =
    Lazy::new(|| webrtc_aec::create_processor());

#[cfg(target_os = "windows")]
static WEBRTC_APM: Lazy<std::sync::Arc<()>> =
    Lazy::new(|| webrtc_aec::create_processor());

// Counts 10 ms render frames pushed to APM by SystemAudioCapture.
// MicrophoneCapture emits silence until this reaches APM_WARMUP_FRAMES (100 ms),
// giving AEC3 time to initialize its echo path model before processing capture.
static APM_RENDER_FRAMES: AtomicUsize = AtomicUsize::new(0);
const APM_WARMUP_FRAMES: usize = 10; // 10 × 10 ms = 100 ms minimum warmup

// Primary echo gate: set true when speaker is actively playing, false when silent.
// MicrophoneCapture emits silence when true so system audio cannot reach STT
// regardless of AEC3 convergence state. The SilenceSuppressor's 300 ms hangover
// keeps SPEAKER_ACTIVE true for 300 ms after the last audio frame, covering room
// echo decay. AEC3 then handles any residual echo after SPEAKER_ACTIVE clears.
//
// Diagnostic evidence (ERLE=0.2dB over 900 frames, delay=324ms): AEC3 alone
// cannot cancel echo here because the SCK render reference diverges from the
// acoustic echo in the mic — SCK captures audio ~324ms before it plays, creating
// a correlated-but-shifted reference that AEC3's linear model can't fully cancel.
static SPEAKER_ACTIVE: AtomicBool = AtomicBool::new(false);

use crate::audio_config::DSP_POLL_MS;
use crate::silence_suppression::{FrameAction, SilenceSuppressionConfig, SilenceSuppressor};

// ============================================================================
// HELPERS — i16 slice → zero-copy LE bytes
// ============================================================================

/// Convert an i16 slice to little-endian bytes.
/// Returns a Vec<u8> suitable for wrapping in napi::Buffer.
#[inline]
fn i16_slice_to_le_bytes(samples: &[i16]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(samples.len() * 2);
    for &s in samples {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    bytes
}

// ============================================================================
// SYSTEM AUDIO CAPTURE (CoreAudio Tap / ScreenCaptureKit on macOS)
// ============================================================================

#[napi]
pub struct SystemAudioCapture {
    stop_signal: Arc<AtomicBool>,
    capture_thread: Option<thread::JoinHandle<()>>,
    /// Shared atomic sample rate — updated by the background thread once the
    /// native device is initialized. Callers always get the real hardware rate.
    sample_rate: Arc<AtomicU32>,
    device_id: Option<String>,
}

#[napi]
impl SystemAudioCapture {
    #[napi(constructor)]
    pub fn new(device_id: Option<String>) -> napi::Result<Self> {
        println!("[SystemAudioCapture] Created (device: {:?})", device_id);

        Ok(SystemAudioCapture {
            stop_signal: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            // Default to 48000 until the background thread reports the real rate.
            // 48kHz is the standard macOS CoreAudio rate.
            sample_rate: Arc::new(AtomicU32::new(48000)),
            device_id,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Acquire)
    }

    #[napi]
    pub fn get_output_sample_rate(&self) -> u32 {
        16000
    }

    #[napi]
    pub fn start(
        &mut self,
        callback: ThreadsafeFunction<Buffer>,
        on_speech_ended: Option<ThreadsafeFunction<bool>>,
    ) -> napi::Result<()> {
        let tsfn = callback;
        let speech_ended_tsfn = on_speech_ended;

        // DO NOT reset APM state here. SystemAudioCapture::start() is called on every
        // VAD-lockout restart (which happens repeatedly within a single meeting).
        // Reinitializing APM on each restart wipes the echo model every ~2s, preventing
        // AEC3 from ever converging. The APM reset lives in MicrophoneCapture::start()
        // which fires exactly once per meeting.
        self.stop_signal.store(false, Ordering::SeqCst);
        let stop_signal = self.stop_signal.clone();
        let device_id = self.device_id.clone();
        let sample_rate_shared = self.sample_rate.clone();

        // ★ ALL init + DSP runs in background thread — start() returns INSTANTLY
        // This prevents the 5-7 second main-thread block from SCK initialization.
        self.capture_thread = Some(thread::spawn(move || {
            // 1. SCK Init (takes 5-7 seconds — runs OFF main thread)
            println!("[SystemAudioCapture] Background init starting...");
            let input = match speaker::SpeakerInput::new(device_id) {
                Ok(i) => i,
                Err(e) => {
                    println!("[SystemAudioCapture] Init failed: {}. Trying default...", e);
                    match speaker::SpeakerInput::new(None) {
                        Ok(i) => i,
                        Err(e2) => {
                            eprintln!(
                                "[SystemAudioCapture] FATAL: All init attempts failed: {}",
                                e2
                            );
                            // Propagate the error to JS so the UI can show a permission prompt.
                            tsfn.call(
                                Err(napi::Error::from_reason(format!(
                                    "System audio capture failed: {}. On macOS, grant Screen Recording permission in System Settings > Privacy & Security.",
                                    e2
                                ))),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                            return;
                        }
                    }
                }
            };

            let mut stream = input.stream();
            let mut consumer = match stream.take_consumer() {
                Some(c) => c,
                None => {
                    eprintln!("[SystemAudioCapture] FATAL: Failed to get consumer");
                    return;
                }
            };

            let native_rate = stream.sample_rate();
            // Publish the real native rate so JS can read it via get_sample_rate()
            sample_rate_shared.store(native_rate, Ordering::Release);
            println!(
                "[SystemAudioCapture] Background init complete. Initial Rate: {}Hz. DSP starting.",
                native_rate
            );

            // 2. DSP loop with silence suppression + WebRTC VAD
            let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
                native_sample_rate: native_rate,
                ..SilenceSuppressionConfig::for_system_audio()
            });

            // Create resampler only if the native rate differs from 16kHz
            let mut resampler = if native_rate != 16000 {
                match Resampler::new(native_rate as f64) {
                    Ok(r) => {
                        println!("[SystemAudioCapture] Resampler: {}Hz → 16000Hz", native_rate);
                        Some(r)
                    }
                    Err(e) => {
                        eprintln!("[SystemAudioCapture] Resampler creation failed: {} — sending at native rate", e);
                        None
                    }
                }
            } else {
                println!("[SystemAudioCapture] Native rate is 16kHz — no resampling needed");
                None
            };

            // 20ms chunks at native rate (e.g. 960 samples at 48kHz)
            let chunk_size = (native_rate as usize / 1000) * 20;
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(chunk_size * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);

            // Per-thread AEC3 render path accumulator (not shared — owned by this thread).
            let mut apm_render = ApmRender::new(std::sync::Arc::clone(&WEBRTC_APM));

            loop {
                if stop_signal.load(Ordering::Relaxed) {
                    break;
                }

                // Drain ALL available samples from ring buffer (lock-free)
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                }

                // Convert f32 -> i16 at native sample rate
                if !raw_batch.is_empty() {
                    for &f in &raw_batch {
                        let scaled = (f * 32767.0).clamp(-32768.0, 32767.0);
                        frame_buffer.push(scaled as i16);
                    }
                    raw_batch.clear();
                }

                // Process in 20ms chunks through the two-stage gate
                while frame_buffer.len() >= chunk_size {
                    let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();

                    let (action, speech_ended) = suppressor.process(&frame);

                    match action {
                        FrameAction::Send(data) => {
                            // Resample to 16kHz before sending to JS
                            let resampled_16k: Vec<i16> = if let Some(ref mut rs) = resampler {
                                let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32767.0).collect();
                                match rs.resample(&f32_data) {
                                    Ok(r) => r,
                                    Err(e) => {
                                        eprintln!("[SystemAudioCapture] Resample error: {} — using original", e);
                                        data
                                    }
                                }
                            } else {
                                data
                            };

                            if !resampled_16k.is_empty() {
                                // Primary echo gate: mark speaker active so mic mutes.
                                SPEAKER_ACTIVE.store(true, Ordering::Release);
                                // Feed AEC3 render path — only on real audio, never silence.
                                // Pushing zeros during silence corrupts AEC3 echo path model.
                                let frames = apm_render.push(&resampled_16k);
                                APM_RENDER_FRAMES.fetch_add(frames, Ordering::Release);
                                tsfn.call(
                                    Ok(Buffer::from(i16_slice_to_le_bytes(&resampled_16k))),
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                            }
                        }
                        FrameAction::SendSilence => {
                            // Speaker not producing speech — unmute mic gate.
                            // Do NOT push to APM render: pushing zeros corrupts AEC3 echo model.
                            SPEAKER_ACTIVE.store(false, Ordering::Release);
                            let silence_16k = if resampler.is_some() { 320usize } else { chunk_size };
                            let silence = vec![0u8; silence_16k * 2];
                            tsfn.call(
                                Ok(Buffer::from(silence)),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                        FrameAction::Suppress => {
                            // Speaker fully silent — unmute mic gate, skip APM render.
                            SPEAKER_ACTIVE.store(false, Ordering::Release);
                        }
                    }

                    // Fire speech_ended callback on the exact transition frame
                    if speech_ended {
                        if let Some(ref se_tsfn) = speech_ended_tsfn {
                            se_tsfn.call(Ok(true), ThreadsafeFunctionCallMode::NonBlocking);
                        }
                    }
                }

                // Keep the sleep small so we quickly read the ring buffer
                thread::sleep(Duration::from_millis(DSP_POLL_MS));
            }

            println!("[SystemAudioCapture] DSP thread stopped.");
            // stream is dropped here → SpeakerStream::Drop calls stop_with_ch
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
    }
}

// ============================================================================
// MICROPHONE CAPTURE (CPAL)
//
// Design: The MicrophoneStream (CPAL handle) is recreated on every start()
// call. This guarantees the ring buffer consumer is always fresh, allowing
// seamless stop→start restart cycles (e.g. between meetings).
//
// FIX: Added `vad_disabled` option. When the user has NO external audio
// device (built-in mic + built-in speakers), macOS Acoustic Echo Cancellation
// (AEC) already attenuates the microphone signal. The two-stage gate in
// SilenceSuppressor then interprets this reduced-amplitude speech as silence
// and suppresses it entirely — the user's voice never reaches Deepgram.
//
// With `vad_disabled: true`, the SilenceSuppressor bypasses both the RMS gate
// AND the WebRTC VAD. Every captured frame is forwarded raw to JS/Deepgram,
// which runs its own cloud-side VAD. This matches exactly what SystemAudio
// already does (`for_system_audio()` has a very permissive threshold + the
// caller in macos.rs passes `vadDisabled: true`).
//
// When an external device IS connected, macOS AEC is inactive, signal levels
// are normal, and the local VAD provides useful noise suppression — so
// `vad_disabled` should be false in that case (the TypeScript layer decides).
// ============================================================================

#[napi]
pub struct MicrophoneCapture {
    stop_signal: Arc<AtomicBool>,
    capture_thread: Option<thread::JoinHandle<()>>,
    /// Shared atomic sample rate — updated once the CPAL device is opened.
    sample_rate: Arc<AtomicU32>,
    /// Stores the requested device ID for recreation on restart.
    device_id: Option<String>,
    /// Holds the live CPAL stream. Recreated on each start().
    input: Option<microphone::MicrophoneStream>,
    /// When true, bypass local VAD/RMS gating and forward all audio to JS.
    /// Use this when built-in mic + built-in speakers are in use (macOS AEC
    /// already attenuates the signal; local VAD causes full suppression).
    vad_disabled: bool,
}

#[napi]
impl MicrophoneCapture {
    /// `device_id`   — CPAL device name or `None` for system default.
    /// `vad_disabled` — set `true` when no external audio device is present
    ///                  (built-in mic scenario) to bypass local silence gating.
    #[napi(constructor)]
    pub fn new(device_id: Option<String>, vad_disabled: Option<bool>) -> napi::Result<Self> {
        let vad_disabled = vad_disabled.unwrap_or(false);

        // Eagerly create the stream to detect device errors early and read the
        // native sample rate.
        let input = match microphone::MicrophoneStream::new(device_id.clone()) {
            Ok(i) => i,
            Err(e) => return Err(napi::Error::from_reason(format!("Failed: {}", e))),
        };

        let native_rate = input.sample_rate();
        println!(
            "[MicrophoneCapture] Initialized. Device: {:?}, Rate: {}Hz, vad_disabled: {}",
            device_id, native_rate, vad_disabled
        );

        Ok(MicrophoneCapture {
            stop_signal: Arc::new(AtomicBool::new(false)),
            capture_thread: None,
            sample_rate: Arc::new(AtomicU32::new(native_rate)),
            device_id,
            input: Some(input),
            vad_disabled,
        })
    }

    #[napi]
    pub fn get_sample_rate(&self) -> u32 {
        self.sample_rate.load(Ordering::Acquire)
    }

    #[napi]
    pub fn get_output_sample_rate(&self) -> u32 {
        16000  // Resampler always outputs 16kHz (or mic is natively 16kHz)
    }

    #[napi]
    pub fn start(
        &mut self,
        callback: ThreadsafeFunction<Buffer>,
        on_speech_ended: Option<ThreadsafeFunction<bool>>,
    ) -> napi::Result<()> {
        let tsfn = callback;
        let speech_ended_tsfn = on_speech_ended;
        let vad_disabled = self.vad_disabled;

        // Reset APM state exactly once per meeting. MicrophoneCapture::start() is called
        // only at meeting start — unlike SystemAudioCapture::start() which is called on
        // every VAD-lockout restart. Resetting here means SCK restarts don't wipe the
        // AEC3 echo model mid-meeting.
        #[cfg(not(target_os = "windows"))]
        WEBRTC_APM.reinitialize();
        APM_RENDER_FRAMES.store(0, Ordering::SeqCst);
        println!("[WebRtcAec] APM reset for new meeting");

        self.stop_signal.store(false, Ordering::SeqCst);
        let stop_signal = self.stop_signal.clone();

        // If the stream was consumed by a previous start() cycle, recreate it.
        // This is the fix for the one-shot take_consumer() bug.
        if self.input.is_none() {
            println!("[MicrophoneCapture] Recreating CPAL stream for restart...");
            match microphone::MicrophoneStream::new(self.device_id.clone()) {
                Ok(i) => {
                    let rate = i.sample_rate();
                    self.sample_rate.store(rate, Ordering::Release);
                    self.input = Some(i);
                }
                Err(e) => {
                    return Err(napi::Error::from_reason(format!(
                        "[MicrophoneCapture] Failed to recreate stream: {}",
                        e
                    )));
                }
            }
        }

        let input_ref = self
            .input
            .as_mut()
            .ok_or_else(|| napi::Error::from_reason("Input missing"))?;

        input_ref
            .play()
            .map_err(|e| napi::Error::from_reason(format!("{}", e)))?;

        let native_rate = input_ref.sample_rate();
        self.sample_rate.store(native_rate, Ordering::Release);

        let mut consumer = input_ref
            .take_consumer()
            .ok_or_else(|| napi::Error::from_reason("Failed to get consumer"))?;

        // Create resampler for mic (same as SystemAudio path — always output 16kHz)
        let mut resampler = if native_rate != 16000 {
            match Resampler::new(native_rate as f64) {
                Ok(r) => {
                    println!("[MicrophoneCapture] Resampler: {}Hz → 16000Hz", native_rate);
                    Some(r)
                }
                Err(e) => {
                    eprintln!("[MicrophoneCapture] Resampler creation failed: {} — sending at native rate", e);
                    None
                }
            }
        } else {
            println!("[MicrophoneCapture] Native rate is 16kHz — no resampling needed");
            None
        };

        // DSP thread: conditionally applies silence suppression + WebRTC VAD.
        // When vad_disabled=true, all frames are forwarded immediately (passthrough).
        self.capture_thread = Some(thread::spawn(move || {
            // Build suppressor regardless — used only when vad_disabled=false.
            // When vad_disabled=true, we skip suppressor.process() entirely.
            let mut suppressor = SilenceSuppressor::new(SilenceSuppressionConfig {
                native_sample_rate: native_rate,
                ..SilenceSuppressionConfig::for_microphone()
            });

            // Per-thread AEC3 capture path accumulator (not shared — owned by this thread).
            let mut apm_capture = ApmCapture::new(std::sync::Arc::clone(&WEBRTC_APM));

            // 20ms chunks at native rate
            let chunk_size = (native_rate as usize / 1000) * 20;
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(chunk_size * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);

            println!(
                "[MicrophoneCapture] DSP thread started (vad_disabled={}, rate={}Hz, chunk={})",
                vad_disabled, native_rate, chunk_size
            );

            loop {
                if stop_signal.load(Ordering::Relaxed) {
                    break;
                }

                // 1. Drain ALL available samples from ring buffer (lock-free)
                while let Some(sample) = consumer.try_pop() {
                    raw_batch.push(sample);
                }

                // 2. Convert f32 -> i16 at native sample rate
                if !raw_batch.is_empty() {
                    for &f in &raw_batch {
                        let scaled = (f * 32767.0).clamp(-32768.0, 32767.0);
                        frame_buffer.push(scaled as i16);
                    }
                    raw_batch.clear();
                }

                // 3. Process in 20ms chunks
                while frame_buffer.len() >= chunk_size {
                    let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();

                    if vad_disabled {
                        // ── PASSTHROUGH MODE ─────────────────────────────────
                        // Built-in mic + built-in speakers: resample to 16 kHz,
                        // run AEC to cancel speaker bleed, then emit.
                        let resampled: Vec<i16> = if let Some(ref mut rs) = resampler {
                            let f32_data: Vec<f32> = frame.iter().map(|&s| s as f32 / 32767.0).collect();
                            match rs.resample(&f32_data) {
                                Ok(r) if !r.is_empty() => r,
                                Ok(_) => continue, // resampler needs more input
                                Err(e) => {
                                    eprintln!("[MicrophoneCapture] Resample error: {} — using original", e);
                                    frame
                                }
                            }
                        } else {
                            frame
                        };

                        if !resampled.is_empty() {
                            let speaker_on = SPEAKER_ACTIVE.load(Ordering::Acquire);
                            let warming_up = APM_RENDER_FRAMES.load(Ordering::Acquire) < APM_WARMUP_FRAMES;
                            if speaker_on || warming_up {
                                // Primary gate: mute mic while speaker is active, or while
                                // AEC3 is warming up (< 100 ms of render frames received).
                                tsfn.call(
                                    Ok(Buffer::from(vec![0u8; resampled.len() * 2])),
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                            } else {
                                // Speaker silent: AEC3 cleans up any residual room echo.
                                let cleaned = apm_capture.process(&resampled);
                                if !cleaned.is_empty() {
                                    tsfn.call(
                                        Ok(Buffer::from(i16_slice_to_le_bytes(&cleaned))),
                                        ThreadsafeFunctionCallMode::NonBlocking,
                                    );
                                }
                            }
                        }
                    } else {
                        // ── VAD-GATED MODE ────────────────────────────────────
                        // External device (earbuds/headphones): signal level is
                        // normal. Apply two-stage RMS + WebRTC VAD gate, then
                        // resample to 16kHz before emitting.
                        let (action, speech_ended) = suppressor.process(&frame);

                        match action {
                            FrameAction::Send(data) => {
                                let resampled: Vec<i16> = if let Some(ref mut rs) = resampler {
                                    let f32_data: Vec<f32> = data.iter().map(|&s| s as f32 / 32767.0).collect();
                                    match rs.resample(&f32_data) {
                                        Ok(r) if !r.is_empty() => r,
                                        Ok(_) => continue,
                                        Err(e) => {
                                            eprintln!("[MicrophoneCapture] Resample error: {} — using original", e);
                                            data
                                        }
                                    }
                                } else {
                                    data
                                };

                                if !resampled.is_empty() {
                                    let speaker_on = SPEAKER_ACTIVE.load(Ordering::Acquire);
                                    let warming_up = APM_RENDER_FRAMES.load(Ordering::Acquire) < APM_WARMUP_FRAMES;
                                    if speaker_on || warming_up {
                                        tsfn.call(
                                            Ok(Buffer::from(vec![0u8; resampled.len() * 2])),
                                            ThreadsafeFunctionCallMode::NonBlocking,
                                        );
                                    } else {
                                        let cleaned = apm_capture.process(&resampled);
                                        if !cleaned.is_empty() {
                                            tsfn.call(
                                                Ok(Buffer::from(i16_slice_to_le_bytes(&cleaned))),
                                                ThreadsafeFunctionCallMode::NonBlocking,
                                            );
                                        }
                                    }
                                }
                            }
                            FrameAction::SendSilence => {
                                // Keepalive: send zeros at 16kHz size
                                let silence_samples = if resampler.is_some() { 320usize } else { chunk_size };
                                let silence = vec![0u8; silence_samples * 2];
                                tsfn.call(
                                    Ok(Buffer::from(silence)),
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                            }
                            FrameAction::Suppress => {
                                // Do nothing — local VAD filtered this frame
                            }
                        }

                        if speech_ended {
                            if let Some(ref se_tsfn) = speech_ended_tsfn {
                                se_tsfn.call(Ok(true), ThreadsafeFunctionCallMode::NonBlocking);
                            }
                        }
                    }
                }

                // 4. Short sleep
                thread::sleep(Duration::from_millis(DSP_POLL_MS));
            }

            println!("[MicrophoneCapture] DSP thread stopped.");
        }));

        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) {
        self.stop_signal.store(true, Ordering::SeqCst);
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
        // Pause and destroy the CPAL stream so start() recreates it fresh.
        if let Some(ref input) = self.input {
            let _ = input.pause();
        }
        self.input = None;
    }
}

// ============================================================================
// DEVICE ENUMERATION
// ============================================================================

#[napi(object)]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
}

#[napi]
pub fn get_input_devices() -> Vec<AudioDeviceInfo> {
    match microphone::list_input_devices() {
        Ok(devs) => devs
            .into_iter()
            .map(|(id, name)| AudioDeviceInfo { id, name })
            .collect(),
        Err(e) => {
            eprintln!("[get_input_devices] Error: {}", e);
            Vec::new()
        }
    }
}

#[napi]
pub fn get_output_devices() -> Vec<AudioDeviceInfo> {
    match speaker::list_output_devices() {
        Ok(devs) => devs
            .into_iter()
            .map(|(id, name)| AudioDeviceInfo { id, name })
            .collect(),
        Err(e) => {
            eprintln!("[get_output_devices] Error: {}", e);
            Vec::new()
        }
    }
}