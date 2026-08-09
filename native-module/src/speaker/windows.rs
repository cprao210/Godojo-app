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
        let init_result = (|| -> Result<_> {
            // COM apartment init is per-thread and this is a fresh std::thread — the
            // wasapi crate does NOT init COM internally, so MMDeviceEnumerator calls
            // below would fail with CO_E_NOTINITIALIZED without this. Harmless if the
            // apartment already exists.
            let _ = wasapi::initialize_mta();

            let device = match device_id {
                Some(ref id) => match find_device_by_id(&Direction::Render, id) {
                    Some(d) => d,
                    // A stale/removed device id must not panic the capture thread —
                    // propagate as Err so stream() reports init failure gracefully.
                    None => get_default_device(&Direction::Render)
                        .map_err(|e| anyhow::anyhow!("{}", e))?,
                },
                None => {
                    get_default_device(&Direction::Render).map_err(|e| anyhow::anyhow!("{}", e))?
                }
            };

            // Probe the device mix format for the native rate + channel count.
            let probe_client = device
                .get_iaudioclient()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let device_format = probe_client
                .get_mixformat()
                .map_err(|e| anyhow::anyhow!("{}", e))?;
            let actual_rate = device_format.get_samplespersec();
            let native_channels = device_format.get_nchannels();
            drop(probe_client);

            // Try a mono format first (WASAPI AUTOCONVERTPCM downmixes for us). If the
            // driver rejects the mono format under the loopback flag, fall back to the
            // device's native channel count and downmix to mono ourselves in the read
            // loop. Without this fallback a mono-hostile driver kills capture entirely.
            //
            // For WASAPI loopback the device is Render but the client is initialized
            // with Direction::Capture, which triggers AUDCLNT_STREAMFLAGS_LOOPBACK.
            let mut init_pick: Option<(_, _, _, u16)> = None;
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
                    actual_rate as usize,
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
                    error!(
                        "initialize_client failed at {} channel(s): {}",
                        channels, e
                    );
                    continue;
                }
                let h_event = match audio_client.set_get_eventhandle() {
                    Ok(h) => h,
                    Err(e) => {
                        error!("set_get_eventhandle failed: {}", e);
                        continue;
                    }
                };
                let render_client = match audio_client.get_audiocaptureclient() {
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
                init_pick = Some((h_event, render_client, audio_client, channels));
                break;
            }

            let (h_event, render_client, audio_client, channels) = init_pick.ok_or_else(|| {
                anyhow::anyhow!("Failed to initialize WASAPI loopback (mono and native channel count both failed)")
            })?;

            Ok((h_event, render_client, actual_rate, audio_client, channels))
        })();

        match init_result {
            Ok((h_event, render_client, sample_rate, audio_client, channels)) => {
                let _ = init_tx.send(Ok(sample_rate));
                let ch = channels.max(1) as usize;
                let frame_bytes = 4 * ch; // 32-bit float per channel

                // Keeps the sample ring continuously fed during render-idle periods.
                // WASAPI event-driven loopback fires NO event while nothing is playing
                // on the render endpoint, so the old `wait_for_event(3000) -> break`
                // killed capture after ~3s of far-end silence. Instead we poll on a
                // short timeout and synthesize silence (the truthful signal — nothing
                // is playing) to match the macOS tap, keeping the DSP loop fed and the
                // AEC render timeline gap-free. Only a run of genuine read errors
                // (device invalidation) exits the loop, handing off to the JS
                // last-resort watchdog for a full restart.
                let mut last_fill = Instant::now();
                let mut consecutive_read_errors: u32 = 0;
                const MAX_CONSECUTIVE_READ_ERRORS: u32 = 10;
                let mut synth_accum_ms: u128 = 0;

                loop {
                    {
                        let state = waker_state.lock().unwrap();
                        if state.shutdown {
                            let _ = audio_client.stop_stream();
                            break;
                        }
                    }

                    // A timeout here is EXPECTED during silence — not an error.
                    let _ = h_event.wait_for_event(200);

                    let mut temp_queue = VecDeque::new();
                    match render_client.read_from_device_to_deque(frame_bytes, &mut temp_queue) {
                        Ok(_) => {
                            consecutive_read_errors = 0;

                            if temp_queue.is_empty() {
                                // Render endpoint idle — synthesize silence proportional
                                // to real elapsed time (capped so a long stall/suspend
                                // can't flood the ring).
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
                            if consecutive_read_errors >= MAX_CONSECUTIVE_READ_ERRORS {
                                error!("Capture device invalidated — exiting capture loop");
                                let _ = audio_client.stop_stream();
                                break;
                            }
                            // Brief backoff so a persistent error doesn't spin the CPU.
                            thread::sleep(Duration::from_millis(50));
                            continue;
                        }
                    }
                }
            }
            Err(e) => {
                let _ = init_tx.send(Err(e));
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
