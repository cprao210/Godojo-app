#![deny(clippy::all)]

#[macro_use]
extern crate napi_derive;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use once_cell::sync::Lazy;
use ringbuf::traits::Consumer;

pub mod audio_config;
pub mod echo_align;
pub mod echo_control;
pub mod license;
pub mod microphone;
pub mod output_route;
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
static WEBRTC_APM: Lazy<std::sync::Arc<webrtc_audio_processing::Processor>> =
    Lazy::new(webrtc_aec::create_processor);

// Echo gating policy lives in echo_control (mode flag, headphone bypass,
// convergence-tracked soft gate). Legacy statics SPEAKER_ACTIVE /
// APM_RENDER_FRAMES moved there too — the system-audio loop still feeds them
// so `legacy` mode reproduces the original gate exactly.
use crate::echo_control::{APM_RENDER_FRAMES, SPEAKER_ACTIVE};

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
// SHARED OPTIONS
// ============================================================================

/// Optional trailing options object accepted by both capture constructors.
/// Backward compatible: older JS that omits it (or passes extra unknown keys)
/// keeps working against a newer .node, and vice versa.
#[napi(object)]
#[derive(Default)]
pub struct CaptureOptions {
    /// Echo pipeline mode: "legacy" | "phase1" | "full_duplex".
    /// Overrides the NATIVELY_ECHO_MODE env var. Unknown values are ignored.
    pub echo_mode: Option<String>,
    /// Bypass the local RMS+VAD gate (see MicrophoneCapture docs).
    pub vad_disabled: Option<bool>,
    /// Persisted echo-alignment seed from a previous session on this machine
    /// (ms, signed EFFECTIVE offset: positive = render delayed, negative =
    /// capture delayed) — pass back the applied_align_offset_ms value from
    /// getAudioPipelineStats(). Omitted/undefined = no seed for the current
    /// route (the session starts unseeded / on the backend default); 0 is a
    /// REAL seed meaning "converged with no alignment applied". Consumed by
    /// MicrophoneCapture only; applied on the next mic-session start
    /// (full_duplex only — legacy/phase1 always run with zero delay targets).
    pub echo_align_seed_ms: Option<i32>,
}

fn apply_capture_options(options: &Option<CaptureOptions>) {
    if let Some(opts) = options {
        if let Some(ref m) = opts.echo_mode {
            echo_control::set_mode_from_str(m);
        }
    }
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
    pub fn new(device_id: Option<String>, options: Option<CaptureOptions>) -> napi::Result<Self> {
        println!("[SystemAudioCapture] Created (device: {:?})", device_id);
        apply_capture_options(&options);

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
        // (behind the echo_control refcount) which fires once per session.
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

            // Record the active render backend (stats + alignment seeding).
            echo_control::set_render_backend(input.backend_name());

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
            // Envelope timestamps + optional alignment delay for the render feed.
            let mut env_clock = echo_align::EnvClock::new();
            let mut render_delay = echo_align::DelayBuffer::new();

            // Drain any backlog buffered during the 5-7 s init (SCK's 128K
            // ring can hold ~2.7 s): stale samples would poison the EnvClock
            // anchors and feed AEC3 an out-of-time render reference.
            let mut stale = 0usize;
            while consumer.try_pop().is_some() {
                stale += 1;
            }
            if stale > 0 {
                println!(
                    "[SystemAudioCapture] discarded {} stale ring samples before DSP start",
                    stale
                );
            }

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

                // Process in 20ms chunks
                while frame_buffer.len() >= chunk_size {
                    let frame: Vec<i16> = frame_buffer.drain(0..chunk_size).collect();

                    // STT gating decision (silence suppression is for STT cost
                    // only — the AEC render feed below is continuous).
                    let (action, speech_ended) = suppressor.process(&frame);

                    // Resample EVERY chunk. The resampler is stateful and the
                    // AEC3 render timeline must be gap-free: feeding render
                    // only during speech shifts AEC3's delay estimator every
                    // time the far end pauses (this was the original
                    // convergence killer, together with capture starvation).
                    let resampled_16k: Vec<i16> = if let Some(ref mut rs) = resampler {
                        let f32_data: Vec<f32> =
                            frame.iter().map(|&s| s as f32 / 32767.0).collect();
                        match rs.resample(&f32_data) {
                            Ok(r) => r,
                            Err(e) => {
                                eprintln!(
                                    "[SystemAudioCapture] Resample error: {} — using original",
                                    e
                                );
                                frame.clone()
                            }
                        }
                    } else {
                        frame.clone()
                    };

                    if !resampled_16k.is_empty() {
                        // Gate timestamp + delay-estimator envelope (pre-align tap).
                        echo_control::note_render_frame(&resampled_16k, &mut env_clock);
                        // Optional alignment delay (full_duplex): re-times the
                        // reference so it stays causally close to the acoustic
                        // echo instead of leading it by hundreds of ms.
                        let target = echo_align::TARGET_RENDER_DELAY_MS.load(Ordering::Acquire);
                        let delayed = render_delay.process(&resampled_16k, target);
                        if !delayed.is_empty() {
                            let frames = apm_render.push(&delayed);
                            APM_RENDER_FRAMES.fetch_add(frames, Ordering::Release);
                        }
                    }

                    match action {
                        FrameAction::Send(_) => {
                            // Legacy gate input: speaker is producing speech.
                            SPEAKER_ACTIVE.store(true, Ordering::Release);
                            if !resampled_16k.is_empty() {
                                tsfn.call(
                                    Ok(Buffer::from(i16_slice_to_le_bytes(&resampled_16k))),
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                            }
                        }
                        FrameAction::SendSilence => {
                            SPEAKER_ACTIVE.store(false, Ordering::Release);
                            let silence_16k = if resampler.is_some() { 320usize } else { chunk_size };
                            let silence = vec![0u8; silence_16k * 2];
                            tsfn.call(
                                Ok(Buffer::from(silence)),
                                ThreadsafeFunctionCallMode::NonBlocking,
                            );
                        }
                        FrameAction::Suppress => {
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
// `vad_disabled` option: when the user has NO external audio device (built-in
// mic + built-in speakers), macOS Acoustic Echo Cancellation (AEC) already
// attenuates the microphone signal. The two-stage gate in SilenceSuppressor
// then interprets this reduced-amplitude speech as silence and suppresses it
// entirely — the user's voice never reaches Deepgram.
//
// With `vad_disabled: true`, the SilenceSuppressor bypasses both the RMS gate
// AND the WebRTC VAD. Every captured frame is forwarded raw to JS/Deepgram,
// which runs its own cloud-side VAD.
//
// Echo handling: in EVERY mode the mic runs through AEC3 (apm_capture) on
// every frame — processing must be continuous for AEC3's filters and delay
// estimator to converge. What changes per echo_control mode is only the EMIT
// decision (cleaned audio, ducked audio, or zeros — GateAction), owned by
// echo_control::MicGate.
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
    vad_disabled: bool,
    /// Tracks whether this instance is registered in the echo_control
    /// refcount (guards against double stop()).
    registered: bool,
}

#[napi]
impl MicrophoneCapture {
    /// `device_id`    — CPAL device name or `None` for system default.
    /// `vad_disabled` — set `true` when no external audio device is present
    ///                  (built-in mic scenario) to bypass local silence gating.
    /// `options`      — optional CaptureOptions (echo pipeline mode etc.).
    #[napi(constructor)]
    pub fn new(
        device_id: Option<String>,
        vad_disabled: Option<bool>,
        options: Option<CaptureOptions>,
    ) -> napi::Result<Self> {
        let vad_disabled = vad_disabled
            .or(options.as_ref().and_then(|o| o.vad_disabled))
            .unwrap_or(false);
        apply_capture_options(&options);
        // Alignment-seed contract (mic captures only): each construction
        // either provides the persisted seed for the CURRENT route or omits
        // it, meaning "start unseeded" — an omitted seed must clear any
        // previous construction's value so a stale seed never leaks across
        // routes/sessions.
        echo_control::set_pending_align_seed(
            options.as_ref().and_then(|o| o.echo_align_seed_ms),
        );

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
            registered: false,
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

        // Re-apply the APM config for the active mode (stream-delay hint is
        // mode-dependent), then register with the echo_control refcount.
        // The APM reset happens only on the 0→1 transition, so a settings
        // audio-test running next to a live meeting no longer wipes the
        // meeting's AEC state.
        webrtc_aec::apply_mode_config(
            &WEBRTC_APM,
            echo_control::mode() == echo_control::EchoMode::FullDuplex,
        );
        if !self.registered {
            echo_control::on_mic_start(&WEBRTC_APM);
            self.registered = true;
        }
        // Output-route watcher (headphone detection) — one per process.
        echo_control::ensure_route_watcher(std::sync::Arc::clone(&WEBRTC_APM));

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
            // Gate policy driver + delay-estimator envelope clock + optional
            // capture-side alignment delay (reference-late contingency only).
            let mut gate = echo_control::MicGate::new(std::sync::Arc::clone(&WEBRTC_APM));
            let mut env_clock = echo_align::EnvClock::new();
            let mut capture_delay = echo_align::DelayBuffer::new();

            // 20ms chunks at native rate
            let chunk_size = (native_rate as usize / 1000) * 20;
            let mut frame_buffer: Vec<i16> = Vec::with_capacity(chunk_size * 4);
            let mut raw_batch: Vec<f32> = Vec::with_capacity(4096);

            println!(
                "[MicrophoneCapture] DSP thread started (vad_disabled={}, rate={}Hz, chunk={})",
                vad_disabled, native_rate, chunk_size
            );

            // Shared per-frame DSP: envelope tap → optional alignment delay →
            // AEC3. Returns the cleaned frame (may be empty while the 10 ms
            // accumulators fill). Runs on EVERY frame — suppressed ones too —
            // so AEC3's filters and delay estimator never starve.
            let process_through_aec = |resampled: &[i16],
                                       apm_capture: &mut ApmCapture,
                                       env_clock: &mut echo_align::EnvClock,
                                       capture_delay: &mut echo_align::DelayBuffer|
             -> Vec<i16> {
                echo_control::note_capture_frame(resampled, env_clock);
                let target = echo_align::TARGET_CAPTURE_DELAY_MS.load(Ordering::Acquire);
                let delayed = capture_delay.process(resampled, target);
                if delayed.is_empty() {
                    return Vec::new();
                }
                apm_capture.process(&delayed)
            };

            // Gate decision → emit cleaned audio, ducked audio, or zeros.
            let emit_gated = |cleaned: &[i16],
                              gate: &mut echo_control::MicGate,
                              tsfn: &ThreadsafeFunction<Buffer>| {
                match gate.decide(cleaned) {
                    echo_control::GateAction::Emit => {
                        tsfn.call(
                            Ok(Buffer::from(i16_slice_to_le_bytes(cleaned))),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    echo_control::GateAction::Duck(g) => {
                        let ducked: Vec<i16> =
                            cleaned.iter().map(|&s| (s as f32 * g) as i16).collect();
                        tsfn.call(
                            Ok(Buffer::from(i16_slice_to_le_bytes(&ducked))),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                    echo_control::GateAction::Mute => {
                        tsfn.call(
                            Ok(Buffer::from(vec![0u8; cleaned.len() * 2])),
                            ThreadsafeFunctionCallMode::NonBlocking,
                        );
                    }
                }
            };

            // Drain any backlog buffered between stream start and DSP-loop
            // entry — stale samples poison the EnvClock anchors and the APM
            // capture timeline.
            let mut stale = 0usize;
            while consumer.try_pop().is_some() {
                stale += 1;
            }
            if stale > 0 {
                println!(
                    "[MicrophoneCapture] discarded {} stale ring samples before DSP start",
                    stale
                );
            }

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
                        // run AEC + gate, then emit.
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
                            let cleaned = process_through_aec(
                                &resampled,
                                &mut apm_capture,
                                &mut env_clock,
                                &mut capture_delay,
                            );
                            if !cleaned.is_empty() {
                                emit_gated(&cleaned, &mut gate, &tsfn);
                            }
                        }
                    } else {
                        // ── VAD-GATED MODE ────────────────────────────────────
                        // External device: signal level is normal. Apply the
                        // two-stage RMS + WebRTC VAD gate for STT cost. EVERY
                        // frame — Suppress/SendSilence included — still runs
                        // through the AEC pipeline so the APM capture feed is
                        // continuous; only the EMIT decision differs per action.
                        let (action, speech_ended) = suppressor.process(&frame);

                        // Resample every chunk (FrameAction::Send always
                        // carries the unmodified input frame, so resampling
                        // `frame` covers all actions).
                        let resampled: Vec<i16> = if let Some(ref mut rs) = resampler {
                            let f32_data: Vec<f32> =
                                frame.iter().map(|&s| s as f32 / 32767.0).collect();
                            match rs.resample(&f32_data) {
                                Ok(r) => r,
                                Err(e) => {
                                    eprintln!("[MicrophoneCapture] Resample error: {} — using original", e);
                                    frame.clone()
                                }
                            }
                        } else {
                            frame.clone()
                        };

                        let cleaned = if resampled.is_empty() {
                            Vec::new() // resampler needs more input
                        } else {
                            process_through_aec(
                                &resampled,
                                &mut apm_capture,
                                &mut env_clock,
                                &mut capture_delay,
                            )
                        };

                        match action {
                            FrameAction::Send(_) => {
                                if !cleaned.is_empty() {
                                    emit_gated(&cleaned, &mut gate, &tsfn);
                                }
                            }
                            FrameAction::SendSilence => {
                                // Keepalive: send zeros at 16kHz size (the
                                // frame already fed AEC3 above).
                                let silence_samples = if resampler.is_some() { 320usize } else { chunk_size };
                                let silence = vec![0u8; silence_samples * 2];
                                tsfn.call(
                                    Ok(Buffer::from(silence)),
                                    ThreadsafeFunctionCallMode::NonBlocking,
                                );
                            }
                            FrameAction::Suppress => {
                                // Local VAD filtered this frame for STT cost —
                                // emit nothing (AEC3 still saw it above).
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
        if self.registered {
            echo_control::on_mic_stop();
            self.registered = false;
        }
        // Pause and destroy the CPAL stream so start() recreates it fresh.
        if let Some(ref input) = self.input {
            let _ = input.pause();
        }
        self.input = None;
    }
}

// ============================================================================
// DEVICE ENUMERATION + PIPELINE INTROSPECTION
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

#[napi(object)]
pub struct OutputRouteJs {
    /// "headphones" | "speakers" | "unknown"
    pub kind: String,
    pub transport: String,
    pub name: String,
}

/// Classify the current default output device: headphones have no acoustic
/// path to the mic, so the echo gate is bypassed while they are active.
#[napi]
pub fn get_output_route() -> OutputRouteJs {
    let r = output_route::current_output_route();
    OutputRouteJs {
        kind: r.kind.as_str().to_string(),
        transport: r.transport,
        name: r.name,
    }
}

/// JSON snapshot of the echo pipeline (mode, gate state, ERLE, delay,
/// alignment, mute ratio). Poll from JS for field telemetry / debug panel.
#[napi]
pub fn get_audio_pipeline_stats() -> String {
    echo_control::pipeline_stats_json(&WEBRTC_APM)
}
