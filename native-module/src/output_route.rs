// Output route classification — does the default OUTPUT device have an
// acoustic path to the microphone?
//
// Headphones (wired jack, BT headsets, USB headsets) physically cannot bleed
// into the mic, so the echo gate can be bypassed entirely while they are the
// default output. Speakers (built-in, HDMI/DisplayPort monitors, AirPlay,
// external USB speakers) can bleed and need the gate + AEC3.
//
// Unknown classifications are treated as Speakers by callers (fail-safe:
// keep echo protection when we are not sure).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteKind {
    Headphones,
    Speakers,
    Unknown,
}

impl RouteKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            RouteKind::Headphones => "headphones",
            RouteKind::Speakers => "speakers",
            RouteKind::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone)]
pub struct OutputRouteInfo {
    pub kind: RouteKind,
    pub transport: String,
    pub name: String,
}

impl OutputRouteInfo {
    fn unknown() -> Self {
        Self {
            kind: RouteKind::Unknown,
            transport: "unknown".to_string(),
            name: String::new(),
        }
    }
}

/// Classify a device by its (lowercased) name when the transport alone is
/// ambiguous (Bluetooth and USB carry both headsets and speakers).
/// `default_kind` is returned when no pattern matches.
fn classify_by_name(name: &str, default_kind: RouteKind) -> RouteKind {
    let n = name.to_lowercase();

    // Speaker patterns first: a "JBL Charge speaker" must not match "buds"-style
    // substrings later. These are checked before headphone patterns on purpose.
    const SPEAKER_PATTERNS: &[&str] = &[
        "speaker", "soundbar", "sound bar", "display", "monitor", "tv",
        "sonos", "bose home", "homepod", "echo dot", "boombox", "charge",
        "flip", "pulse", "partybox", "srs-x", "megaboom", "wonderboom",
    ];
    for p in SPEAKER_PATTERNS {
        if n.contains(p) {
            return RouteKind::Speakers;
        }
    }

    const HEADPHONE_PATTERNS: &[&str] = &[
        "airpod", "earpod", "headphone", "headset", "earbud", "buds",
        "earphone", "in-ear", "beats", "jabra", "arctis", "quietcomfort",
        "momentum", "wh-", "wf-", "elite", "voyager", "openrun", "aeropex",
    ];
    for p in HEADPHONE_PATTERNS {
        if n.contains(p) {
            return RouteKind::Headphones;
        }
    }

    default_kind
}

/// Query the current default output device and classify it.
/// Never panics; on any platform/API error returns Unknown (treated as
/// Speakers by the gate — fail-safe).
pub fn current_output_route() -> OutputRouteInfo {
    current_output_route_impl()
}

// ============================================================================
// macOS — CoreAudio transport type + data source (via cidre, existing dep)
// ============================================================================

#[cfg(target_os = "macos")]
fn current_output_route_impl() -> OutputRouteInfo {
    use cidre::core_audio as ca;

    let device = match ca::System::default_output_device() {
        Ok(d) => d,
        Err(_) => return OutputRouteInfo::unknown(),
    };

    let name = device
        .name()
        .map(|s| s.to_string())
        .unwrap_or_default();

    let transport = match device.transport_type() {
        Ok(t) => t,
        Err(_) => {
            return OutputRouteInfo {
                kind: classify_by_name(&name, RouteKind::Unknown),
                transport: "unknown".to_string(),
                name,
            }
        }
    };

    let (kind, transport_str) = match transport {
        ca::DeviceTransportType::BUILT_IN => {
            // Built-in output: the data source tells wired-jack headphones
            // ('hdpn') apart from the internal speakers ('ispk').
            const FOURCC_HDPN: u32 = u32::from_be_bytes(*b"hdpn");
            let data_src: Option<u32> = device
                .prop(
                    &ca::PropSelector::DEVICE_DATA_SRC
                        .addr(ca::PropScope::OUTPUT, ca::PropElement::MAIN),
                )
                .ok();
            if data_src == Some(FOURCC_HDPN) {
                (RouteKind::Headphones, "built-in (headphone jack)")
            } else {
                (RouteKind::Speakers, "built-in")
            }
        }
        ca::DeviceTransportType::BLUETOOTH | ca::DeviceTransportType::BLUETOOTH_LE => {
            // Named headsets/speakers are caught by the pattern lists; an
            // unrecognized BT name defaults to Unknown, which the gate treats
            // as speakers (fail-safe: an unknown BT speaker must never bypass
            // echo protection — only Headphones bypasses).
            (classify_by_name(&name, RouteKind::Unknown), "bluetooth")
        }
        ca::DeviceTransportType::USB => (classify_by_name(&name, RouteKind::Unknown), "usb"),
        ca::DeviceTransportType::HDMI => (RouteKind::Speakers, "hdmi"),
        ca::DeviceTransportType::DISPLAY_PORT => (RouteKind::Speakers, "displayport"),
        ca::DeviceTransportType::AIR_PLAY => (RouteKind::Speakers, "airplay"),
        ca::DeviceTransportType::THUNDERBOLT => {
            (classify_by_name(&name, RouteKind::Unknown), "thunderbolt")
        }
        ca::DeviceTransportType::VIRTUAL | ca::DeviceTransportType::AGGREGATE => {
            (classify_by_name(&name, RouteKind::Unknown), "virtual")
        }
        _ => (classify_by_name(&name, RouteKind::Unknown), "other"),
    };

    OutputRouteInfo {
        kind,
        transport: transport_str.to_string(),
        name,
    }
}

// ============================================================================
// Windows — WASAPI endpoint form factor (PKEY_AudioEndpoint_FormFactor)
// ============================================================================

#[cfg(target_os = "windows")]
fn current_output_route_impl() -> OutputRouteInfo {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, PKEY_AudioEndpoint_FormFactor,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc, PropVariantToUInt32,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
    };

    unsafe {
        // S_FALSE / RPC_E_CHANGED_MODE just mean COM is already initialized on
        // this thread — both are fine for property reads.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let enumerator: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(_) => return OutputRouteInfo::unknown(),
            };

        let device = match enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
            Ok(d) => d,
            Err(_) => return OutputRouteInfo::unknown(),
        };

        let store = match device.OpenPropertyStore(STGM_READ) {
            Ok(s) => s,
            Err(_) => return OutputRouteInfo::unknown(),
        };

        let name = match store.GetValue(&PKEY_Device_FriendlyName) {
            Ok(mut v) => {
                let s = PropVariantToStringAlloc(&v)
                    .ok()
                    .and_then(|p: windows::core::PWSTR| {
                        let s = p.to_string().ok();
                        windows::Win32::System::Com::CoTaskMemFree(Some(p.0 as _));
                        s
                    })
                    .unwrap_or_default();
                let _ = PropVariantClear(&mut v);
                s
            }
            Err(_) => String::new(),
        };

        let form_factor = match store.GetValue(&PKEY_AudioEndpoint_FormFactor) {
            Ok(mut v) => {
                let ff = PropVariantToUInt32(&v).ok();
                let _ = PropVariantClear(&mut v);
                ff
            }
            Err(_) => None,
        };

        // EndpointFormFactor enum:
        // 0 RemoteNetworkDevice, 1 Speakers, 2 LineLevel, 3 Headphones,
        // 4 Microphone, 5 Headset, 6 Handset, 7 UnknownDigitalPassthrough,
        // 8 SPDIF, 9 DigitalAudioDisplayDevice, 10 UnknownFormFactor
        let (kind, transport) = match form_factor {
            Some(3) | Some(5) | Some(6) => (RouteKind::Headphones, "formfactor:headset"),
            Some(1) => (RouteKind::Speakers, "formfactor:speakers"),
            Some(9) => (RouteKind::Speakers, "formfactor:display"),
            Some(_) | None => (classify_by_name(&name, RouteKind::Unknown), "formfactor:other"),
        };

        OutputRouteInfo {
            kind,
            transport: transport.to_string(),
            name,
        }
    }
}

// ============================================================================
// Linux — PulseAudio/PipeWire active port + device.form_factor proplist
// ============================================================================

#[cfg(target_os = "linux")]
thread_local! {
    // The echo-control route watcher calls this every 2s on a dedicated thread.
    // Reusing the connection avoids a connect/disconnect handshake per poll.
    // PulseProbe is !Send, so a thread-local is the natural home for it.
    static ROUTE_PROBE: std::cell::RefCell<Option<crate::speaker::pulse::PulseProbe>> =
        std::cell::RefCell::new(None);
}

#[cfg(target_os = "linux")]
fn current_output_route_impl() -> OutputRouteInfo {
    let sink = ROUTE_PROBE.with(|cell| {
        let mut slot = cell.borrow_mut();
        if !slot.as_ref().is_some_and(|p| p.is_ready()) {
            *slot = crate::speaker::pulse::PulseProbe::new().ok();
        }
        slot.as_mut().and_then(|p| p.default_sink())
    });

    let Some(sink) = sink else {
        return OutputRouteInfo::unknown();
    };

    let label = if sink.description.is_empty() {
        sink.name
    } else {
        sink.description
    };
    let port = sink.active_port.to_lowercase();
    let form = sink.form_factor.to_lowercase();
    let bus = sink.bus.to_lowercase();

    let transport = if bus == "bluetooth" {
        "bluetooth"
    } else if bus == "usb" {
        "usb"
    } else if port.contains("hdmi") || port.contains("displayport") {
        "hdmi"
    } else if port.contains("iec958") || port.contains("spdif") {
        "spdif"
    } else if bus == "pci" || bus == "isa" || bus == "platform" {
        "builtin"
    } else {
        "unknown"
    };

    // 1. ALSA/UCM and BlueZ port names are the sharpest signal available, and
    //    they flip the instant a jack is plugged in ("analog-output-speaker" →
    //    "analog-output-headphones") without the sink itself changing.
    let by_port = if port.contains("headphone") || port.contains("headset") {
        Some(RouteKind::Headphones)
    } else if port.contains("speaker")
        || port.contains("lineout")
        || port.contains("line-out")
        || port.contains("hdmi")
        || port.contains("displayport")
        || port.contains("iec958")
        || port.contains("spdif")
    {
        Some(RouteKind::Speakers)
    } else {
        None
    };

    // 2. device.form_factor, set by udev for PCI/USB and by BlueZ from the
    //    Bluetooth class of device. "hands-free" and "hifi" are deliberately
    //    absent: a car kit or a BT hi-fi receiver is a speaker, so those fall
    //    through to name matching and, failing that, to Unknown (= gate stays
    //    on, which is the fail-safe answer).
    let by_form = match form.as_str() {
        "headphone" | "headset" => Some(RouteKind::Headphones),
        "speaker" | "internal" | "tv" | "car" | "portable" => Some(RouteKind::Speakers),
        _ => None,
    };

    let kind = by_port
        .or(by_form)
        .unwrap_or_else(|| classify_by_name(&label, RouteKind::Unknown));

    OutputRouteInfo {
        kind,
        transport: transport.to_string(),
        name: label,
    }
}

// ============================================================================
// Other platforms — no system audio capture exists, gate never engages
// ============================================================================

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn current_output_route_impl() -> OutputRouteInfo {
    OutputRouteInfo::unknown()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bt_headsets_classify_as_headphones() {
        // The BT branch now passes Unknown as the default — recognized
        // headset names must still classify as Headphones via the patterns.
        for name in [
            "Chandra's AirPods Pro",
            "WH-1000XM5",
            "Jabra Elite 85t",
            "Galaxy Buds2",
            "Bose QuietComfort 45",
            "Plantronics Voyager 5200",
        ] {
            assert_eq!(
                classify_by_name(name, RouteKind::Unknown),
                RouteKind::Headphones,
                "{name}"
            );
        }
    }

    #[test]
    fn bt_speakers_deny_listed() {
        for name in [
            "JBL Charge 5",
            "JBL Flip 6",
            "Sonos Roam Speaker",
            "UE Megaboom 3",
            "LG TV",
            "Studio Display",
        ] {
            assert_eq!(
                classify_by_name(name, RouteKind::Unknown),
                RouteKind::Speakers,
                "{name}"
            );
        }
    }

    #[test]
    fn unrecognized_bt_names_default_to_unknown() {
        // Unknown is treated as speakers by the gate — an unrecognized BT
        // device must never bypass echo protection.
        for name in ["BTR-3000", "Living Room Audio", "X99"] {
            assert_eq!(
                classify_by_name(name, RouteKind::Unknown),
                RouteKind::Unknown,
                "{name}"
            );
        }
    }

    #[test]
    fn unmatched_names_fall_through_to_default() {
        assert_eq!(
            classify_by_name("Scarlett 2i2", RouteKind::Unknown),
            RouteKind::Unknown
        );
        assert_eq!(
            classify_by_name("Scarlett 2i2", RouteKind::Headphones),
            RouteKind::Headphones
        );
    }
}