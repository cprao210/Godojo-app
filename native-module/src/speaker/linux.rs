// System-audio capture on Linux: record the default sink's MONITOR source.
//
// Every PulseAudio sink exposes a companion `<sink>.monitor` source carrying
// exactly what is being played to it — the Linux equivalent of WASAPI loopback
// or the macOS process tap. PipeWire exposes the same thing through
// `pipewire-pulse`, so this single backend covers both. No kernel module
// (`snd-aloop`), no user setup, no root.
//
// Shape deliberately mirrors speaker/windows.rs:
//
//   * The stream rate is PINNED, because the DSP thread upstream builds its
//     resampler exactly once and a rate change mid-stream would desynchronise
//     the AEC render timeline. We go one better than Windows and ask the server
//     for 16 kHz mono directly — Pulse resamples and downmixes server-side
//     (the same role WASAPI's `convert=true` plays), so the DSP needs no
//     resampler at all and an endpoint swap is invisible above this layer.
//
//   * The ring is kept CONTINUOUSLY fed. A monitor source emits real silence
//     while its sink is merely idle, but a *suspended* sink emits nothing, so a
//     watchdog thread tops the ring up with synthesized silence rather than let
//     the DSP starve. That is what `get_native_feature_level() == 2` promises,
//     and it is what makes "no chunks arriving" unambiguously mean stream death.

use crate::audio_config::RING_BUFFER_SAMPLES;
use anyhow::{anyhow, Result};
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use libpulse_binding::def::BufferAttr;
use libpulse_binding::sample::{Format, Spec};
use libpulse_binding::stream::Direction;
use libpulse_simple_binding::Simple;

use super::pulse::PulseProbe;

/// Rate we ask the server to deliver. Matches the pipeline's output rate so the
/// DSP thread skips resampling entirely.
const CAPTURE_RATE: u32 = 16_000;
/// 20 ms at CAPTURE_RATE — one DSP frame, so reads line up with frame edges.
const FRAME_SAMPLES: usize = (CAPTURE_RATE as usize) / 50;
/// How often the watchdog wakes to check liveness and route.
const WATCHDOG_TICK_MS: u64 = 100;
/// A healthy monitor delivers a frame every 20 ms. Past this, assume the sink
/// is suspended and synthesize silence so the DSP keeps ticking.
const SILENCE_TOP_UP_AFTER_MS: u64 = 250;
/// Never inject more than this in one go, even after a long stall — matches the
/// Windows render-idle cap.
const MAX_TOP_UP_MS: u64 = 500;
/// How often to re-check which sink is the default (device hot-swap).
const ROUTE_POLL_MS: u64 = 1000;
/// Consecutive read failures before we tear the stream down and re-resolve the
/// endpoint from the server.
const MAX_CONSECUTIVE_READ_ERRORS: u32 = 10;
/// Pause after a failed read so a hard-failing stream cannot spin a core.
const READ_ERROR_BACKOFF_MS: u64 = 50;
/// Pause between failed reconnects.
const REOPEN_BACKOFF_MS: u64 = 500;
/// How long `Drop` waits for the worker threads before detaching them. The
/// reader can be parked inside a blocking `Simple::read()` and the watchdog
/// inside an introspection round-trip; the JS supervisor's restart path must
/// never hang on either.
const THREAD_EXIT_TIMEOUT_MS: u64 = 1500;

/// State shared by the reader and watchdog threads.
struct Shared {
    /// The ring's producer half. A mutex keeps the logical single-producer
    /// contract while letting the watchdog inject keepalive silence; the DSP
    /// side of the ring stays lock-free.
    producer: Mutex<HeapProd<f32>>,
    /// Monotonic origin for the `*_ms` stamps below (`Instant` is not atomic).
    origin: Instant,
    /// `origin.elapsed()` when the reader last pushed real samples.
    last_data_ms: AtomicU64,
    /// Monitor source the watchdog wants the reader bound to.
    rebind: Mutex<Option<String>>,
    shutdown: Arc<AtomicBool>,
}

pub struct SpeakerInput {
    /// Sink name from JS, or None to follow the default sink.
    device_id: Option<String>,
    /// Monitor source resolved at construction.
    monitor_source: String,
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    shutdown: Arc<AtomicBool>,
    reader_thread: Option<thread::JoinHandle<()>>,
    /// Disconnects once BOTH workers have returned — every clone of the sender
    /// is dropped on thread exit. Gives `Drop` one bounded wait instead of two
    /// unbounded joins.
    threads_exited: mpsc::Receiver<()>,
    watchdog_thread: Option<thread::JoinHandle<()>>,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        CAPTURE_RATE
    }

    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Release);

        // Either worker can be parked in a blocking call: the reader inside
        // `Simple::read()` on a suspended sink, the watchdog inside a Pulse
        // introspection round-trip. So wait for the exit channel to disconnect
        // (all senders dropped == all threads returned) rather than joining
        // blind, and detach on timeout — a detached worker only touches the
        // ring, which is harmless once the consumer is gone, and it still exits
        // on its own the moment its blocking call returns. Blocking here would
        // stall the JS supervisor's restart, which is the worse outcome.
        let exited = matches!(
            self.threads_exited
                .recv_timeout(Duration::from_millis(THREAD_EXIT_TIMEOUT_MS)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );

        if exited {
            if let Some(handle) = self.reader_thread.take() {
                let _ = handle.join();
            }
            if let Some(handle) = self.watchdog_thread.take() {
                let _ = handle.join();
            }
        } else {
            // Leaving the handles in place is the detach: they drop with `self`,
            // and dropping a JoinHandle detaches its thread.
            eprintln!(
                "[pulse] worker threads still parked after {THREAD_EXIT_TIMEOUT_MS}ms — \
                 detaching so the restart is not blocked"
            );
        }
    }
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        // JS sends "" / "default" for "whatever the OS is using".
        let device_id = device_id.filter(|id| !id.is_empty() && id != "default");
        let (monitor_source, sink_rate) = resolve_monitor(device_id.as_deref())?;
        println!(
            "[pulse] monitor source \"{monitor_source}\" (sink runs at {sink_rate}Hz, \
             requesting {CAPTURE_RATE}Hz mono)"
        );
        Ok(Self {
            device_id,
            monitor_source,
        })
    }

    pub fn backend_name(&self) -> &'static str {
        "pulse_monitor"
    }

    pub fn stream(self) -> SpeakerStream {
        let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES);
        let (producer, consumer) = rb.split();

        let shutdown = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Shared {
            producer: Mutex::new(producer),
            origin: Instant::now(),
            last_data_ms: AtomicU64::new(0),
            rebind: Mutex::new(None),
            shutdown: shutdown.clone(),
        });

        // Both workers hold a clone; the receiver disconnects when the last one
        // returns. Nothing is ever sent — disconnection IS the signal.
        let (exit_tx, threads_exited) = mpsc::channel::<()>();
        let reader_thread = {
            let shared = shared.clone();
            let source = self.monitor_source.clone();
            let device_id = self.device_id.clone();
            let exit_tx = exit_tx.clone();
            thread::Builder::new()
                .name("pulse-monitor-reader".into())
                .spawn(move || reader_loop(shared, source, device_id, exit_tx))
                .ok()
        };

        let watchdog_thread = {
            let shared = shared.clone();
            let device_id = self.device_id.clone();
            let source = self.monitor_source.clone();
            thread::Builder::new()
                .name("pulse-monitor-watchdog".into())
                .spawn(move || watchdog_loop(shared, device_id, source, exit_tx))
                .ok()
        };

        SpeakerStream {
            consumer: Some(consumer),
            shutdown,
            reader_thread,
            threads_exited,
            watchdog_thread,
        }
    }
}

/// Which monitor source to record, plus the sink's own rate (for logging).
///
/// `device_id` is a SINK name — the same id `list_output_devices` reports.
/// A stale id silently falls back to the default sink so a device that
/// disappeared between sessions never strands the capture.
fn resolve_monitor(device_id: Option<&str>) -> Result<(String, u32)> {
    let mut probe = PulseProbe::new()?;
    let sinks = probe.list_sinks();
    if sinks.is_empty() {
        return Err(anyhow!(
            "pulse: the sound server reported no output sinks — nothing to monitor"
        ));
    }

    let explicit = device_id.and_then(|id| sinks.iter().find(|s| s.name == id).cloned());
    let chosen = match explicit {
        Some(sink) => sink,
        None => {
            if let Some(id) = device_id {
                eprintln!("[pulse] sink \"{id}\" is gone — falling back to the default sink");
            }
            probe
                .default_sink_name()
                .and_then(|name| sinks.iter().find(|s| s.name == name).cloned())
                .unwrap_or_else(|| sinks[0].clone())
        }
    };

    Ok((chosen.monitor_source, chosen.rate))
}

/// Open a recording stream on `source` at the pinned rate. The server handles
/// resampling and downmixing, so this succeeds for any sink format.
fn open_monitor(source: &str) -> Result<Simple> {
    let spec = Spec {
        format: Format::F32le,
        channels: 1,
        rate: CAPTURE_RATE,
    };
    if !spec.is_valid() {
        return Err(anyhow!("pulse: invalid sample spec for {source}"));
    }

    let frame_bytes = (FRAME_SAMPLES * 4) as u32;
    let attr = BufferAttr {
        // Roughly 320 ms of slack: enough that a scheduling hiccup on the DSP
        // thread does not make the server drop frames.
        maxlength: frame_bytes * 16,
        // Playback-only fields; u32::MAX means "server default".
        tlength: u32::MAX,
        prebuf: u32::MAX,
        minreq: u32::MAX,
        // One DSP frame per read.
        fragsize: frame_bytes,
    };

    Simple::new(
        None,
        "GoDojo AI",
        Direction::Record,
        Some(source),
        "System audio",
        &spec,
        None,
        Some(&attr),
    )
    .map_err(|e| anyhow!("pulse: could not record from \"{source}\" ({e})"))
}

/// Blocking-read loop. Owns the Pulse stream and is the only thread that
/// reopens it.
fn reader_loop(
    shared: Arc<Shared>,
    initial_source: String,
    device_id: Option<String>,
    exit_tx: mpsc::Sender<()>,
) {
    // Dropped when this function returns; the last such drop disconnects the
    // channel `SpeakerStream::drop` is waiting on.
    let _exit_signal = exit_tx;

    let mut source = initial_source;
    let mut simple = match open_monitor(&source) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("[pulse] initial open failed: {e}");
            None
        }
    };

    let mut byte_buf = vec![0u8; FRAME_SAMPLES * 4];
    let mut sample_buf: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES);
    let mut consecutive_errors: u32 = 0;
    let mut reopen_failures: u32 = 0;

    while !shared.shutdown.load(Ordering::Acquire) {
        // The watchdog publishes the default sink's monitor every ROUTE_POLL_MS;
        // rebinding only happens when it actually differs from ours.
        let requested = shared.rebind.lock().ok().and_then(|mut slot| slot.take());
        if let Some(next) = requested {
            if next != source {
                println!("[pulse] output route changed: \"{source}\" → \"{next}\"");
                match open_monitor(&next) {
                    Ok(s) => {
                        simple = Some(s);
                        source = next;
                        consecutive_errors = 0;
                        reopen_failures = 0;
                    }
                    // Keep recording the old endpoint: stale audio beats none,
                    // and the next poll tick retries.
                    Err(e) => eprintln!("[pulse] rebind failed, keeping \"{source}\": {e}"),
                }
            }
        }

        // No stream at all (initial open failed, or reads died) — rebuild it.
        // Backoff is a flat delay rather than exponential because the JS
        // supervisor already owns long-horizon backoff.
        if simple.is_none() {
            thread::sleep(Duration::from_millis(REOPEN_BACKOFF_MS));
            if shared.shutdown.load(Ordering::Acquire) {
                break;
            }
            match resolve_monitor(device_id.as_deref())
                .and_then(|(m, _)| open_monitor(&m).map(|s| (m, s)))
            {
                Ok((monitor, stream)) => {
                    println!("[pulse] reconnected to \"{monitor}\"");
                    source = monitor;
                    simple = Some(stream);
                    consecutive_errors = 0;
                    reopen_failures = 0;
                }
                Err(e) => {
                    reopen_failures += 1;
                    // Log the first few, then go quiet: the watchdog keeps
                    // feeding the ring, so this can spin for minutes while a
                    // Bluetooth headset is switched off.
                    if reopen_failures <= 3 {
                        eprintln!("[pulse] reconnect attempt {reopen_failures} failed: {e}");
                    }
                }
            }
            continue;
        }

        // Read into a plain Result so the error arm below can clear `simple`
        // without holding a borrow of it.
        let read_result = match simple.as_ref() {
            Some(stream) => stream.read(&mut byte_buf),
            None => continue,
        };

        match read_result {
            Ok(()) => {
                consecutive_errors = 0;
                sample_buf.clear();
                for frame in byte_buf.chunks_exact(4) {
                    sample_buf.push(f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]));
                }
                if let Ok(mut producer) = shared.producer.lock() {
                    // A full ring means the DSP stalled; dropping the excess is
                    // correct — we want the newest audio, not a backlog.
                    let _ = producer.push_slice(&sample_buf);
                }
                shared
                    .last_data_ms
                    .store(shared.origin.elapsed().as_millis() as u64, Ordering::Release);
            }
            Err(e) => {
                consecutive_errors += 1;
                if consecutive_errors == 1 || consecutive_errors == MAX_CONSECUTIVE_READ_ERRORS {
                    eprintln!(
                        "[pulse] read error {consecutive_errors}/{MAX_CONSECUTIVE_READ_ERRORS} \
                         on \"{source}\": {e}"
                    );
                }
                if consecutive_errors >= MAX_CONSECUTIVE_READ_ERRORS {
                    // Sink unplugged, or the server restarted underneath us.
                    // Drop the stream; the branch above rebuilds it.
                    simple = None;
                    consecutive_errors = 0;
                    continue;
                }
                thread::sleep(Duration::from_millis(READ_ERROR_BACKOFF_MS));
            }
        }
    }

    println!("[pulse] reader thread exited");
}

/// Keeps the ring fed and follows the default sink.
fn watchdog_loop(
    shared: Arc<Shared>,
    device_id: Option<String>,
    initial_source: String,
    exit_tx: mpsc::Sender<()>,
) {
    // Dropped when this function returns; the last such drop disconnects the
    // channel `SpeakerStream::drop` is waiting on.
    let _exit_signal = exit_tx;

    // Pinned devices must not be dragged around by the default-sink poll.
    let follow_default = device_id.is_none();
    let mut probe: Option<PulseProbe> = None;
    let mut published = initial_source;
    let mut last_route_check = Instant::now();
    let mut last_top_up = Instant::now();
    let mut synthesized_ms: u64 = 0;
    // Preallocated so the keepalive path never allocates.
    let silence = vec![0.0f32; (MAX_TOP_UP_MS as usize) * (CAPTURE_RATE as usize) / 1000];

    while !shared.shutdown.load(Ordering::Acquire) {
        thread::sleep(Duration::from_millis(WATCHDOG_TICK_MS));
        if shared.shutdown.load(Ordering::Acquire) {
            break;
        }

        // 1. Continuity. A suspended sink stops producing monitor data
        //    entirely, so stand in for it rather than let the DSP starve.
        let now_ms = shared.origin.elapsed().as_millis() as u64;
        let quiet_ms = now_ms.saturating_sub(shared.last_data_ms.load(Ordering::Acquire));
        if quiet_ms > SILENCE_TOP_UP_AFTER_MS {
            let span_ms = (last_top_up.elapsed().as_millis() as u64).min(MAX_TOP_UP_MS);
            let count = (span_ms as usize) * (CAPTURE_RATE as usize) / 1000;
            if count > 0 {
                if let Ok(mut producer) = shared.producer.lock() {
                    let _ = producer.push_slice(&silence[..count]);
                }
                last_top_up = Instant::now();
                synthesized_ms += span_ms;
                // One line per ~30 s of continuous idle, not per tick.
                if synthesized_ms >= 30_000 {
                    println!("[pulse] sink idle — synthesized {synthesized_ms}ms of silence");
                    synthesized_ms = 0;
                }
            }
        } else {
            last_top_up = Instant::now();
            synthesized_ms = 0;
        }

        // 2. Device hot-swap. Pulse already migrates streams when a sink is
        //    REMOVED; this covers the other case — the user switching the
        //    default while both sinks still exist.
        if !follow_default || last_route_check.elapsed() < Duration::from_millis(ROUTE_POLL_MS) {
            continue;
        }
        last_route_check = Instant::now();

        if !probe.as_ref().is_some_and(|p| p.is_ready()) {
            probe = PulseProbe::new().ok();
        }
        // Connecting can burn up to CONNECT_TIMEOUT. If shutdown landed while we
        // were in there, skip the two round-trips for a route nobody will use.
        if shared.shutdown.load(Ordering::Acquire) {
            break;
        }
        let Some(p) = probe.as_mut() else { continue };

        if let Some(sink) = p.default_sink() {
            if sink.monitor_source != published {
                published = sink.monitor_source.clone();
                if let Ok(mut slot) = shared.rebind.lock() {
                    *slot = Some(sink.monitor_source);
                }
            }
        }
    }

    println!("[pulse] watchdog thread exited");
}

/// Output devices, as (id, label) pairs. The id is a Pulse SINK name.
pub fn list_output_devices() -> Result<Vec<(String, String)>> {
    let mut probe = PulseProbe::new()?;
    Ok(probe
        .list_sinks()
        .into_iter()
        .map(|sink| {
            let label = if sink.description.is_empty() {
                sink.name.clone()
            } else {
                sink.description
            };
            (sink.name, label)
        })
        .collect())
}
