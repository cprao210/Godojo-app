// PulseAudio / PipeWire server introspection.
//
// Everything Linux needs to know about the sound server that is NOT the audio
// stream itself: which sinks exist, which one is currently the default, and
// what its active port says about whether it can bleed into the microphone.
//
// Speaking the PulseAudio protocol rather than PipeWire's native one is
// deliberate: `pipewire-pulse` ships enabled on every PipeWire desktop, so one
// client covers PulseAudio systems (Ubuntu <= 22.04, Debian, Mint) and PipeWire
// systems (Ubuntu >= 22.10, Fedora, Arch) with no branching.
//
// Both `speaker/linux.rs` (capture) and `output_route.rs` (echo-gate route
// classification) use this, so neither grows its own mainloop plumbing.

use anyhow::{anyhow, Result};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::thread;
use std::time::{Duration, Instant};

use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::{Context, FlagSet as ContextFlagSet, State as ContextState};
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};
use libpulse_binding::operation::State as OperationState;

/// How long the server gets to accept a connection. Generous enough to cover
/// autospawn of a not-yet-running `pulseaudio`, short enough that a machine
/// with no sound server at all fails fast and lets the JS supervisor retry.
const CONNECT_TIMEOUT: Duration = Duration::from_millis(2500);
/// Budget for a single introspection round-trip.
const OP_TIMEOUT: Duration = Duration::from_millis(1000);
/// `iterate(false)` is non-blocking, so waits would otherwise be a hot spin.
const PUMP_SLEEP: Duration = Duration::from_millis(2);

/// One output sink, flattened into owned data so it can outlive the callback
/// that produced it (PulseAudio hands out borrowed `Cow`s tied to the mainloop
/// iteration).
#[derive(Debug, Clone, Default)]
pub struct SinkSummary {
    /// Sink name, e.g. `alsa_output.pci-0000_00_1f.3.analog-stereo`.
    /// This is what we expose to JS as the output device id.
    pub name: String,
    /// Human label, e.g. `Built-in Audio Analog Stereo`.
    pub description: String,
    /// The source to RECORD to hear this sink — normally `<name>.monitor`.
    pub monitor_source: String,
    /// Sink's own rate. Informational only: we ask the server to convert.
    pub rate: u32,
    /// Active port, e.g. `analog-output-headphones`, `hdmi-output-0`.
    pub active_port: String,
    /// proplist `device.form_factor`: `speaker` | `headset` | `internal` | ...
    pub form_factor: String,
    /// proplist `device.bus`: `pci` | `usb` | `bluetooth` | ...
    pub bus: String,
}

/// Drive the mainloop until `done()` returns true or `timeout` elapses.
/// Returns whether `done()` won the race.
fn pump(mainloop: &mut Mainloop, done: &mut dyn FnMut() -> bool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match mainloop.iterate(false) {
            IterateResult::Quit(_) | IterateResult::Err(_) => return false,
            IterateResult::Success(_) => {}
        }
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(PUMP_SLEEP);
    }
}

/// A connected, ready-to-query handle on the sound server.
///
/// Neither field is `Send`; a probe belongs to the thread that created it.
pub struct PulseProbe {
    // Declared before `mainloop` on purpose: struct fields drop in declaration
    // order, and the context holds a raw pointer into the mainloop's vtable.
    context: Context,
    mainloop: Mainloop,
}

impl PulseProbe {
    /// Connect to the local sound server. Errors when there is no
    /// PulseAudio-compatible server reachable, which is the one case the caller
    /// must surface to the user.
    pub fn new() -> Result<Self> {
        let mut mainloop =
            Mainloop::new().ok_or_else(|| anyhow!("pulse: could not create mainloop"))?;
        let mut context = Context::new(&mainloop, "GoDojo AI")
            .ok_or_else(|| anyhow!("pulse: could not create client context"))?;

        // NOFLAGS (rather than NOAUTOSPAWN) lets a classic PulseAudio daemon be
        // started on demand if it is installed but not yet running.
        context
            .connect(None, ContextFlagSet::NOFLAGS, None)
            .map_err(|e| anyhow!("pulse: connect failed ({e})"))?;

        let settled = pump(
            &mut mainloop,
            &mut || {
                matches!(
                    context.get_state(),
                    ContextState::Ready | ContextState::Failed | ContextState::Terminated
                )
            },
            CONNECT_TIMEOUT,
        );

        if !settled || !matches!(context.get_state(), ContextState::Ready) {
            return Err(anyhow!(
                "pulse: no PulseAudio-compatible sound server became ready within {}ms \
                 (install/start pipewire-pulse or pulseaudio)",
                CONNECT_TIMEOUT.as_millis()
            ));
        }

        Ok(Self { context, mainloop })
    }

    /// False once the server has gone away — the caller should build a fresh
    /// probe rather than keep querying a dead context.
    pub fn is_ready(&self) -> bool {
        matches!(self.context.get_state(), ContextState::Ready)
    }

    /// Name of the sink the desktop is currently routing audio to.
    pub fn default_sink_name(&mut self) -> Option<String> {
        let out: Rc<RefCell<Option<String>>> = Rc::new(RefCell::new(None));
        let done = Rc::new(Cell::new(false));

        let op = {
            let out = out.clone();
            let done = done.clone();
            self.context.introspect().get_server_info(move |info| {
                *out.borrow_mut() = info.default_sink_name.as_deref().map(|s| s.to_string());
                done.set(true);
            })
        };

        pump(
            &mut self.mainloop,
            &mut || done.get() || !matches!(op.get_state(), OperationState::Running),
            OP_TIMEOUT,
        );

        out.borrow().clone()
    }

    /// Every output sink the server knows about, in server order.
    pub fn list_sinks(&mut self) -> Vec<SinkSummary> {
        let out: Rc<RefCell<Vec<SinkSummary>>> = Rc::new(RefCell::new(Vec::new()));
        let done = Rc::new(Cell::new(false));

        let op = {
            let out = out.clone();
            let done = done.clone();
            self.context
                .introspect()
                .get_sink_info_list(move |item| match item {
                    ListResult::Item(info) => {
                        let name = info.name.as_deref().unwrap_or("").to_string();
                        if name.is_empty() {
                            return;
                        }
                        // Older servers can omit monitor_source_name; the
                        // "<sink>.monitor" convention has held for 15 years.
                        let monitor_source = match info.monitor_source_name.as_deref() {
                            Some(m) if !m.is_empty() => m.to_string(),
                            _ => format!("{name}.monitor"),
                        };
                        let active_port = match info.active_port.as_ref() {
                            Some(port) => port.name.as_deref().unwrap_or("").to_string(),
                            None => String::new(),
                        };
                        out.borrow_mut().push(SinkSummary {
                            description: info.description.as_deref().unwrap_or("").to_string(),
                            monitor_source,
                            rate: info.sample_spec.rate,
                            active_port,
                            form_factor: info
                                .proplist
                                .get_str("device.form_factor")
                                .unwrap_or_default(),
                            bus: info.proplist.get_str("device.bus").unwrap_or_default(),
                            name,
                        });
                    }
                    ListResult::End | ListResult::Error => done.set(true),
                })
        };

        pump(
            &mut self.mainloop,
            &mut || done.get() || !matches!(op.get_state(), OperationState::Running),
            OP_TIMEOUT,
        );

        out.borrow().clone()
    }

    /// The default sink resolved to a full summary. Two round-trips.
    pub fn default_sink(&mut self) -> Option<SinkSummary> {
        let wanted = self.default_sink_name()?;
        self.list_sinks().into_iter().find(|s| s.name == wanted)
    }
}

impl Drop for PulseProbe {
    fn drop(&mut self) {
        self.context.disconnect();
    }
}
