// Ported logic
use crate::audio_config::RING_BUFFER_SAMPLES;
use anyhow::Result;
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::collections::VecDeque;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tracing::error;
use wasapi::{get_default_device, DeviceCollection, Direction, SampleType, ShareMode, WaveFormat};

struct WakerState {
    shutdown: bool,
}

pub struct SpeakerInput {
    device_id: Option<String>,
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    waker_state: Arc<Mutex<WakerState>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    actual_sample_rate: u32,
    data_ready: Arc<(Mutex<bool>, Condvar)>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.actual_sample_rate
    }

    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }

    pub fn data_ready_signal(&self) -> Arc<(Mutex<bool>, Condvar)> {
        self.data_ready.clone()
    }
}

// Helper to find device by ID
fn find_device_by_id(direction: &Direction, device_id: &str) -> Option<wasapi::Device> {
    let collection = DeviceCollection::new(direction).ok()?;
    let count = collection.get_nbr_devices().ok()?;

    for i in 0..count {
        if let Ok(device) = collection.get_device_at_index(i) {
            if let Ok(id) = device.get_id() {
                if id == device_id {
                    return Some(device);
                }
            }
        }
    }
    None
}

/// One initialized WASAPI loopback session.
///
/// Owned by the capture thread and REPLACED IN PLACE when the render endpoint
/// moves. Everything here is bound to a single endpoint at initialize time —
/// which is exactly why plugging in a headset used to kill interviewer audio
/// until the meeting was paused and resumed: the client kept happily reading
/// from an endpoint nothing was playing to any more.
struct LoopbackSession {
    h_event: wasapi::Handle,
    capture_client: wasapi::AudioCaptureClient,
    audio_client: wasapi::AudioClient,
    channels: u16,
    rate: u32,
    device_id: String,
}

/// Id of the current default render endpoint, or None if it cannot be read.
/// Cheap enough to poll (a COM enumerator call, no stream work).
fn default_render_id() -> Option<String> {
    get_default_device(&Direction::Render).ok()?.get_id().ok()
}

/// Open a loopback capture session on `device_id` (or the default endpoint).
///
/// `pinned_rate` keeps the ring's sample rate INVARIANT across an endpoint
/// swap. The DSP thread builds its resampler once from the rate reported at
/// init, so re-opening at a different rate would resample with the wrong ratio
/// (pitch-shifted, wrong-length frames). WASAPI's own SRC absorbs the
/// difference — `convert = true` is documented as enabling automatic samplerate
/// and format conversion — so the swap stays invisible above this layer.
fn open_loopback(device_id: Option<&str>, pinned_rate: Option<u32>) -> Result<LoopbackSession> {
    // COM apartment init is per-thread. Harmless if it already exists, and
    // required here because re-opens can run long after thread start.
    let _ = wasapi::initialize_mta();

    let device = match device_id {
        Some(id) => match find_device_by_id(&Direction::Render, id) {
            Some(d) => d,
            // A stale/removed device id must not kill capture — fall back to
            // the default endpoint rather than propagating a hard failure.
            None => get_default_device(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?,
        },
        None => get_default_device(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?,
    };
    let opened_id = device.get_id().unwrap_or_default();

    // Probe the device mix format for the native rate + channel count.
    let probe_client = device
        .get_iaudioclient()
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    let device_format = probe_client
        .get_mixformat()
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    let native_rate = device_format.get_samplespersec();
    let native_channels = device_format.get_nchannels();
    drop(probe_client);

    // First open adopts the endpoint's own rate; every later open keeps the rate
    // the DSP thread was built for.
    let target_rate = pinned_rate.unwrap_or(native_rate);

    // Try a mono format first (WASAPI AUTOCONVERTPCM downmixes for us). If the
    // driver rejects the mono format under the loopback flag, fall back to the
    // device's native channel count and downmix to mono ourselves in the read
    // loop. Without this fallback a mono-hostile driver kills capture entirely.
    //
    // For WASAPI loopback the device is Render but the client is initialized
    // with Direction::Capture, which triggers AUDCLNT_STREAMFLAGS_LOOPBACK.
    for &channels in &[1u16, native_channels] {
        if channels == 0 {
            continue;
        }
        let mut audio_client = match device.get_iaudioclient() {
            Ok(c) => c,
            Err(e) => {
                error!("get_iaudioclient failed: {}", e);
                continue;
            }
        };
        let fmt = WaveFormat::new(
            32,
            32,
            &SampleType::Float,
            target_rate as usize,
            channels as usize,
            None,
        );
        let (_def_time, min_time) = match audio_client.get_periods() {
            Ok(p) => p,
            Err(e) => {
                error!("get_periods failed: {}", e);
                continue;
            }
        };
        if let Err(e) = audio_client.initialize_client(
            &fmt,
            min_time,
            &Direction::Capture,
            &ShareMode::Shared,
            true,
        ) {
            error!("initialize_client failed at {} channel(s): {}", channels, e);
            continue;
        }
        let h_event = match audio_client.set_get_eventhandle() {
            Ok(h) => h,
            Err(e) => {
                error!("set_get_eventhandle failed: {}", e);
                continue;
            }
        };
        let capture_client = match audio_client.get_audiocaptureclient() {
            Ok(r) => r,
            Err(e) => {
                error!("get_audiocaptureclient failed: {}", e);
                continue;
            }
        };
        if let Err(e) = audio_client.start_stream() {
            error!("start_stream failed: {}", e);
            continue;
        }
        if channels != 1 {
            error!(
                "Mono loopback unavailable — capturing {} channels and downmixing",
                channels
            );
        }
        println!(
            "[wasapi] loopback open: device=\"{}\" {}Hz {}ch (native {}Hz {}ch)",
            opened_id, target_rate, channels, native_rate, native_channels
        );
        return Ok(LoopbackSession {
            h_event,
            capture_client,
            audio_client,
            channels,
            rate: target_rate,
            device_id: opened_id,
        });
    }

    Err(anyhow::anyhow!(
        "Failed to initialize WASAPI loopback on '{}' at {}Hz (mono and {}-channel both failed)",
        opened_id,
        target_rate,
        native_channels
    ))
}

// ── Capture-loop tuning ─────────────────────────────────────────────────────
/// How often the capture thread asks the OS which render endpoint is default.
/// One COM enumerate; the cost is noise next to the 20ms DSP frames, and this is
/// the ONLY signal that a loopback client's endpoint has been abandoned — WASAPI
/// keeps returning success (and silence) from an endpoint nothing plays to.
const ROUTE_POLL_MS: u64 = 500;
/// Consecutive read failures before we treat the endpoint as invalidated.
const MAX_CONSECUTIVE_READ_ERRORS: u32 = 10;
/// Pause between in-thread re-open rounds.
const REOPEN_BACKOFF_MS: u64 = 500;
/// Give up in-thread recovery after this many failed rounds (~5s) and let the JS
/// supervisor do a full restart, which re-negotiates the rate from scratch.
const MAX_REOPEN_FAILURES: u32 = 5;

/// Replace `session` with a fresh one on the same or a new endpoint.
///
/// `pinned_rate` is mandatory here: the DSP thread upstream was built for that
/// rate, so a re-open must keep it. Returns false when the re-open failed, in
/// which case the previous session is restarted and kept — a transient failure
/// must not tear down a stream that may still recover.
fn reopen_session(session: &mut LoopbackSession, device_id: Option<&str>, pinned_rate: u32) -> bool {
    let _ = session.audio_client.stop_stream();
    match open_loopback(device_id, Some(pinned_rate)) {
        Ok(next) => {
            // Assigning drops the old session, releasing its COM refs and the
            // endpoint itself.
            *session = next;
            true
        }
        Err(e) => {
            error!("loopback re-open failed: {}", e);
            let _ = session.audio_client.start_stream();
            false
        }
    }
}

pub fn list_output_devices() -> Result<Vec<(String, String)>> {
    // COM apartment init is per-thread; ensure this thread has one before touching
    // MMDeviceEnumerator. Harmless if already initialized.
    let _ = wasapi::initialize_mta();
    let collection =
        DeviceCollection::new(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?;
    let count = collection
        .get_nbr_devices()
        .map_err(|e| anyhow::anyhow!("{}", e))?;
    let mut list = Vec::new();

    for i in 0..count {
        if let Ok(device) = collection.get_device_at_index(i) {
            let id = device.get_id().unwrap_or_default();
            let name = device.get_friendlyname().unwrap_or_default();
            if !id.is_empty() {
                list.push((id, name));
            }
        }
    }
    Ok(list)
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let device_id = device_id.filter(|id| !id.is_empty() && id != "default");
        Ok(Self { device_id })
    }

    /// Stable identifier of the active render backend, reported via
    /// echo_control::set_render_backend for stats + alignment seeding.
    pub fn backend_name(&self) -> &'static str {
        "wasapi_loopback"
    }

    pub fn stream(self) -> SpeakerStream {
        let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES);
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState { shutdown: false }));
        let data_ready = Arc::new((Mutex::new(false), Condvar::new()));
        let (init_tx, init_rx) = mpsc::channel();

        let waker_clone = waker_state.clone();
        let data_ready_clone = data_ready.clone();
        let device_id = self.device_id;

        let capture_thread = thread::spawn(move || {
            if let Err(e) = Self::capture_audio_loop(
                producer,
                waker_clone,
                data_ready_clone,
                init_tx,
                device_id,
            ) {
                error!("Audio capture loop failed: {}", e);
            }
        });

        let actual_sample_rate = match init_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(rate)) => rate,
            Ok(Err(e)) => {
                error!("Audio initialization failed: {}", e);
                44100
            }
            Err(_) => {
                error!("Audio initialization timeout");
                44100
            }
        };

        SpeakerStream {
            consumer: Some(consumer),
            waker_state,
            capture_thread: Some(capture_thread),
            actual_sample_rate,
            data_ready,
        }
    }

    fn capture_audio_loop(
        mut producer: HeapProd<f32>,
        waker_state: Arc<Mutex<WakerState>>,
        data_ready: Arc<(Mutex<bool>, Condvar)>,
        init_tx: mpsc::Sender<Result<u32>>,
        device_id: Option<String>,
    ) -> Result<()> {
        // Init lives in open_loopback() so the SAME code path can re-open the
        // endpoint mid-capture (device swap / invalidation) instead of the loop
        // being a one-shot bound to whatever was default at meeting start.
        let mut session = match open_loopback(device_id.as_deref(), None) {
            Ok(s) => s,
            Err(e) => {
                let _ = init_tx.send(Err(e));
                return Ok(());
            }
        };
        // Pinned for the lifetime of this stream: the DSP thread above built its
        // resampler from the rate we report here exactly once.
        let sample_rate = session.rate;
        let _ = init_tx.send(Ok(sample_rate));

        // `device_id == None` means "whatever the user's default output is", so the
        // thread has to keep following that default. An explicit selection is left
        // alone — the user picked that endpoint on purpose.
        let follow_default = device_id.is_none();
        let mut last_route_check = Instant::now();

        // Keeps the sample ring continuously fed during render-idle periods.
        // WASAPI event-driven loopback fires NO event while nothing is playing on
        // the render endpoint, so the old `wait_for_event(3000) -> break` killed
        // capture after ~3s of far-end silence. Instead we poll on a short timeout
        // and synthesize silence (the truthful signal — nothing is playing) to
        // match the macOS tap, keeping the DSP loop fed and the AEC render
        // timeline gap-free.
        let mut last_fill = Instant::now();
        let mut consecutive_read_errors: u32 = 0;
        let mut reopen_failures: u32 = 0;
        let mut synth_accum_ms: u128 = 0;

        loop {
            {
                let state = waker_state.lock().unwrap();
                if state.shutdown {
                    let _ = session.audio_client.stop_stream();
                    break;
                }
            }

            // Endpoint follow. Plugging in a headset moves the default render
            // device; the client we hold stays bound to the old one and reports
            // eternal silence — precisely the "client audio stops until I pause and
            // resume the meeting" symptom. Re-open in place instead: the rate is
            // pinned, so the DSP and the STT socket above never notice.
            if follow_default
                && last_route_check.elapsed() >= Duration::from_millis(ROUTE_POLL_MS)
            {
                last_route_check = Instant::now();
                if let Some(current) = default_render_id() {
                    if current != session.device_id {
                        println!(
                            "[wasapi] default render endpoint changed -> {} — re-opening loopback",
                            current
                        );
                        if reopen_session(&mut session, None, sample_rate) {
                            consecutive_read_errors = 0;
                            reopen_failures = 0;
                            last_fill = Instant::now();
                        }
                    }
                }
            }

            // The channel count can change across a re-open (a mono-hostile driver
            // forces the native layout), so derive the frame size per iteration.
            let ch = session.channels.max(1) as usize;
            let frame_bytes = 4 * ch; // 32-bit float per channel

            // A timeout here is EXPECTED during silence — not an error.
            let _ = session.h_event.wait_for_event(200);

            let mut temp_queue = VecDeque::new();
            match session
                .capture_client
                .read_from_device_to_deque(frame_bytes, &mut temp_queue)
            {
                Ok(_) => {
                    consecutive_read_errors = 0;
                    reopen_failures = 0;

                    if temp_queue.is_empty() {
                        // Render endpoint idle — synthesize silence proportional to
                        // real elapsed time (capped so a long stall/suspend can't
                        // flood the ring).
                        let elapsed_ms = last_fill.elapsed().as_millis().min(500);
                        let n = (elapsed_ms as usize * sample_rate as usize) / 1000;
                        if n > 0 {
                            let silence = vec![0.0f32; n];
                            let _ = producer.push_slice(&silence);
                            last_fill = Instant::now();

                            synth_accum_ms += elapsed_ms;
                            if synth_accum_ms >= 30_000 {
                                println!(
                                    "[wasapi] synthesized {}ms silence (render idle)",
                                    synth_accum_ms
                                );
                                synth_accum_ms = 0;
                            }

                            let (lock, cvar) = &*data_ready;
                            let mut ready = lock.lock().unwrap();
                            *ready = true;
                            cvar.notify_all();
                        }
                        continue;
                    }

                    // Real data. Parse interleaved f32 and downmix to mono.
                    let mut samples = Vec::with_capacity(temp_queue.len() / frame_bytes);
                    while temp_queue.len() >= frame_bytes {
                        let mut acc = 0.0f32;
                        for _ in 0..ch {
                            let bytes = [
                                temp_queue.pop_front().unwrap(),
                                temp_queue.pop_front().unwrap(),
                                temp_queue.pop_front().unwrap(),
                                temp_queue.pop_front().unwrap(),
                            ];
                            acc += f32::from_le_bytes(bytes);
                        }
                        samples.push(acc / ch as f32);
                    }

                    if !samples.is_empty() {
                        let _ = producer.push_slice(&samples);
                        last_fill = Instant::now();
                        synth_accum_ms = 0;

                        let (lock, cvar) = &*data_ready;
                        let mut ready = lock.lock().unwrap();
                        *ready = true;
                        cvar.notify_all();
                    }
                }
                Err(e) => {
                    consecutive_read_errors += 1;
                    error!(
                        "Failed to read audio data ({}/{}): {}",
                        consecutive_read_errors, MAX_CONSECUTIVE_READ_ERRORS, e
                    );
                    if consecutive_read_errors < MAX_CONSECUTIVE_READ_ERRORS {
                        // Brief backoff so a persistent error doesn't spin the CPU.
                        thread::sleep(Duration::from_millis(50));
                        continue;
                    }

                    // The endpoint is invalidated (unplugged, format changed, driver
                    // reset). The old code broke out here and the channel stayed
                    // dead until the meeting was paused and resumed. Re-open in
                    // place instead — same effect as a full restart, without the
                    // STT churn.
                    consecutive_read_errors = 0;
                    if reopen_session(&mut session, device_id.as_deref(), sample_rate) {
                        reopen_failures = 0;
                        last_fill = Instant::now();
                        continue;
                    }
                    reopen_failures += 1;
                    if reopen_failures >= MAX_REOPEN_FAILURES {
                        // Hand off deliberately: the JS supervisor's restart builds a
                        // brand-new stream, which re-negotiates the sample rate this
                        // thread is obliged to keep pinned.
                        error!(
                            "Capture endpoint unrecoverable after {} re-open attempts — exiting capture loop",
                            reopen_failures
                        );
                        let _ = session.audio_client.stop_stream();
                        break;
                    }
                    thread::sleep(Duration::from_millis(REOPEN_BACKOFF_MS));
                    continue;
                }
            }
        }

        Ok(())
    }
}

// Implement Drop to stop the thread
impl Drop for SpeakerStream {
    fn drop(&mut self) {
        if let Ok(mut state) = self.waker_state.lock() {
            state.shutdown = true;
        }
        if let Some(handle) = self.capture_thread.take() {
            let _ = handle.join();
        }
    }
}
