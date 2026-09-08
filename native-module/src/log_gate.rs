//! log_gate.rs
//!
//! Verbose-logging gate for the native module.
//!
//! Rust had no log-level concept in this crate: every diagnostic was a bare
//! `println!`, so the only way to quiet the native layer was to delete lines and
//! rebuild. Meanwhile the JS side has had a real switch for a while
//! (`electron/verboseLog.ts` + the `verboseLogging` setting), and nothing
//! propagated it across the napi boundary — a user with verbose logging OFF
//! still got every native diagnostic.
//!
//! This is that missing half. Two ways in, because they cover different windows:
//!
//!   * `setNativeVerboseLogging(bool)` from JS — the authoritative switch, kept
//!     in lockstep with the JS flag by `setVerboseLoggingFlag`.
//!   * `NATIVELY_VERBOSE=1` in the environment — covers diagnostics that fire
//!     before any JS has run (module load, device enumeration, capture
//!     construction) and gives field debugging a way in that needs no UI.
//!
//! What belongs behind the gate: periodic or per-frame diagnostics — anything
//! whose line count scales with call duration. What does NOT: errors, warnings,
//! and one-shot lifecycle lines (capture started/stopped, device opened, APM
//! reset). Those are the lines that make a bug report readable, and there are a
//! bounded number of them per session.

use std::sync::atomic::{AtomicBool, Ordering};

use once_cell::sync::Lazy;

/// Runtime switch, driven from JS. Relaxed throughout: this is a diagnostic
/// flag, so a frame or two of staleness after a toggle is irrelevant and not
/// worth a fence on the audio threads that read it.
static VERBOSE: AtomicBool = AtomicBool::new(false);

/// Read once, on first use. An env override cannot be turned off from the UI —
/// that is the point: `NATIVELY_VERBOSE=1` is for a debugging session where the
/// UI switch may not have been reached yet, or at all.
static ENV_VERBOSE: Lazy<bool> = Lazy::new(|| {
    let on = matches!(
        std::env::var("NATIVELY_VERBOSE").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE")
    );
    if on {
        println!("[LogGate] NATIVELY_VERBOSE set — native verbose logging forced on");
    }
    on
});

/// Should verbose native diagnostics be printed right now?
#[inline]
pub fn verbose() -> bool {
    VERBOSE.load(Ordering::Relaxed) || *ENV_VERBOSE
}

/// Set the runtime switch. Prints only on an actual transition, so repeated
/// syncs from JS are silent.
pub fn set_verbose(enabled: bool) {
    let prev = VERBOSE.swap(enabled, Ordering::Relaxed);
    if prev != enabled {
        println!("[LogGate] native verbose logging {}", if enabled { "on" } else { "off" });
    }
}

/// Mirror the JS `verboseLogging` flag into the native module.
///
/// Called from `setVerboseLoggingFlag` (electron/verboseLog.ts) so the two
/// halves are the same switch. Older .node binaries lack this export, so the JS
/// side treats it as optional.
#[napi]
pub fn set_native_verbose_logging(enabled: bool) {
    set_verbose(enabled);
}

/// Effective state, including the env override — so JS can report what the
/// native layer is actually doing rather than what it last asked for.
#[napi]
pub fn get_native_verbose_logging() -> bool {
    verbose()
}

/// `println!` that only fires when native verbose logging is on.
///
/// Exported at the crate root by `#[macro_export]`; call it as `crate::vlog!`
/// so the call site says plainly that this line is gated.
#[macro_export]
macro_rules! vlog {
    ($($arg:tt)*) => {
        if $crate::log_gate::verbose() {
            println!($($arg)*);
        }
    };
}
