# Accessibility-Driven Physicalization: Standards, Devices, and Architecture Implications for EHC's Sensor/Sensory Stack

*Research memo for Event Horizon Code (EHC) — 2026-11-26. Focus: disabled and handicapped users as primary operators. All claims carry source URLs in the inventory table and sources list; items I could not verify are explicitly marked **(unverified)** or **(not re-verified)**.*

---

## 1. Framework / Standard Inventory

Legend for "cloud posture": **local** = works with no cloud; **cloud** = requires or defaults to cloud; **hybrid** = both; **n/a** = standard/spec, not a service.

### 1a. Input alternatives (switch, sip-puff, head, gaze, EMG, BCI)

| Name | What it gives | Protocol / API | License / cloud posture | How EHC's sensor bus would adopt it | Source |
|---|---|---|---|---|---|
| USB switch interfaces (Inclusive Simple Switch Box, Crick USB SwitchBox, Hitch, Ablenet, Don Johnston) | 1–8 3.5mm jacks → emulated keyboard keys / mouse buttons / gamepad. De-facto convention: 1-switch scanning = `Space`, 2-switch = `Space`+`Enter` | USB HID keyboard; some programmable via vendor config; some emulate gamepads | Commercial HW, driverless HID; fully local | Treat as an `Observation` source `kind: "switch.press"` with per-port key mapping; no driver needed — read HID or keyboard events | [CALL Scotland switches](https://www.callscotland.org.uk/information/alternative-access/switches/), [Inclusive support](https://support.inclusive.com/article/using-switches) |
| Switch access scanning (method, not product) | Auto/step/directed/row-column scanning; timing parameters are the real spec: debounce 0.01–0.1 s, acceptance 0–10 s, repeat delay 0.1–10 s | OS-level (iOS Switch Control, Android Switch Access, ChromeOS Switch Access, Samsung Universal Switch) or app-internal | n/a; all OS stacks local | EHC's own UI must be operable by scanning: discrete focusable targets, no hover-only, no time-windowed combos | [Colven & Judge guide](https://eprints.whiterose.ac.uk/id/eprint/10291/1/SwitchScanningMaster_8_472.pdf), [Android Switch Access](https://support.google.com/accessibility/android/answer/6301490) |
| HID "Assistive Control" collection (HUTRR68, corrected by HUTRR81) | A Generic Desktop Usage (`0x10` after correction) that lets a device *identify itself* as an assistive input device | USB/BT HID descriptor | n/a (USB-IF spec, free) | Enumerate HID Assistive Control collections natively instead of guessing "it's a keyboard" | [HUTRR81](https://usb.org/sites/default/files/hutrr81_-_correction_to_hutrr68.pdf), [HUT 1.5](https://usb.org/sites/default/files/hut1_5.pdf) |
| Sip-and-puff switches (Origin Breeze USB, R-net specialty controls) | Breath-operated switch, usually 2–4 discrete states (soft/hard puff/sip) | USB HID keyboard, or 3.5mm jack into switch interface / wheelchair CJSM2-sw | Commercial HW; local | `kind: "sip_puff.state"`; multi-level — not boolean like a plain switch | [Origin Instruments](https://www.orin.com/access), [CASRAI switch guide](https://casrai.org/guides/switch-access) |
| Enable Viacam (eViacam) / Camera Mouse / EVA Facial Mouse | Webcam head-tracking → mouse pointer; dwell-click options | OS pointer injection; eViacam is GPL-3, Windows/Linux | Open source (GPL-3); fully local | Reference implementation class for a local "head pointer" lane using EHC's existing camera window; also proof that a second person entering the camera frame can break control (design watch accordingly) | [eViacam](https://eviacam.crea-si.com/), [GitHub](https://github.com/cmauri/eviacam) |
| Tobii consumer + Pro line (4C/EyeX/5, Pro SDK, Pro Glasses 3, Tobii Nexus) | Screen-based and glasses gaze: gaze point, pupil, presence, head pose | Pro SDK: Python/.NET/Matlab/C/Unity bindings; Glasses 3: HTTP REST + WebSocket + WebRTC/RTSP; Nexus: webcam-only software gaze library (commercial) | Pro SDK free, proprietary; Nexus commercial; HW commercial; local processing | Gaze adapter → `Observation { kind: "gaze.point"\|"gaze.fixation"\|"gaze.presence", payload }` at device Hz; presence supports the existing "person appears" watch | [Tobii Pro SDK](https://www.tobii.com/products/software/applications-and-developer-kits/tobii-pro-sdk), [Glasses 3 API](https://www.tobii.com/products/software/applications-and-developer-kits/tobii-pro-sdk/tobii-pro-glasses-3-api), [Tobii Nexus](https://www.tobii.com/products/integration/screen-based-integrations/tobii-nexus) |
| GazeTheWeb (MAMEM) + GazePlay + way-to-gaze | Open-source gaze UI/interaction research stack; GazeTheWeb extends Chromium (CEF); way-to-gaze reverse-engineers Tobii 5 for Linux (MIT) with 1€ filter + saccade warp; GazePlay works with any tracker that emits mouse moves | Desktop apps; way-to-gaze emits uinput pointer + F13–F20 action keys | Open source (BSD/GPL/MIT mix); fully local | Design pattern for EHC: expose *action keys* (F13–F20-style virtual bindings) that gaze/switch/EMG backends can all hit, so one accessibility surface serves many inputs | [GazeTheWeb](https://mamem.github.io/GazeTheWeb), [way-to-gaze](https://github.com/sky0hunter/way-to-gaze), [GazePlay](https://gazeplay.github.io/GazePlay) |
| HID Eye and Head Trackers usage page 0x12 (HUTRR74) | Standardizes gaze/head data *over HID* (USB/BLE) — gaze position, head position, blink | USB/BT HID | n/a (free spec) | The closest thing to a "GazeHID" standard I could verify; an EHC gaze sidecar should accept 0x12-page devices without vendor SDKs. ("GazeHID" as a named open protocol: **unverified**.) | [HUT 1.7 TOC / HUTRR74](https://usb.org/sites/default/files/hut1_7.pdf), [integrated requests](https://usb.org/integrated-usage-table-requests) |
| iMotions Lab API (+ LSL) | Event forwarding (TCP/UDP serialized events), event receiving (inject any sensor), remote control; LSL integration for any LSL device | TCP/UDP sockets; LSL | Commercial, closed; runs locally; "you own your data" | The "Gaze Pipe / iMotions-class" pattern: EHC sidecars speak simple TCP/UDP event streams + LSL; do not require vendor GUIs | [iMotions API](https://imotions.com/products/imotions-lab/developers/api), [module list](https://imotions.com/wp-content/uploads/brochures/imotions_module_descriptions.pdf) |
| Meta Neural Band (sEMG wristband) + Wearables Device Access Toolkit | Wrist sEMG → gestures/typing/handwriting; Nature 2025: 20.9 wpm handwriting, calibration-free cross-user decoding; accessibility research with Univ. of Utah (Jan 2026) | Device Access Toolkit 1.0 GA 2026-09-30 (Android/iOS, GitHub); Web Apps on Ray-Ban Display; EMG inference on-device | Proprietary HW; SDK free; local inference, but requires Meta account/device | This is the 2026 "Myo-class" successor (Myo discontinued ~2018 — **not re-verified**). Treat as a watch-able gesture source via the DAT; "Tappt/Integza-class" devices **could not be verified by name** — nearest verified open-EMG path is BrainFlow-supported boards | [Meta EMG](https://www.meta.com/emerging-tech/emg-wearable-technology), [DAT FAQ](https://developers.meta.com/wearables/faq), [Univ. of Utah collab](https://www.meta.com/blog/university-of-utah-accessibility-research-meta-neural-band), [Nature paper](https://www.nature.com/articles/s41586-025-09255-w) |
| BrainFlow | Device-agnostic SDK for EEG/EMG/ECG biosensors: acquisition, filtering, downsampling; can send device commands (unlike LSL); C++ core, bindings for Python/C#/Java/R/MATLAB/Julia | Native lib + language bindings | MIT; fully local | The neutral acquisition layer for any EMG/EEG input device; wrap in a sidecar → `Observation { kind: "emg.gesture" \| "eeg.class" }` | [BrainFlow](https://github.com/brainflow-dev/brainflow), [BrainFlow vs LSL](https://brainflow.org/2021-02-05-lsl-review/) |
| LSL (Lab Streaming Layer) | Network time-synchronized streaming of time series (EEG, EMG, gaze, audio, markers); resolver, XDF recording format; C/C++/Python/Java/C#/MATLAB | liblsl over TCP; content-based stream discovery (no zeroconf dependency) | MIT-class open; fully local | Cross-voltage interop: OpenBCI, most EEG vendors, iMotions, many eye trackers. An EHC LSL inlet/outlet sidecar makes EHC speak to the whole biosignal world with one adapter | [LSL docs](https://labstreaminglayer.readthedocs.io/info/intro.html), [supported devices](https://labstreaminglayer.readthedocs.io/info/supported_devices.html) |
| OpenBCI (Cyton/Ganglion/Galea) + GUI | Open biosensing boards + GUI with LSL/BrainFlow streaming | BrainFlow bindings; GUI networking widget | Open hardware + GUI; local | Primary supported-devices path for BCI/EMG experiments; keep EHC's role to observation, not decoding claims | [OpenBCI LSL](https://docs.openbci.com/Software/CompatibleThirdPartySoftware/LSL), [Software dev](https://docs.openbci.com/ForDevelopers/SoftwareDevelopment) |
| Neuralink N1 | Implantable BCI; cursor/speech decoding in trials (21+ participants; first 3000-channel implant Sept 2026) | **No public API, SDK, or developer portal as of Nov 2026** (API Evangelist Kin score 6.1/100, agent-readiness 0.0); not commercially sold; investigational only | Proprietary; cloud-less but closed; clinical-trial access only | Do **not** plan a Neuralink integration. Plan for BCI arriving as HID events, LSL streams, or BrainFlow boards instead | [API Evangelist profile](https://apis.io/providers/neuralink), [Neuralink updates](https://neuralink.com/updates/), [availability tracker](https://www.neurapod.com/blog/when-neuralink-available-public) |
| Science Corp (PRIMA / Synapse protocol) | Counter-example: a BCI vendor publishing an open gRPC/protobuf device API with Python/TS/C++ clients and even an MCP server | gRPC + protobuf, open definitions on GitHub | Proprietary HW; open protocol; local | Watch this as the template for what "BCI with an API" will look like if one emerges | [Science Corp profile](https://github.com/api-evangelist/science-corporation) |

### 1b. AAC and communication

| Name | What it gives | Protocol / API | License / cloud posture | EHC adoption | Source |
|---|---|---|---|---|---|
| RelayKeys (Ace Centre) | The canonical AAC→other-devices bridge: AAC host sends text/mouse commands over a serial API; a dongle emits BT HID keyboard/mouse. Documented command set, explicitly offered for adoption by other developers | RK-Serial API + Windows service; BT LE HID | Open source; fully local | EHC as *consumer*: accept HID keyboard input (any AAC can drive it). EHC as *producer*: emit the RelayKeys command set so an EHC-connected device can drive phones/TVs | [RelayKeys docs](https://docs.acecentre.org.uk/products/relaykeys) |
| Open Board Format (.obf/.obz) + Open Logging Format (.obl) | Open JSON board format (single board = .obf; board set + media = .obz zip) and an open AAC *session log* format with built-in anonymization | JSON + zip; MIT-licensed tooling incl. a TS parser library | Open (MIT); local | `.obl` is the correct wire schema inspiration for `kind: "aac.selection"` observations; `.obf/.obz` lets EHC render an AAC-style scanning board natively | [openboardformat.org](https://www.openboardformat.org/), [OpenAAC specs](https://www.openaac.org/docs.html), [TS lib](https://github.com/shayc/open-board-format) |
| Minspeak / PRC-Saltillo (Unity, LAMP WFL, UNIDAD, CoreScanner) | Dominant proprietary vocabularies; access via direct select, eye gaze, head tracking, switch scanning; 2026.3 app update added AI features; LAMP Visual-Impairment variant with high-contrast + tactile KeyGuide | Proprietary vocab files; apps export text; devices speak HID/mouse via accessories | Proprietary; device-local; some AI features cloud **(not re-verified)** | Don't parse Minspeak sequences; consume the *output* (text via HID/clipboard/RelayKeys) and the *logs* (.obl where supported) | [Minspeak AAC](https://minspeak.com/aac), [PRC 2026.3 update](https://prc-saltillo.com/blog/app-update-2026-3) |
| Voiceitt | ASR for non-standard speech (dysarthria); speaker-independent + personalized modes; Chrome ext, Webex/Zoom/Teams integrations | HTTP + Socket.IO WebSockets, JWT; 16 kHz PCM | **Cloud-only** (api2.voiceitt.com) | The best-in-class nonstandard-speech engine conflicts with EHC's zero-cloud rule → architecture gap, not an integration target. See §3 | [Voiceitt API](https://voiceitt-si-api.readme.io/reference), [developer portal](https://developer.voiceitt.com/) |
| "MSC/GSMTP" | Requested check: **no AAC standard by these names could be found** in any switch/AAC literature or standards body (searches surface only 3GPP MSC and IETF GSMP — unrelated). Possibly a garbled reference; the real AAC export surfaces are HID (RelayKeys), OBF/OBZ/.obl, and Minspeak/proprietary vocab files | — | — | Flag to operator; see §3 | this memo |

### 1c. Environmental control

| Name | What it gives | Protocol / API | License / cloud posture | EHC adoption | Source |
|---|---|---|---|---|---|
| Matter (CSA) | Local-first smart home application standard; multi-fabric (≥5 controllers); certified device classes (lights, locks, sensors, switches) | Matter over Wi-Fi/Thread; BT for commissioning | Open standard (royalty-free to implement via SDKs); local control by design | Prefer controlling Matter *through Home Assistant* rather than implementing a Matter controller; Matter = widest device reach for switch users to control rooms | [HA Matter page](https://www.home-assistant.io/connectivity/matter) |
| Thread | IPv6 low-power mesh transport; border router connects to LAN | OpenThread (REST API on OSS border routers) | Open; local | Same — HA handles it | [HA Thread page](https://www.home-assistant.io/connectivity/thread) |
| Home Assistant | The de-facto local hub: WebSocket + REST APIs, thousands of local integrations (ZHA/Zigbee, Z-Wave JS, IR, MQTT), automations, scripts | Local WebSocket API (auth token); REST | Open Home Foundation, Apache; fully local | **The single highest-leverage adapter**: one sidecar gives EHC lights/locks/IR/TVs/blinds + thousands of sensors, all local; LUCI (wheelchair DA) already advertises Home Assistant compatibility | [HA Matter integration](https://www.home-assistant.io/integrations/matter/), [LUCI user guide](https://www.luci.com/hubfs/Luci_April2026/pdf/613-00003_F_LUCI-User-Guide_Color-1.pdf) |
| R-net / PGDT (Curtiss-Wright) wheelchair bus | Modular power-wheelchair control system over low-speed fault-tolerant CAN (ISO 11898-3); up to 15 modules; Omni adds IR + BT mouse + ECU modes; CJSM2-sw exposes switch jacks; Bluetooth mouse module; licensed third-party developer kit | Proprietary R-net protocol over CAN; OEM-licensed dev kit | Proprietary; local | Read-only observation of wheelchair mode/profile via accessories (D-Sub 9 ECU port on Tecla-class devices, jack sockets); **never inject drive commands** — see §3 | [R-net brochure](https://industrial.curtisswright.com/sites/default/files/medical-mobility/Rnet/r_net_brochure.pdf), [R-net tech manual](https://industrial.curtisswright.com/sites/default/files/sunrise/pgdt_rnet_manual_SK77981-14.pdf) |
| can2RNET (hobbyist) | Reverse-engineered R-net CAN dictionary, joystick injection from USB gamepads, R-net-over-IP | SocketCAN on Raspberry Pi | GPL-3; local | Study it, but it is undocumented, unfunded, and touches the drive system — not an integration EHC should depend on or ship | [can2RNET](https://github.com/redragonx/can2rNET) |
| Tecla-e (Tecla/Origin-class) | BLE switch interface: 2× 3.5mm switch jacks (up to 9 switches w/ adaptor), D-Sub 9 wheelchair ECU port, pairs 8 devices, IFTTT/Alexa/HomeKit app, 48 h battery | BLE HID keyboard + companion app; cloud account for app/IFTTT features | Commercial HW (~$499); hybrid (BT control is cloud-free; app features use cloud) | Reference hardware class for "wheelchair-mounted EHC node": switches + ECU + sensors (motion/temperature/location) feeding the bus | [tecla-e](https://gettecla.com/pages/tecla-e), [FAQ](https://gettecla.com/pages/faq) |
| Origin Instruments (Tapio, Breeze, HeadMouse Nano) | Switch interfaces, USB sip/puff, head mouse running on iPad/iPhone/Android/Windows/Mac | HID | Commercial; local | Compatibility targets for EHC's input adapters | [Origin Instruments](https://www.orin.com/access) |
| LUCI | Wheelchair advanced driver assistance: radar + ultrasonic + camera/IR fusion, 360° scan ~10 Hz, sensor data 12–100 Hz; collision/drop-off protection; FDA Class I exempt medical device; IEC 60601 home-use compliance; Home Assistant compatibility; opt-in caregiver alerts | Proprietary; app + integrations | Commercial; **cloud-connected** (alerts/connectivity), sensing is on-vehicle | Architectural precedent: (a) sensor-fusion rates to plan for, (b) Class-I-exempt + IEC 60601 posture for a wheelchair accessory, (c) override button + aux switch port = the "armed toggle" pattern done physically | [LUCI safety report](https://www.luci.com/hubfs/Luci_April2026/pdf/629-00011_Rev-B_2025-26-Safety-Report.pdf), [LUCI FAQ](https://www.luci.com/faq) |

### 1d. Robotics for assistance

| Name | What it gives | Protocol / API | License / cloud posture | EHC adoption | Source |
|---|---|---|---|---|---|
| Kinova Jaco / Jaco2 / Gen3 | The reference assistive arm (wheelchair-mounted, "a medical device intended for people who are severely impaired", controlled via existing wheelchair drive controls; 2026 user guide) | Kinova C++/.NET/Kortex APIs; ROS/ROS 2 drivers (jaco_ros BSD, ROS 1 era; ROS 2 via Kinova packages — **not re-verified**) | Proprietary HW; drivers open; local | If EHC ever gates an assistive arm, speak its ROS 2 topics; never bypass its own e-stop/start-stop services | [Jaco user guide 2026](https://artifactory.kinovaapps.com/artifactory/generic-documentation-public/Documentation/Jaco%20%26%20UI/EN-UG-007-Jaco-Assistive-robot-user-guide-10.0.pdf), [jaco_ros](http://whiteoak.umd.edu/roswiki/jaco_ros.html) |
| RAMMP (ARPA-H, Univ. Pittsburgh + CMU/Cornell/Northeastern/Purdue/ATDev/LUCI/Kinova, $41 M, 5 yrs) | Next-gen smart power wheelchair + new-generation Jaco + multimodal sensing + adaptive HMI; **explicitly planned as a modular open-source platform** | TBD (research program; announced Nov 2025) | Open-source intent; local | Track: its interfaces will likely become the standard open assistive-platform integration surface in the US | [Kinova RAMMP press release](https://www.kinovarobotics.com/uploads/Kinova-Joins-ARPA-H-Project-to-Advance-Assistive-Mobility-and-Independence.pdf) |
| JOIN (Northeastern, 2026) + WheelArm (2026) | State-of-the-art 2026 assistive manipulation research: Kinova Gen3 + Hello Robot Stretch 3, ROS 2 + MoveIt 2, VLM-driven task planning; WHILL wheelchair + Gen3 with ROS 2 | ROS 2 topics/actions; TCP/IP + ZeroMQ + UDP data collection | Research code; local-first pipelines | Confirms ROS 2 (+ Zenoh-class transport) is the lingua franca; confirms bimanual/VLM assistive systems now run on commodity parts | [JOIN](https://arxiv.org/html/2606.11151v1), [WheelArm WoZ study](https://arxiv.org/html/2601.16870v1) |
| ROS 2 + Zenoh | ROS 2 middleware; Zenoh is Tier-1 since Kilted Kaiju (May 2025) and present in Lyrical docs; default remains Fast DDS; Zenoh = pub/sub + query, low wire overhead, no "incompatible QoS" class | rmw_zenoh_cpp; SROS2 security suite (auth, access control, encryption) | EPL-2.0; local | EHC's "Zenoh alternative" plan is validated: a Zenoh route gives ROS 2 interop *and* a lighter non-ROS bus for pure sensor Observation traffic | [ROS 2 middleware vendors (Kilted)](https://docs.ros.org/en/kilted/Concepts/Intermediate/About-Different-Middleware-Vendors.html), [Kilted release](https://www.openrobotics.org/blog/2025/5/23/ros-2-kilted-kaiju-released) |
| OpenVoiceOS (OVOS) | Mycroft successor: voice OS with formal, implementation-agnostic messagebus specs; wake-word/STT/TTS/VAD plugin architecture; HiveMind satellites; fully-offline stack is documented and achievable (onnx-asr, phoonnx, silero VAD, precise-onnx) | WebSocket messagebus (`ovos.utterance.handle` etc.); formal specs in `OpenVoiceOS/architecture` | Apache-2.0/BSD; **default STT/TTS point at public community servers** (privacy trap, documented) | Best reference for EHC's voice stack architecture and for a local voice *intent* surface; copy the "every plugin addressable over one bus" pattern; beware defaults | [OVOS technical manual](https://openvoiceos.github.io/beta-technical-manual/architecture-overview/), [privacy & security](https://openvoiceos.github.io/beta-technical-manual/privacy-security/) |
| Rhasspy 2.5 | Fully offline voice assistant services; Hermes/MQTT protocol; HTTP + WebSocket APIs; grammar-based intents producing JSON events | MQTT (Hermes superset), HTTP, WS | MIT-class open; fully local | Alternative to OVOS for a minimal offline voice-intent service; Hermes protocol is a usable message taxonomy for speech services | [Rhasspy](https://rhasspy.readthedocs.io/), [GitHub](https://github.com/rhasspy/rhasspy) |
| ISO 10218-1/-2:2025 (+ absorbed ISO/TS 15066) | Robot safety: ed. 3 / ed. 2 published 2025-02-05; cited in EU OJ 2026-09-07; most of TS 15066 (collaborative operation, biomechanical limits Annex M, force/pressure measurement Annex N, PFL/SSM) absorbed into Part 2 | Machine-safety standard (type C) | Paywalled ISO standard; n/a | Scope **excludes** medical/healthcare robots, prosthetics/aids for the physically impaired, and public-facing service robots — so it bounds what it does *not* cover for assistive arms, but its safety functions vocabulary (monitored standstill, speed monitoring, enabling device, safety-rated soft limits) is the right vocabulary for EHC actuation gates | [ISO 10218-1:2025](https://www.iso.org/standard/73933.html), [ISO/TS 15066 status](https://www.iso.org/standard/62996.html), [2025 changes guide](https://www.spilma.com/en/guides/industrial-robotics-iso-10218-15066) |
| ISO 13482 (Ed. 2: "service robots") | Safety requirements for personal/professional service robots incl. physical human-robot contact and functional safety — **the** applicable standard for assistive arms near their user. Edition 2 was at stage 60.00 (under publication) as of **2026-11-11** | Type C standard | Paywalled; n/a | Design EHC's actuation gates to be *ready* for an ISO 13482-style risk file: bounded velocity/force, monitored stop, operator presence, user-overridable | [ISO 13482 lifecycle](https://www.iso.org/standard/83498.html), [scope map guide](https://physicalaiguide.com/guides/robot-safety-standards-working-near-people) |
| IEC 60601-1 (3.2) + 60601-1-2 | Basic safety & essential performance for medical electrical equipment; EMC immunity tables (IEC 61000-4-x) | Type standard | Paywalled; n/a | Relevant the moment EHC hardware mounts on a wheelchair or controls anything medical-adjacent; LUCI shows the practical posture (Class I exempt + applicable IEC 60601 home-use requirements) | [IEC 60601-1 CSV](https://webstore.iec.ch/en/publication/67497), [CASRAI 60601 guide](https://casrai.org/guides/iec-60601-1) |

### 1e. Sensing & output for accessibility

| Name | What it gives | Protocol / API | License / cloud posture | EHC adoption | Source |
|---|---|---|---|---|---|
| ODAS / SRP-PHAT microphone arrays (SoundScape-class builds) | Open-source 3D sound-source localization + tracking (ODAS) + separation; SoundScape: 6-mic array, ≤15.5° error, 0.2 s latency, $60 BOM, haptic shoulder wearable + watch app | ODAS (open source); custom MCU pipeline | Open; fully local | `kind: "sound.event" { bearing, class, confidence }` — the Deaf/HoH watch lane; pairs with EHC's existing mic pipeline | [SoundScape](https://inafi.github.io/soundscape), [ODAS-based study](https://ceur-ws.org/Vol-3907/paper7.pdf) |
| SENTRYNet (2026) | Privacy-preserving in-home D/HoH alerting architecture: local sensing → edge processing → AES-128/HMAC/RSA session security → smartwatch haptic+visual alerts; 2.6–3.2 s end-to-end | Research architecture (DCOSS-IoT 2026) | Open research; local | Blueprint for watch-delivered alerts: haptic + visual + short text, latency budget, encryption on the local bus | [SENTRYNet](https://www.computer.org/csdl/proceedings-article/dcoss-iot/2026/467000a561/2jiaVjF4rSM) |
| Vibrotactile wearables (Ontenna, LRA bracelets, shoulder-mounted direction displays) | Sound → vibration vocabularies; direction conveyed by body position; classification via Edge Impulse/MFCC on-device | Custom MCU; no standard | Mostly research/DIY; local | EHC output adapter class: map watch events to haptic patterns; keep patterns user-configurable | [CEUR paper](https://ceur-ws.org/Vol-3907/paper7.pdf), [vibrotactile bracelet](https://rsisinternational.org/journals/ijriss/uploads/vol10-iss1-pg1395-1411-202601_pdf.pdf) |
| HID Braille Display usage page 0x41 (HUTRR78, in HUT 1.5–1.7) | Standardized braille display over USB/BT: 6/8-dot cells, rows, router keys, Perkins keys, screen-reader control/identifier usages | USB/BT HID | Free spec; implemented by Apple, Android (API 35 `BrailleDisplayController`), Windows | **Do not hand-roll braille output.** Expose EHC's UI through the OS screen reader (NVDA/Orca/VoiceOver), which already speaks 0x41; optionally emit 0x41 directly in a dedicated "braille lane" later | [USB-IF announcement](https://www.usb.org/node/588), [Apple braille HID ref](https://developer.apple.com/documentation/accessibility/braille-hid-reference-for-connecting-to-apple-platforms), [Android controller](https://developer.android.com/reference/android/accessibilityservice/BrailleDisplayController) |
| HID Haptics usage page 0x0E (HUTRR63) | Standardized haptic effect playback over HID | USB/BT HID | Free spec | Future output channel for switch/braille-style controllers with haptics | [HUT 1.5](https://usb.org/sites/default/files/hut1_5.pdf) |
| HID Assistive Control CA + sensor pages (0x20) | Also covers proximity/object-presence sensor usages (HUTRR82) for HID-class sensors | USB/BT HID | Free spec | Cheap path for "object appeared" watches from HID-class sensors without a camera | [HUTRR82 ref](https://usb.org/integrated-usage-table-requests) |
| Lidar/depth for wheelchair context | LUCI ships radar+ultrasonics+camera/IR (not lidar) and treats "sensor fusion 12–100 Hz → scaled input" as the product; research on depth-camera wheelchair obstacle sensing is abundant but unstandardized **(no public depth spec found)** | Proprietary / research | Hybrid | If EHC consumes wheelchair sensors, plan for multi-modal range streams with per-source Hz caps and drop-off (negative obstacle) as a distinct `kind` | [LUCI safety report](https://www.luci.com/hubfs/Luci_April2026/pdf/629-00011_Rev-B_2025-26-Safety-Report.pdf) |

### 1f. Software accessibility of the harness itself

| Name | What it gives | Protocol / API | License / cloud posture | EHC adoption | Source |
|---|---|---|---|---|---|
| WCAG 2.2 (W3C Rec, Oct 2023; updated Dec 2024) | The baseline contract: 2.1.1 Keyboard (A), 2.1.2 No Keyboard Trap (A), 2.4.3 Focus Order (A), 2.4.7 Focus Visible (AA), 2.4.11 Focus Not Obscured (AA, new in 2.2), 2.4.13 Focus Appearance (AAA, new), 1.4.11 Non-text contrast 3:1, 2.2.1 Timing Adjustable, captions under 1.2 | W3C spec | Free; n/a | Every EHC surface (camera pop-out, watch config, actuation prompts) inherits these; scanning users make 2.2.1 Timing Adjustable existential — consent dialogs with auto-timeout are a hard fail | [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [What's new in 2.2](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/) |
| UIA (Windows) / AT-SPI2 (Linux) / NSAccessibility (macOS) | Platform accessibility trees screen readers consume (NVDA, JAWS, Narrator, Orca, VoiceOver); AutomationProperties, automation events; Microsoft ships AccScope + Accessibility Insights and prescribes "fail builds on a11y regressions" | UIA COM/provider API; AT-SPI2 D-Bus | Free; local | Electron renders through Chromium's accessibility tree → UIA/AT-SPI, but only when accessibility is enabled (`app.setAccessibilitySupportEnabled()` / auto-detection per Electron docs — **not re-verified today**). Custom canvases (vision overlays) must expose role/name/state or they are invisible to NVDA | [Windows a11y testing](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing), [Win32 best practices](https://learn.microsoft.com/en-us/windows/win32/winauto/accessibility-best-practices) |
| ARIA APG keyboard patterns | Focus-vs-selection discipline, composite widget keyboard behavior, visible-focus rules | Web/Chromium | Free | EHC's Electron UI should follow APG patterns rather than inventing keyboard interaction | [APG keyboard interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) |
| EN 301 549 | EU ICT accessibility procurement standard; harmonizes to WCAG — makes the above a purchase requirement, not a nicety | Standard | Free | If EHC is ever sold to public bodies in the EU, this is the gate (**not re-verified against the 2026 text**) | (general knowledge; verify current version) |

### 1g. Comparable products — integration surfaces

| Product | Integration surface | Local vs cloud | Notes for EHC | Source |
|---|---|---|---|---|
| Voiceitt | Public HTTP + Socket.IO APIs, JWT; Chrome extension; Webex/Teams/Zoom; Alexa | **Cloud** | Best dysarthria ASR; zero-cloud conflict | [API docs](https://voiceitt-si-api.readme.io/reference) |
| Envision AI / Envision Glasses | Consumer app; June 2026: on-device scene description + VQA with Arm SME2 + Gemma 4 (works offline); Ally/Aira remote assistance = human/cloud | **Moving local-first** | Proof the zero-cloud scene-description lane EHC wants is now achievable on consumer NPUs | [Envision/Arm/Google](https://www.letsenvision.com/blog/envision-arm-and-google-are-bringing-powerful-visual-ai-on-device) |
| Be My Eyes | Volunteer live video (network), "Be My AI" per-image description; no public third-party API **(unverified)** | Cloud | Human-in-the-loop model; EHC's "Look" lanes should leave a "hand to a human" seam even if local-only | [SENSEYE survey](https://pmc.ncbi.nlm.nih.gov/articles/PMC13328745) |
| OrCam MyEye | No public API; gestures + button; fully offline core; "Just Ask" connected mode on Pro | **Local** (core) | The privacy/latency benchmark for wearables; no integration surface at all | [OrCam vs Envision comparison](https://floridareading.com/blogs/news/orcam-myeye-vs-envision-glasses-comparing-the-top-smart-glasses-for-visual-independence) |
| Tecla-e | BLE HID keyboard emulation from switches/wheelchair ECU; 8 devices; IFTTT/Alexa/HomeKit via companion app (cloud account) | Hybrid | The "wheelchair node" hardware pattern; EHC could be a 9th pairing target as a plain HID consumer | [tecla-e](https://gettecla.com/pages/tecla-e) |
| Enable Viacam (Sesame-class head tracking) | GPL-3 webcam head mouse, Windows/Linux; EVA Facial Mouse PRO on Android; no API — injects OS pointer | **Local** | Reference for camera-driven pointer lane; the "second person in frame breaks control" failure mode is documented by AT reviewers | [eViacam](https://eviacam.crea-si.com/), [AT Observatory](https://tecnoaccesible.net/en/catalog/enable-viacam) |
| HIDAgent (CMU, Jan 2026) + esp32-iphone-agent / Aiden (2026) | AI agents that *act* on real devices via USB HID + out-of-band screen capture (RP2040/ESP32-S3, ~$7 BOM, local vision models OK, ~3.5 s/step) | Local-capable | Directly relevant to EHC's actuation-gate philosophy: an agent acting as a HID device on someone's *personal* device is exactly the trust boundary EHC's gates exist to police | [HIDAgent](https://arxiv.org/html/2602.00492v1), [ESP32 iPhone agent](https://yuv.ai/blog/esp32-iphone-agent) |
| Project Prakash | Vision-restoration research program (not an integration surface) | Research | Cited for completeness; no API | (no single URL; treat as background) |

---

## 2. Architecture implications — what changes when primary users may be non-typing, non-speaking, or low-vision

### 2.1 The `Observation` envelope mostly survives — but `kind` and `t` need work

- The `{ source, kind, t, seq, payload }` shape is compatible with every source found here: LSL has native time-sync (use LSL clocks or map LSL timestamps into `t`), HID events are trivially mappable, ODAS gives bearing+class, R-net/ECU gives mode changes. **Keep the envelope; add a clock-domain field** (`t` basis: monotonic-local, LSL, NTP-absent) because mixing camera frames, gaze, and biosignals makes cross-clock alignment the first bug users will see.
- `kind` taxonomy must be open-ended *namespaced strings* from day one (`switch.press`, `gaze.fixation`, `emg.gesture`, `sound.event`, `aac.selection`, `wheel.mode`, `obstacle.range`, `dropoff.detected`, `presence`). The OpenAAC `.obl` format and LSL stream metadata are the two prior art structures worth borrowing.
- **Rates differ by 4 orders of magnitude**: switches <10 Hz, gaze 30–90 Hz, wheelchair sensors 12–100 Hz (LUCI), raw sEMG/EEG in the hundreds-to-kHz class (BrainFlow/LSL). Retention `none` by default is *essential* for biosignals (raw EMG/EEG/gaze streams are sensitive personal data — GDPR Art. 9-class — **interpretation, not legal advice**), and per-source caps belong in the bus, not in each adapter.

### 2.2 Watches become bidirectional, and switch-triggered watches are a new primitive

- "Tell me if a person appears" is the right instinct; for a switch user the *response* channel matters as much as the detection: every watch alert needs ≥2 output modalities (visual + TTS (already in stack) + haptic via phone/wearable — SENTRYNet shows smartwatch delivery at ~2.5–3.2 s is practical today).
- New pattern: **watches as event sources for actions** — "when watch X fires, run bounded action Y after switch confirmation." For a single-switch user, this turns EHC from an app into an environmental-control unit: the watch list becomes a scannable grid, confirmation is one switch press.
- Gaze presence ("Midas touch") must never auto-trigger actuation; dwell-based selection needs explicit per-user dwell times and a cancel affordance (WCAG 2.2.1 timing again).

### 2.3 Actuation gates: the armed toggle cannot be a press-and-hold

- The current design (ask + armed toggle the model cannot set + bounded duration + model-independent stop) is directionally aligned with ISO 10218:2025's vocabulary (enabling device, monitored standstill, safety-rated limits). For disabled users, four concrete changes:
  1. **No duration-based holds as the only gate.** Tremor, fatigue, and sip-puff breathing make "hold 3 s" unreliable and sometimes impossible. Use *sequence* gates instead: press A then B within a generous, configurable window; or scan-to-confirm; or a physical hardware toggle (the LUCI Dashboard button + auxiliary switch port is the precedent — one physical button the software can only *ask* to change).
  2. **Model-independent stop must be single-switch and always reachable**, from any UI state, mapped to a physical switch if one exists. This is the "enabling device" inverted: in assistive contexts the *stop* is the thing that must cost one press. **Shipped for sensors (2026-11-27):** `POST /api/sensors/stop-all` stops every source, removes every watch, closes the bridge and halts nothing-observes-until-resume; the UI exposes it as **Stop everything** (panel) and a **stop all sensors** button in the always-visible status bar — one activation, no confirmation dialog, no press-and-hold, a stable position whether anything is on or not; a physical switch maps to this one route (no native API needed). **Not shipped yet:** actuation stopping (nothing here drives hardware).
  3. **Bounded duration must be user-configurable, not a constant**: scanning a confirmation dialog can legitimately take 10–30 s; actuation windows sized for typing users will strand them mid-action.
  4. **Every gate prompt announces itself**: ARIA live region / UIA automation event / TTS simultaneously. A modal that appears silently is invisible to a screen-reader user and to a gaze user with eyes elsewhere. **Shipped for sensors:** the stop's state and the watch/log lines are in ARIA live regions, readings are shown as sentences, `prefers-reduced-motion` removes the sweep animation; a spoken (TTS) channel is open (see worklist N3b).

### 2.4 Consent UX under screen readers and slow input

- The "loud consent" for BYOK camera lanes must be *loud in every channel*: spoken (TTS), visual (non-color-coded, 3:1 contrast), and non-visual (haptic where available). A consent indicator that only changes screen color fails WCAG 1.4.1-equivalent checks for a blind operator.
- Consent capture itself must be scan-operable: no hover, no drag, no time-window combos, adjustable or absent timeouts.
- Camera/privacy state should be observable as an `Observation` too, so a watch can answer "is the camera lane currently armed?" — the accessibility analog of the consent indicator.

### 2.5 STT/TTS: the harness must be an AAC *endpoint*, not just a speech app

- Non-speaking users will reach EHC through AAC devices (HID text via RelayKeys-class bridges, iOS/Android switch-driven keyboards) or not at all. EHC's prompt box must accept text injected as synthetic keyboard input (it will arrive as ordinary HID) and must *not* require the mic path.
- The 60 s press-to-talk cap and push-to-talk model are fine for speaking users but assume a hand and a voice; provide an AAC-friendly equivalent (text-first command entry, dwell or switch-triggered "send").
- Speech *output* must also be capturable: Deaf/HoH users need captions for every TTS utterance (WCAG 1.2), and braille users get it free only if EHC renders captions as real text in the accessibility tree — never as canvas overlays.

### 2.6 ROS 2 bridge and sidecars

- Zenoh as Tier 1 (Kilted 2025, Lyrical docs) validates the "Zenoh alternative" plan; SROS2 gives access control/encryption on the same route. Map `Observation` ↔ ROS 2 topics with explicit QoS; keep non-ROS sidecars on stdio/loopback as planned.
- Add **LSL as a second neutral route** (inlet/outlet sidecar): it is the only way to speak to the existing EEG/EMG/eye-tracking world (OpenBCI, iMotions, most vendors) without per-vendor work.
- Safety boundary: EHC should never generate ROS 2 *command* topics for physical robots — only `Observation` streams and gate-approval signals; commands belong to certified stacks (MoveIt 2 + ISO 13482-adjacent risk files).

### 2.7 Home automation as the actuation surface most users will actually have

- Home Assistant's local WebSocket API is the correct first actuation target (lights, blinds, TVs, locks): local, scriptable, and already the compatibility target of wheelchair-side products (LUCI). Matter/Thread/Zigbee/Z-Wave/IR are then HA's problem, not EHC's.
- R-net/wheelchair drive remains out of bounds (see §3.7); wheelchair *peripherals* (Tecla-class ECU ports, switch jacks) are in bounds as inputs.

---

## 3. What we would likely miss — the honest gap list

1. **"MSC/GSMTP" does not exist as a findable AAC standard** (checked Nov 2026; nearest real exports: RelayKeys command set, OBF/OBZ/.obl, proprietary Minspeak/Grid vocab files). If someone on the team remembers where this came from, re-verify before designing around it.
2. **"GazeHID" and "Gaze Pipe" as named protocols could not be verified.** The real standards are HID usage page 0x12 (eye/head trackers) and the iMotions-style TCP/UDP event + LSL pattern. Design to those.
3. **"Tappt/Integza-class" EMG devices could not be identified by name.** The verified 2026 EMG landscape: Meta Neural Band + Device Access Toolkit 1.0 (GA 2026-09-30), BrainFlow-supported open boards, discontinued Myo. If these are niche products, they'll likely speak serial/BLE anyway — BrainFlow or a tiny serial sidecar covers them.
4. **Non-standard speech has no local-first answer yet.** whisper.cpp degrades badly on dysarthric speech; Voiceitt (the state of the art) is cloud-only; the Speech Accessibility Project distributes dysarthric speech datasets for research (UIUC — **not re-verified today**). This is the single biggest functional gap between EHC's zero-cloud rule and its stated users.
5. **AAC devices do not export intents.** You can get keystrokes, switch presses, and (sometimes) .obl logs — never "the user selected the concept X." Vocabularies (Minspeak, Grid) are proprietary motor plans; any EHC feature assuming semantic AAC input will be disappointed.
6. **Neuralink has no public API as of Nov 2026** (API Evangelist: no API/SDK/portal, agent-readiness 0.0; device is investigational, not sold). Any roadmap mention of BCI must route through LSL/BrainFlow/HID abstractions or it is fiction.
7. **Switch timing will break naive UX.** Debounce 0.01–0.1 s, acceptance 0–10 s, repeat delays — every EHC interaction must tolerate slow, repeated, held, and accidental presses. Auto-dismissing toasts/consent dialogs are a hard failure for scanning users.
8. **The accessibility tree is where agent UIs go to die.** Camera pop-outs, vision-model overlay lanes, and terminal-style logs are typically canvases — invisible to NVDA/Orca and therefore to braille displays. Building real UIA/AT-SPI exposure for *live sensor visualizations* is unglamorous, easy to regress, and rarely in anyone's definition of done. Microsoft's own guidance is to fail builds on regressions; EHC needs that gate.
9. **Audio-only or color-only feedback excludes the primary users.** Every watch, gate, and consent state needs at least two of {visual, TTS, haptic}. Nobody ships this by default; SENTRYNet-style haptic delivery is an extra output adapter EHC doesn't have yet.
10. **Wheelchair drive integration is effectively closed.** R-net is licensed (OEM dev kit), fault-tolerant CAN; can2RNET exists but is reverse-engineered, undocumented, and touches the drive system — shipping it would be negligent. Realistic scope: observe mode changes via accessory ports, control *through* ECU-class accessories, never drive.
11. **Medical-device creep is a real regulatory boundary.** A wheelchair-mounted sensor/actuation stack is exactly the territory where LUCI had to become an FDA Class I (exempt) device with IEC 60601 home-use compliance. Software-only EHC can arguably stay outside, but the moment it *gates* physical actuation near a user, ISO 13482 (Ed. 2 under publication as of Nov 2026) and IEC 60601 vocabulary should shape the gate design even if certification never happens.
12. **The best assistive "AI vision" is racing to on-device, and that's an arms race, not a port.** Envision+Arm+Gemma 4 (June 2026) shows scene description/VQA running offline on phones; EHC's local "Look" lanes must hit comparable latency (~1–3 s/step local vision, per the ESP32-agent measurements) or disabled users will rationally prefer cloud tools that are faster — consent model or not.
13. **Observation bandwidth asymmetry**: biosignals and gaze dwarf switch/AAC traffic; without per-source rate caps and retention rules, the "retention none" default will be violated by debug convenience long before a user chooses it.
14. **Reduced-motion, high-contrast, and captions have no owner** in a typical agent-harness roadmap; the camera window's motion (lane animations, live video) needs a `prefers-reduced-motion` respect path and forced-colors support (**platform conventions; not re-verified in current Electron docs**).
15. **Relying on OS screen readers for braille is correct but conditional**: it only works if EHC's UI is genuinely in the accessibility tree. There is no shortcut; there is also no safe way to hand-roll 0x41 braille output in parallel with NVDA without conflicts.

---

## 4. First three things to implement (prioritized)

### 1. Switch-class input as a first-class `Observation` source (HID + keyboard + gamepad + serial), with configurable timing and a single-switch global STOP

**Why first:** it is the cheapest adapter with the widest reach — every USB/Bluetooth switch box, sip-puff switch, wheelchair ECU accessory (Tecla-class D-Sub 9 → HID), and many eye-gaze/EMG backends converge on HID keyboard/mouse. One input adapter makes EHC operable today by users who cannot touch a keyboard, and it feeds the two systems that most need it: watches (switch-armed watches) and actuation gates (sequence-confirm, single-switch stop). Implementation notes: honor the Space/Enter scanning convention; enumerate HID Assistive Control collections (GDT 0x10) and Eye/Head Tracker page 0x12 where present; expose debounce/acceptance/repeat as user config (ranges from the Colven & Judge parameter study); bind a reserved physical "stop" mapping that bypasses every queue the model can influence.

### 2. Screen-reader-grade UI + multi-channel alerting for consent, watches, and gates

**Why second:** everything else is unusable without it. Concretely: ensure Chromium accessibility is enabled in the Electron shell (and *verified* in CI with Accessibility Insights/AccScope on Windows and Orca on Linux); every custom overlay gets role/name/state; all prompts are ARIA-live + TTS-announced; all timers are adjustable (WCAG 2.2.1); every alert goes out on ≥2 channels (visual + TTS now, haptic adapter next). This is also the compliance core (WCAG 2.2 / EN 301 549) and the enabler for braille (via NVDA/Orca + HID 0x41) without writing any braille code.

### 3. Two neutral sidecar adapters: Home Assistant (local WebSocket) + LSL (liblsl inlet/outlet)

**Why third (and why these two):** they buy the most capability per adapter, using standards that already exist, in exactly the sidecar shape EHC already plans. Home Assistant gives environmental control and thousands of local sensors with zero cloud — and is the interoperability target wheelchair-side products (LUCI) already chose, so "EHC turns on the lamp when I say so, after one switch confirmation" is achievable end-to-end. LSL gives the entire biosignal/gaze research world (OpenBCI, BrainFlow boards, Tobii Pro, iMotions) a local, time-synchronized path into `Observation` with retention-none defaults enforced per source. Together they make "physicalization" real for switch, gaze, and biosignal users without EHC writing a single device driver.

*(Deliberately deferred: ROS 2/Zenoh command-side work until a certified actuator stack exists; direct Matter controller implementation; braille-lane output; nonstandard-speech model work — see §3.4, which deserves its own research spike on local fine-tuning of whisper-class models on dysarthric data.)*

---

## 5. Sources

**Switch access & scanning**
- https://www.callscotland.org.uk/information/alternative-access/switches/
- https://eprints.whiterose.ac.uk/id/eprint/10291/1/SwitchScanningMaster_8_472.pdf (Colven & Judge, *Switch access to technology*)
- https://support.inclusive.com/article/using-switches
- https://support.google.com/accessibility/android/answer/6301490 ; https://support.google.com/accessibility/answer/10274137
- https://casrai.org/guides/switch-access (2026)
- https://en.wikipedia.org/wiki/Switch_access_scanning
- https://www.makersmakingchange.com/news/assistive-technology-in-gaming-MCTUYK7YHG6NFNTHPTBE7U5J4RTM

**HID standards**
- https://usb.org/sites/default/files/hut1_7.pdf (HUT 1.7 — Braille 0x41, Eye/Head 0x12, Haptics 0x0E)
- https://usb.org/sites/default/files/hutrr81_-_correction_to_hutrr68.pdf ; https://usb.org/sites/default/files/hutrr68_0.pdf (Assistive Control)
- https://www.usb.org/node/588 (HID braille standard announcement)
- https://developer.apple.com/documentation/accessibility/braille-hid-reference-for-connecting-to-apple-platforms
- https://developer.android.com/reference/android/accessibilityservice/BrailleDisplayController
- https://usb.org/integrated-usage-table-requests (HUTRR74/78/82 index)

**Gaze**
- https://mamem.github.io/GazeTheWeb
- https://github.com/sky0hunter/way-to-gaze
- https://gazeplay.github.io/GazePlay
- https://www.tobii.com/products/software/applications-and-developer-kits/tobii-pro-sdk
- https://www.tobii.com/products/software/applications-and-developer-kits/tobii-pro-sdk/tobii-pro-glasses-3-api
- https://www.tobii.com/products/integration/screen-based-integrations/tobii-nexus
- https://imotions.com/products/imotions-lab/developers/api ; https://imotions.com/wp-content/uploads/brochures/imotions_module_descriptions.pdf

**EMG / BCI**
- https://github.com/brainflow-dev/brainflow ; https://brainflow.org/2021-02-05-lsl-review/
- https://labstreaminglayer.readthedocs.io/info/intro.html ; https://labstreaminglayer.readthedocs.io/info/supported_devices.html
- https://docs.openbci.com/Software/CompatibleThirdPartySoftware/LSL ; https://docs.openbci.com/ForDevelopers/SoftwareDevelopment
- https://www.meta.com/emerging-tech/emg-wearable-technology ; https://developers.meta.com/wearables/faq
- https://www.meta.com/blog/university-of-utah-accessibility-research-meta-neural-band
- https://www.nature.com/articles/s41586-025-09255-w (Meta sEMG Nature paper)
- https://apis.io/providers/neuralink ; https://neuralink.com/updates/ ; https://www.neurapod.com/blog/when-neuralink-available-public
- https://github.com/api-evangelist/science-corporation

**AAC**
- https://docs.acecentre.org.uk/products/relaykeys
- https://www.openboardformat.org/ ; https://www.openaac.org/docs.html ; https://github.com/shayc/open-board-format
- https://minspeak.com/aac ; https://prc-saltillo.com/blog/app-update-2026-3
- https://voiceitt-si-api.readme.io/reference ; https://developer.voiceitt.com/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC6436971 (Koch Fager et al., emerging access technologies)

**Environmental control & wheelchairs**
- https://www.home-assistant.io/connectivity/matter ; https://www.home-assistant.io/connectivity/thread ; https://www.home-assistant.io/integrations/matter/
- https://industrial.curtisswright.com/sites/default/files/medical-mobility/Rnet/r_net_brochure.pdf
- https://industrial.curtisswright.com/sites/default/files/sunrise/pgdt_rnet_manual_SK77981-14.pdf
- https://github.com/redragonx/can2rNET
- https://gettecla.com/pages/tecla-e ; https://gettecla.com/pages/faq
- https://www.orin.com/access
- https://www.luci.com/hubfs/Luci_April2026/pdf/629-00011_Rev-B_2025-26-Safety-Report.pdf ; https://www.luci.com/faq

**Robotics & safety standards**
- https://artifactory.kinovaapps.com/artifactory/generic-documentation-public/Documentation/Jaco%20%26%20UI/EN-UG-007-Jaco-Assistive-robot-user-guide-10.0.pdf
- http://whiteoak.umd.edu/roswiki/jaco_ros.html ; https://robots.ros.org/jaco
- https://www.kinovarobotics.com/uploads/Kinova-Joins-ARPA-H-Project-to-Advance-Assistive-Mobility-and-Independence.pdf (RAMMP)
- https://arxiv.org/html/2606.11151v1 (JOIN) ; https://arxiv.org/html/2601.16870v1 (WheelArm)
- https://docs.ros.org/en/kilted/Concepts/Intermediate/About-Different-Middleware-Vendors.html ; https://www.openrobotics.org/blog/2025/5/23/ros-2-kilted-kaiju-released
- https://openvoiceos.github.io/beta-technical-manual/architecture-overview/ ; https://openvoiceos.github.io/beta-technical-manual/privacy-security/
- https://rhasspy.readthedocs.io/ ; https://github.com/rhasspy/rhasspy
- https://www.iso.org/standard/73933.html (ISO 10218-1:2025) ; https://www.iso.org/standard/62996.html (ISO/TS 15066)
- https://www.iso.org/standard/83498.html (ISO 13482 Ed. 2, under publication) ; https://physicalaiguide.com/guides/robot-safety-standards-working-near-people
- https://www.spilma.com/en/guides/industrial-robotics-iso-10218-15066
- https://webstore.iec.ch/en/publication/67497 (IEC 60601-1 CSV) ; https://casrai.org/guides/iec-60601-1

**Sensing / Deaf & HoH output**
- https://inafi.github.io/soundscape (ODAS-based localization wearable)
- https://ceur-ws.org/Vol-3907/paper7.pdf (vibrotactile localization + identification)
- https://www.computer.org/csdl/proceedings-article/dcoss-iot/2026/467000a561/2jiaVjF4rSM (SENTRYNet)
- https://rsisinternational.org/journals/ijriss/uploads/vol10-iss1-pg1395-1411-202601_pdf.pdf (vibrotactile bracelet, Edge Impulse)

**Software accessibility**
- https://www.w3.org/TR/WCAG22/ ; https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/
- https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/
- https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-testing
- https://learn.microsoft.com/en-us/windows/win32/winauto/accessibility-best-practices
- https://webaim.org/techniques/keyboard

**Comparable products & agent-on-device**
- https://www.letsenvision.com/blog/envision-arm-and-google-are-bringing-powerful-visual-ai-on-device
- https://floridareading.com/blogs/news/orcam-myeye-vs-envision-glasses-comparing-the-top-smart-glasses-for-visual-independence
- https://pmc.ncbi.nlm.nih.gov/articles/PMC13328745 (SENSEYE — product survey incl. Be My Eyes, Seeing AI, OrCam, Envision)
- https://eviacam.crea-si.com/ ; https://github.com/cmauri/eviacam ; https://tecnoaccesible.net/en/catalog/enable-viacam
- https://arxiv.org/html/2602.00492v1 (HIDAgent, CMU 2026)
- https://yuv.ai/blog/esp32-iphone-agent ; https://github.com/AidenAI-IO/aiden-hardware-demo

*End of memo. Unverified items are marked inline; the four flagged-name items (MSC/GSMTP, GazeHID/Gaze Pipe, Tappt/Integza, EN 301 549 current text) should be re-checked before any design work cites them.*
