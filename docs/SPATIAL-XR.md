# SPATIAL-XR - VR, AR and spatial computing for Event Horizon Code (design memo)

**Status: research and design; nothing implemented.** Researched 2026-11-27; sources in section 10. Written against EHC 0.0.4 (`electron ^42.0.0` in `package.json`, 42.11.18 installed at the time). **EHC now ships `electron 45.5.0` — see finding 1's 45.5.0 re-measurement.** the sensor bus (`docs/SENSORS.md`, and `src/server/sensorBus.ts`, which was in flight and untracked while this memo was written), and the accessibility requirements in `docs/SENSORS-ACCESSIBILITY.md`. The EHC documents read for this memo are listed as [S72].

Operator's direction this memo follows: physicalisation, robots and AR/VR are the differentiators; **base VR/AR features belong in the MIT core, advanced feature sets are premium**; disabled and handicapped users are a primary lens.

Evidence labels used throughout:

| Label | Meaning |
|---|---|
| **[M]** | Measured on the reference machine on 2026-11-27. Command and output are quoted where it is used. |
| **[V]** | Verified today against a primary source: specification, vendor documentation, registry, or source code. |
| **[R]** | Reported by a secondary source (press, wiki, third-party repository, forum). |
| **[?]** | Unverified. Could not be confirmed in this session. Treat as a hypothesis to test, not a fact. |

## 0. Findings that change the plan

1. **Stock Electron cannot reach a headset, and no flag fixes it.** [M] On the installed Electron 42.11.18 (Chromium 148.0.7778.280) `navigator.xr` exists, but `isSessionSupported('immersive-vr')` and `('immersive-ar')` both resolve `false`, with and without `--enable-features=OpenXR`. Cause: Electron builds with `checkout_openxr = False` (its `DEPS`, also on `43-x-y` and `main`), which compiles Chromium's OpenXR backend out. A headset is therefore reached **out of process**, through a bridge. Evidence in 2.1. **Re-measured 2026-11-27 on Electron 45.5.0 (Chromium 156.0.8078.109): 
avigator.xr is ABSENT entirely** (not merely isSessionSupported === false), in a secure context, with --enable-features=OpenXR. Conclusion unchanged and slightly strengthened.
2. **The cheapest bridge needs no app, no sideload and no engine**: a WebXR page served by EHC's own server and opened in the headset's browser, plus a TypeScript OSC/OSCQuery module for VRChat. Both are MIT-able today. Ranked comparison in 2.5.
3. **Eye tracking is the exception, not the rule.** `XR_EXT_eye_gaze_interaction` is advertised by SteamVR, Steam Frame, Quest Pro, PICO 4 Ultra, Android XR, Magic Leap 2 and HoloLens 2 - not by Quest 3 or 3S (no hardware) - and visionOS never exposes gaze to apps (1.4, 1.5). Head pose is the universal fallback: head-gaze + dwell + one confirm action works on every runtime.
4. **Two 2026 platform moves change the PC-to-headset picture, but not Phase 0.** Apple added Foveated Streaming (visionOS 26.4), which receives OpenXR content streamed from a PC running NVIDIA's CloudXR runtime [V]. Valve shipped Steam Frame (reported 2026-09-18) with eye tracking on the open SteamVR runtime [R][V].
5. **The robotics world already converged on EHC's bridge shape.** XRoboToolkit (headset app + PC service + ROS 2 node) ships a per-stream on/off toggle and a user-held pause button [V] - the headset-side mirror of "every sensor is off until the user turns it on".
6. **Platform churn is high.** Horizon Workrooms was discontinued (2026-02-16), Microsoft Mesh retired (2025-12-01), HoloLens 2 is out of production (support to 2027-12), Windows Mixed Reality support ends November 2026 [V][R]. Design against protocols (OpenXR, OSC, WebSocket), not products.

## 1. Runtimes and standards

### 1.1 The standard: OpenXR

- OpenXR is Khronos' royalty-free C API for XR. 1.0 was released 2019-07-29 and 1.1 on 2024-04-15; the current specification is **1.1.65** [V S2][R S64]. 1.1 moved widely used extensions (for example local-floor reference space) into the core [R S64].
- Architecture: a thin **loader** finds an installed **runtime**; the runtime owns tracking, the compositor, display timing and input; API layers can sit between loader and runtime [R S64][V S71]. On a PC the active runtime is selected in the registry.
- Licences: specification CC-BY-4.0; SDK and loader Apache-2.0 (repository licence confirmed today) [V S5][M S70].
- The Khronos roadmap slide lists OpenXR 1.2 with consolidation of hand/body tracking, expanded haptics, spatial entities and multi-app 3D composition; runtimes shipping those is not yet something to rely on [V S4].
- OpenVR (Valve's predecessor API) is still maintained and is the driver-side API for SteamVR hardware; Valve documents OpenXR for new engine integrations [R S64].

### 1.2 Runtime and standard inventory

| Name | Vendor | OpenXR? | Platforms | Licence | Local/cloud | Source |
|---|---|---|---|---|---|---|
| OpenXR 1.1.65 spec, SDK, loader | Khronos | is the standard (1.0 in 2019, 1.1 in 2024) | loader for Windows, Linux, Android; no runtime on macOS | spec CC-BY-4.0; SDK/loader Apache-2.0 | local | [S2], [S70] |
| SteamVR OpenXR runtime (all SteamVR headsets; Steam Frame) | Valve | Yes - conformant 1.0 only (2021-02-25) | Windows, Linux; Steam Frame adds a standalone SteamOS device fed by a PC stream | proprietary, free | local | [S1], [S60] |
| Meta Horizon OS OpenXR runtime (Quest 2, 3, 3S, Pro) | Meta | Yes - Quest 3 / 3S conformant 1.0 and 1.1 (2026-01-18); Quest 2 / Pro 1.0 | Quest headsets (Android-based, standalone) | proprietary | local (device) | [S1], [S8] |
| Meta PC OpenXR runtime (Quest Link, Air Link) | Meta | Yes - 1.0 (2020-08-21) | Windows | proprietary | local (USB or Wi-Fi stream from the PC) | [S1] |
| Monado | Collabora | Yes - 1.0 (simulation device, 2021-02-27) | Linux, Windows, Android, embedded | open source; Apache-2.0 per project documentation (not re-fetched today) | local | [S1], [S71] |
| PICO runtime (PICO 4 Ultra, Neo 3, Project Swan) and PICO PC Runtime | ByteDance | Yes - PICO 4 Ultra 1.1 (2024-11-18); PC Runtime 1.1 (2026-08-01); Project Swan 1.0 + 1.1 (2026-04-10) | PICO headsets (Android); Windows | proprietary | local | [S1], [S3] |
| Android XR (Samsung Galaxy XR; XREAL Aura) | Google with Samsung and XREAL | Yes - 1.0 and 1.1 (2026-09-12) | Android XR headsets and wired glasses | proprietary OS with a preinstalled runtime | local device; the built-in Gemini assistant is a Google service | [S1], [S53], [S54] |
| Apple visionOS | Apple | **No OpenXR runtime** (no entry on Khronos' list). Own APIs: RealityKit, ARKit, CompositorServices, SwiftUI | Apple Vision Pro | proprietary | local device; building an app needs a Mac and Xcode | [S1], [S28], [S32] |
| NVIDIA CloudXR Runtime + Apple Foveated Streaming | NVIDIA, Apple | CloudXR runtime conformant 1.0 and 1.1 (2025-06-18, streaming to Apple Vision Pro) | Windows and Linux server; visionOS 26.4+ client | proprietary, free download | local endpoint or cloud | [S1], [S19], [S22] |
| WebXR Device API | W3C Immersive Web Working Group | uses OpenXR underneath in Chromium | browsers (matrix in 1.6) | W3C Candidate Recommendation Draft of 2026-11-09 | local | [S33], [S35] |
| Windows Mixed Reality (PC) and HoloLens 2 | Microsoft | Yes - 1.0 (2020). Retired | Windows (removed in 11 24H2); HoloLens 2 | proprietary | local | [S1], [S63] |
| Magic Leap 2 | Magic Leap | Yes - 1.0 (2022-12-31) | Magic Leap 2 | proprietary | local | [S1], [S3] |
| OpenVR | Valve | No (predecessor API, maintained) | Windows, Linux | SDK BSD-3-Clause (not re-verified) | local | [R S64] |
| VRChat OSC and OSCQuery | VRChat; OSC from CCRMA Stanford; OSCQuery proposal from Vidvox | not applicable (application protocol over UDP) | VRChat on PC, Android, iOS | VRChat proprietary and free; `vrc-oscquery-lib` MIT; OSC is a royalty-free specification | local LAN (VRChat itself is an online service) | [S44], [S45], [S46] |
| VMC Protocol | maintained by the EVMC4U author | not applicable (OSC over UDP, ports 39539 and 39540) | Windows, macOS, Linux, iOS | MIT | local | [S50] |
| SolarXR (SlimeVR) | SlimeVR | not applicable (FlatBuffers over UDP) | Windows, macOS, Linux, Android | dual MIT / Apache-2.0 | local | [S48] |
| XRoboToolkit (headset app, PC service, ROS bridge) | XR-Robotics, PICO | headset app built on OpenXR | PICO 4 Ultra, Quest; PC (Windows, Linux); ROS 1 and ROS 2 | Apache-2.0 (PC service), MIT (Quest client, ROS bridge) | local (USB `adb reverse` or Wi-Fi) | [S51] |
| Lab Streaming Layer (LSL) | SCCN | not applicable | Windows, macOS, Linux | permissive; GitHub reports NOASSERTION for the licence file - check before vendoring | local | [M S70] |
| XR Blocks | Google | through WebXR | the web (Android XR, Quest browser) | Apache-2.0 | LLM queries go to whatever endpoint is configured | [S65] |

### 1.3 Conformance: who passed what

From Khronos' conformant-products list, read today [V S1]:

- **Passed 1.1**: Meta Quest 3 and 3S (2026-01-18); Google Android XR (2026-09-12); ByteDance PICO 4 Ultra (2024-11-18), PICO PC Runtime (2026-08-01), Project Swan (2026-04-10); NVIDIA CloudXR runtime for Apple Vision Pro (2025-06-18).
- **1.0 only**: SteamVR (2021-02-25); Monado simulation device (2021-02-27); HoloLens 2 and Windows Mixed Reality (2020); Magic Leap 2 (2022-12-31); Meta Quest 2 and Pro (2023-10-19); Varjo, HTC, Canon, Acer; Sony ELF-SR devices (2026-10-30).
- **No entry**: Apple.
- Khronos' 2026 BOF states that all major game engines support 1.1 as well as 1.0 [V S4].

Consequence for EHC: enumerate extensions at run time and never assume a 1.1 core feature. The same advice appears in independent write-ups [R S64].

### 1.4 Extension landscape

The 1.1.65 specification page contains about 374 distinct `XR_<VENDOR>_<name>` strings. By vendor token: EXT 71, META 54, ANDROID 53, FB 41, BD 37, KHR 36, ML 19, MSFT 15, HTC 10, VARJO 8, SONY 4, QCOM 4, OCULUS 4 [M - regex over the registry page, approximate]. The Khronos OpenXR-Inventory holds per-runtime extension lists for 29 runtimes [M S3]. The "advertised by" column below was read from those files today [V S3].

| Extension | Vendor | What EHC would use it for | Runtimes advertising it (inventory files checked) |
|---|---|---|---|
| `XR_EXT_eye_gaze_interaction` | EXT (Tobii, Microsoft, Oculus, Varjo, Magic Leap) | one combined gaze pose for interaction. The spec defines what a runtime with a permission system must do before access is granted (3.2) | SteamVR Windows and Linux, Steam Frame, Quest Pro, PICO 4 Ultra, Project Swan, Android XR, Magic Leap 2, HoloLens 2. **Not** Quest 3, Monado (Windows and Linux files), Meta PC |
| `XR_FB_eye_tracking_social` | Meta | per-eye gaze for avatars; confidence value is fixed at 0.5 | Quest Pro, Meta PC developer-mode file |
| `XR_EXT_hand_tracking` | EXT | 26-joint hand skeletons | every file checked, including Monado; on SteamVR the data is inferred from controllers, not cameras [V S52] |
| `XR_EXT_hand_interaction`, `XR_FB_hand_tracking_aim`, `XR_EXT_palm_pose` | EXT, FB, EXT | pinch-to-select as a standard action, an aim ray, a palm pose | hand interaction: Android XR, Quest 3 and Pro, SteamVR and Steam Frame, PICO, Magic Leap 2, HoloLens 2. Aim ray: Android XR, Quest 3 and Pro, PICO, Meta PC developer-mode file. Palm pose: in the registry, per-runtime not checked |
| `XR_META_hand_tracking_microgestures`, `XR_META_hand_tracking_wide_motion_mode` | Meta | small gestures; plausible hands when they leave the cameras' view | Quest 3 and Pro (listed as `..._wide_motion_mode2`), Meta PC developer-mode file (microgestures) |
| `XR_EXT_hand_tracking_data_source` | EXT | tells whether hand data is optical or inferred from a controller | SteamVR and Steam Frame, Quest 3 and Pro, Meta PC developer-mode file |
| `XR_FB_body_tracking`, `XR_META_body_tracking_full_body`, `XR_BD_body_tracking` | Meta, ByteDance | upper-body and full-body joints. No multi-vendor EXT exists for body tracking | Quest 3 and Pro and the Meta PC developer-mode file (FB and META); PICO 4 Ultra and Project Swan (`XR_BD_body_tracking`) |
| `XR_FB_face_tracking`, `XR_FB_face_tracking2`, `XR_META_face_tracking_visemes`, `XR_HTC_facial_tracking`, `XR_ANDROID_face_tracking` | Meta, HTC, Google | blendshapes and visemes. No multi-vendor EXT exists for face tracking | listed for Quest 3 and Pro, Android XR. Which devices really deliver it is unresolved here [?] |
| `XR_FB_passthrough`, `XR_META_passthrough_color_lut`, `XR_HTC_passthrough`, `XR_ANDROID_passthrough_camera_state` | Meta, HTC, Google | camera passthrough layers. The portable route is the core alpha-blend environment mode | Quest 3 and Pro, PICO 4 Ultra, Project Swan, Meta PC developer-mode file (`XR_FB_passthrough`); Android XR lists the camera-state extension only |
| `XR_EXT_spatial_anchor`, `XR_EXT_spatial_plane_tracking`, `XR_EXT_plane_detection`, `XR_FB_spatial_entity`, `XR_EXT_spatial_entity`, `XR_EXT_spatial_container` | EXT, FB | anchors and planes for AR overlays | anchors and planes: Android XR, PICO 4 Ultra, Project Swan, Quest 3 and Pro, Meta PC developer-mode file. Plane detection: Magic Leap 2. Spatial-entity extensions: in the registry, per-runtime not checked. HoloLens 2 has MSFT anchors with persistence |
| `XR_META_environment_depth`, `XR_KHR_composition_layer_depth` | Meta, KHR | real objects occluding virtual content | `XR_META_environment_depth`: Quest 3 and Pro, Project Swan. `XR_KHR_composition_layer_depth`: in most files checked |
| `XR_EXT_user_presence` | EXT | "the headset is being worn" | SteamVR and Steam Frame, Quest 3, Android XR, PICO 4 Ultra |
| `XR_EXTX_overlay` | EXT | utility overlay applications | PICO 4 Ultra only, among the files checked |
| `XR_KHR_convert_timespec_time`, `XR_KHR_win32_convert_performance_counter_time` | KHR | map OpenXR time onto system clocks (feeds `t` in `Observation`) | per runtime not checked |

Not in the Khronos registry page: `XR_HTCX_vive_face_tracking`, `XR_HTCX_vive_eye_tracker`, `XR_HTCX_vive_hand_tracking`, `XR_HTCX_vive_body_tracking` [M]. If those names are in use they are vendor extensions outside the registry.

### 1.5 Platform status, 2026-11

**Apple visionOS - confirmed: no OpenXR, only Apple's own APIs.**
- Apple has no entry on the conformant list [V S1] and exposes RealityKit, ARKit, CompositorServices and SwiftUI scenes instead [V S28]. Unity needs PolySpatial for immersive visionOS apps; Godot gained CompositorServices support at WWDC26 [V S28][V S32].
- **Foveated Streaming (visionOS 26.4+)** is the new bridge in: a visionOS app connects to a local or cloud endpoint and shows streamed OpenXR content in an Immersive Space. "visionOS automatically sends input data, like hands, controller positions, and microphone" to the endpoint, and a bidirectional message channel carries custom data [V S20]. The endpoint runs NVIDIA CloudXR, "an OpenXR-compliant runtime for Windows and Linux servers" [V S22].
- Limits that matter here: eye-tracking data is used only to optimise encoding and "the CloudXR Runtime does not expose user's focus region to the OpenXR application" [V S22]; the session needs the `com.apple.developer.foveated-streaming-session` entitlement and cannot run in the Simulator [V S19]; "User input is unsupported for targets beyond 4 meters" is a listed known issue [V S21].
- Raw gaze is never handed to apps. System look-and-pinch is the interaction; accessibility offers Dwell Control, Switch Control, Pointer Control, Voice Control and Head Pointer (3.2).

**Android XR (Google, Samsung, 2025-2026) - shipping, SDK still maturing.**
- Samsung Galaxy XR went on sale 2025-10-21 in the US and Korea, and 2026-07-08 in the UK [V S54]; $1,799.99 as reported [R S55]. XREAL Aura, wired glasses with a compute puck, ships from mid-November 2026 from $1,279 [V S55].
- SDK: Developer Preview 4 (2026-05-19); the Jetpack XR core libraries (SceneCore, ARCore for Jetpack XR, XR Runtime) reached beta on 2026-08-18 [V S53].
- Engines: Unity 6, Unreal, Godot 4.6.2+ (official since 2026-05-19, with the Godot Foundation and W4 Games), OpenXR, and WebXR in Chrome 129+ [V S53][V S39].
- The runtime advertises `XR_EXT_eye_gaze_interaction` and `XR_ANDROID_face_tracking` [V S3]; whether eye-tracking access needs a sensitive permission is unresolved here [?].

**Meta Quest (Horizon OS)** - Quest 3 and 3S are conformant to 1.1 [V S1]. Quest 3 and 3S have no eye-tracking hardware [V S8]. Quest 2 and Pro left feature development on 2026-11-02, with security updates to December 2027 [R S69]. Meta VR Glasses (built-in eye tracking, eyes and hands as primary input [V S9]; $1,299.99 [V S10]) go on sale in spring 2027 [V S10][R S73].

**Valve Steam Frame** - standalone SteamOS headset that also streams from a PC over a 6 GHz dongle; Snapdragon 8 Gen 3, 2160x2160 LCD per eye, 72-144 Hz (144 experimental), eye tracking, monochrome passthrough [V S60][R S60]. Launched 2026-09-18 at $1,059 for 256 GB [R S60]. Eye tracking is exposed through `XR_EXT_eye_gaze_interaction`; SteamVR has advertised that extension since 2.8.3 [V S60][V S61]. Developer Mode is how apps are deployed to it [V S60]. Whether it does camera-based hand tracking is unresolved [?].

**HoloLens 2** - production ended (confirmed October 2024; "no longer manufactured" as of December 2024); November 2024 was the final feature release; security updates run to December 2027; Dynamics 365 Guides and Remote Assist stop working after 2026-12-31 [V S63][R S63]. Windows Mixed Reality for PC was removed in Windows 11 24H2, with support for existing devices through November 2026 on 23H2 [V S63]. **Magic Leap 2** is conformant to 1.0 [V S1]; third parties report it discontinued [R S63] [?].

### 1.6 WebXR: where immersive sessions actually work (2026-11)

Chromium talks to headsets on Windows only through an OpenXR runtime that implements `XR_EXT_win32_appcontainer_compatible` (so the runtime works inside Chrome's sandbox); SteamVR 1.16.8+, the Oculus runtime v19+ and Windows Mixed Reality 1903+ qualify [V S39]. Chromium's own platform table: OpenXR on Windows - VR yes, AR no; on Android - enabled by default on Android XR devices, disabled on general Android; macOS has no OpenXR support [V S35]. On Linux the OpenXR backend landed in 2026 behind `--enable-features=OpenXR` (M157 end-to-end, M158 Layers, M159 WiVRn sandbox) [V S37].

| Browser | `immersive-vr` | `immersive-ar` | Input | Notes |
|---|---|---|---|---|
| Meta Quest Browser | yes | yes (passthrough) | hands, controllers | Web Launch sends a URL from a phone or desktop to the headset [V S56] |
| Chrome on Android XR (129+) | yes | yes | hands by default | AR Module, hit-test, anchors, depth sensing, light estimation [V S39][R S56] |
| Chrome on Android phones (81+) | no headset target | yes (ARCore) | touch, ray | [V S39] |
| Chrome and Edge on Windows + OpenXR runtime | yes | **no** | controllers | runtime must implement the appcontainer extension [V S35][V S39] |
| Chromium on Linux | flag only | no | - | [V S37] |
| Safari on visionOS 2+ | yes | **no** | `transient-pointer` (look and pinch); hand tracking behind a permission prompt, both since Safari 18 for visionOS 2 [V S30] | an Apple engineer confirmed no `immersive-ar` (June 2026) [V S31]; a developer reports the AR feature flag was removed in visionOS 27 [R S31] |
| Safari on iPhone and iPad | no | no | - | AR Quick Look (USDZ) only; no WebXR through iOS 27.2 [R S56] |
| Firefox | no | no | - | [R S56] |
| **Electron 42.11.18** | **no** | **no** | - | API present, no device (2.1) [M] |

### 1.7 Application protocols that reach a headset without OpenXR

| Protocol | Transport | What it carries | Ports and discovery | Licence |
|---|---|---|---|---|
| OSC 1.0 | UDP, big-endian, 4-byte aligned | address + int, float, bool, string | any; no handshake, no delivery guarantee, no authentication | royalty-free specification [S44] |
| VRChat OSC | OSC over UDP | in: `/input/*` buttons and axes, `/avatar/parameters/<name>`, `/chatbox/input`, `/tracking/trackers/*`; out: `/avatar/change`, `/avatar/parameters/*`, `/tracking/vrsystem/*` | UDP 9000 into VRChat, UDP 9001 out of it; `--osc=inPort:outIP:outPort` on PC | VRChat app proprietary, free [S44], [S45] |
| OSCQuery | HTTP/1.1 over TCP + mDNS (`_oscjson._tcp`, `_osc._udp`) | discovery and a JSON tree of an OSC address space with values and access rights | VRChat since 2023.3.1 | proposal is open; `vrc-oscquery-lib` MIT [S46] |
| VMC Protocol | OSC over UDP | VRM bones, blendshapes, device and tracker poses; optional camera, light, keyboard, MIDI, calibration and gaze control | 39539 (receiver), 39540 (sender); version 3.1 | MIT [S50] |
| SolarXR | FlatBuffers over UDP | IMU tracker rotations, the SlimeVR device protocol | 6969/udp and others | dual MIT / Apache-2.0 [S48] |
| XRoboToolkit link | TCP over USB (`adb reverse`) or Wi-Fi | head, controller, hand and motion-tracker poses; stereo video to the headset | `adb reverse :63901` is one documented setup | Apache-2.0 / MIT [S51] |
| WebSocket | TCP | whatever EHC defines | EHC's own port | - |

## 2. How a desktop app reaches a headset

### 2.1 (a) WebXR in Electron: does stock Electron support it? No - measured

**The build-flag chain [V].** Electron's `DEPS` on branch `42-x-y` (Chromium `148.0.7778.280`, Node `v24.19.0`) contains `'checkout_openxr': False,`. The same line is on `43-x-y` (Chromium `150.0.7871.250`) and on `main` (Chromium `160.0.8181.0`) [M - fetched from `github.com/electron/electron` [S40]]. Chromium's `device/vr/buildflags/buildflags.gni` reads [V S36]:

```
enable_openxr =
    checkout_openxr &&
    (is_win || is_linux || (_is_xr_supported_android && (...)))
enable_vr =
    enable_openxr || enable_cardboard || enable_arcore || (is_linux && ...)
```

so with `checkout_openxr` false there is no OpenXR backend on Windows, and `enable_vr` is false there too (cardboard and ARCore are Android-only). Electron's `BUILD.gn` and `patches/config.json` on `42-x-y` contain no override for `openxr`, `webxr` or `enable_vr` [M]. A 2021 attempt to enable it needed an Electron rebuild from source plus directory ACL changes [R S42]; the open Electron issues are #35011 "[Bug]: WebXR API not working" (2022-07-21) and #21446 "WebXR Support" (2019, closed) [M S70][S41]. Answers on Stack Overflow have described the same symptom since 2020: `navigator.xr` present, sessions failing [R S43].

**Binary scan [M].** Search for OpenXR loader strings in the installed binaries, with the system Edge builds as positive controls:

| Binary | Size | `xrCreateInstance` | `xrGetInstanceProcAddr` | `XR_EXT_win32_appcontainer_compatible` | `immersive-vr` |
|---|---|---|---|---|---|
| `electron.exe` 42.11.18 (this project's `node_modules`) | 224.5 MB | 0 | 0 | 0 | 1 |
| `msedge.dll` 158.0.4370.45 | 367.9 MB | 2 | 2 | 1 | 1 |
| `msedge.dll` 157.0.4341.60 | 341.6 MB | 2 | 2 | 1 | 1 |

The other eight `.exe`/`.dll` files in Electron's `dist` folder contain none of these strings. The WebXR API strings are compiled into Electron; the OpenXR loader is not.

**Runtime probe [M].** A throwaway script run with that `electron.exe` (hidden window, page loaded from `file://`, exit after the answer; run from the temp folder and deleted afterwards):

```json
{ "ua": "Chrome/148.0.7778.280 Electron/42.11.18",
  "secure": true, "hasNavigatorXR": true,
  "isSessionSupported": { "inline": true, "immersive-vr": false, "immersive-ar": false } }
```

Identical with `--enable-features=OpenXR,WebXRIncubations` and `--force-webxr-runtime=openxr` appended. The machine's registered active OpenXR runtime is SteamVR (`HKLM\SOFTWARE\Khronos\OpenXR\1`, with a Pimax runtime also installed), so the answer was not "no runtime". No SteamVR process was started by the probe and no Electron process was left behind.

Two honest caveats. (1) No headset was attached during the probe, so the `false` on its own is not conclusive; the build flags and the binary scan are the decisive evidence, and the probe corroborates them. (2) A first attempt on `about:blank` reported `isSecureContext: false` and no `navigator.xr` at all, and was discarded: `navigator.xr` is exposed only in secure contexts. That second point is a real trap for the bridge - a page served over plain `http://` on a LAN address is not a secure context and loses WebXR (2.3).

**Runtime requirements, in Chromium's terms [V S35][V S39]:** Windows, an OpenXR runtime with the appcontainer extension, no AR; `--no-sandbox` is the only way to use a runtime without it, which disables Chrome's security measures and is not an option for EHC. Chromium no longer carries per-device WebXR flags: what remains is the WebXR Incubations switch and a runtime override, and its OpenVR route was removed [V S38]. A 2026 Chromium feature request states the same limit from a developer's side: passthrough AR on Windows currently needs "an Electron renderer plus a native D3D11/OpenXR viewer" [R S74].

**What it would take to change this:** build Electron from source with `checkout_openxr` flipped, and repeat that for every Electron upgrade. Even then the result is Chromium-on-Windows WebXR: VR only, PC-rendered, with the headset tethered or streamed. Not worth it when the alternatives below need nothing installed.

### 2.2 (b) Native Node bindings for OpenXR: none are mature

| Candidate | What it is | State today | Verdict |
|---|---|---|---|
| `node-xr/node-openxr` | Node bindings for OpenXR | MIT, 3 stars, last push 2019-06-23 ("Added disclaimer to repository"); no npm package named `node-openxr` [M S70] | dead |
| `@pmndrs/xr` 6.6.32 and `@react-three/xr` 6.6.32 | WebXR for three.js and React Three Fiber, **in the browser** - not a Node binding to OpenXR | active (last publish 2026-10 and 2026-11); about 80k weekly downloads; npm licence field is "SEE LICENSE IN LICENSE" (not confirmed MIT here) [M S70][R S59] | useful for the WebXR page only |
| Rust `openxr` crate behind `bevy_mod_openxr` 0.6.0 | the maintained way to call OpenXR from Rust | MIT / Apache-2.0, released 2026-06 [M S70] | a route to a native **sidecar** via napi-rs, if one is ever needed |

Why a native addon is the wrong first move, beyond the missing bindings:

- An OpenXR application owns a session and a frame loop; "input only" is not a defined use. The nearest fit, `XR_EXTX_overlay`, is advertised only by PICO 4 Ultra among the inventory files checked [V S3]. Whether SteamVR tolerates a session that never submits a frame is untested [?].
- A native module inside Electron is against the rule EHC already set for itself ("No native serial/USB module inside the Electron app", `docs/SENSORS.md` section 2). It would have to be a separate process, at which point the protocol matters more than the language.

### 2.3 (c) The bridge pattern: a companion on or near the headset, talking to the desktop

```
headset (standalone)                                      EHC runtime (loopback, on the PC)
Quest or Android XR browser: WebXR page  -- WebSocket --> sensor bus -> watches, agent tools (permission `ask`)
  head pose, pinch, hands, microphone   -> obs           approvals.ts, agent run state
  panels, chat tail, approval card      <- project
VRChat (store app)  -- OSC 9000 in / 9001 out, OSCQuery --> TypeScript OSC module (UDP)
optional Godot companion (phase 2)  -- same WebSocket, OSC or VMC
PC VR only: Edge or Chrome with the same page -> SteamVR or Meta Link runtime -> headset (the PC renders)
```

Three message families are enough: `obs` (headset to EHC, an `Observation` in its envelope), `project` (EHC to headset, typed state), `ctl` (both ways: hello, capabilities, consent, ping). Nothing else crosses the wire.

Four shapes, cheapest first:

1. **Zero-install WebXR page.** EHC's server serves one page; the headset's own browser opens it; the page opens a WebSocket back to EHC. No app, no sideload, no engine. The page runs inside the browser's OpenXR session, so the headset's SoC does the rendering and the PC only ships data.
   - *Loopback variant:* `adb reverse tcp:<port> tcp:<port>` over USB makes the PC's `127.0.0.1` reachable from the headset, so the page URL is `http://localhost:<port>`, which Chromium is expected to treat as a secure context because it is loopback (confirmed in Phase 0, item 2) [?], and EHC's server never listens on the LAN. XRoboToolkit uses the same trick (`adb reverse`) [V S51]. Developer Mode is needed only for ADB.
   - *LAN variant:* no cable, but EHC must listen beyond loopback, which is a security decision (9.2).
   - To test on day one [?]: that the Quest Browser treats `http://localhost` as secure for `requestSession`, and that ADB over Wi-Fi keeps `adb reverse` working.
2. **VRChat OSC.** VRChat is a store app - no Developer Mode at all for the send direction. EHC speaks OSC from TypeScript: `node-osc` 11.7.1 (Apache-2.0), `osc-js` 2.4.1 (MIT), `node-oscquery` (MIT, discovery only) [M S70][S45].
   - *PC to headset* is documented and used today: SlimeVR's server on a laptop sends tracker data to a standalone Quest's IP on port 9000 [V S48].
   - *Headset to PC* is the uncertain half. VRChat's wiki says an app that advertises `/avatar` or `/tracking/vrsystem` over OSCQuery will receive those messages, and that VRChat on Android "can serve information ... to OSCQuery applications running anywhere else on the network" [V S45]. Third-party tools report it failing without multicast [R S49], and one 2026 companion app relays through an on-headset panel because "VRChat on a Quest only ever sends OSC to 127.0.0.1" [R S47]. Sending head and wrist tracking also requires the user to accept a legal notice in VRChat [V S44]. This needs a 30-minute test (8.0, item 4).
   - *Limits:* the chatbox holds 144 characters and 9 lines [V S44]; avatar parameters exist only if the avatar defines them; OSC has no authentication (9.2).
3. **Own companion app** (Godot, section 6) when the browser is not enough: raw hand joints at full rate, eye-gaze events on devices that have them, passthrough AR, a background service.
4. **Precedent from robotics - XRoboToolkit.** A Unity app on PICO 4 Ultra or Quest, a PC service, and ROS 1 and ROS 2 packages publishing head and controller poses as `xr_msgs/Custom` [V S51]; one guide puts the pose topics at 90 Hz [R S51]. The headset panel has a toggle per stream (head, controller, hand, motion trackers), a master "Send" toggle, and "Switch w/ A Button" to pause or resume sync from the controller [V S51]. A third-party guide describes the browser (WebXR) mode as "easy, higher latency" and the native app as "lower latency, recommended for production" [R S51]. For EHC's robot lane this is an `ehc_bridge` subscription, not something to rebuild.

Other bridges worth knowing, not to build on: WiVRn-QPro-OSC streams Quest Pro face, eye and pupil tracking to VRChat over OSC from a WiVRn fork [R S76]; `frameeyeosc` and the Pimax eye-tracker shim feed Steam Frame and Pimax eye trackers into `XR_EXT_eye_gaze_interaction` and onward to OSC [V S61][R S61].

**"TUST" [?]:** no XR, OSC or VR project by that name was found. The name is probably a transcription slip; candidates seen during this research are VRCFaceTracking, TMARelay (VMC to VRChat OSC), VMT and OpenTrack. Nothing in this memo depends on it.

### 2.4 (d) Remote-desktop style: a virtual monitor, not a control surface

Immersed, Meta Quest Remote Desktop, Fluid (Quest-only) and the Windows 11 Remote Desktop feature in Horizon OS all show a PC's screen inside the headset [R S68]. Immersed reports 1.6 million users and an "AI assistant" called Curator [R S68 - self-reported]. Horizon Workrooms was discontinued on 2026-02-16 and its data deleted; Meta points users to Quest Remote Desktop and third-party meeting apps [V S18]. Microsoft Mesh was retired 2025-12-01 [R S68].

For EHC this is the zero-effort way to *see* the workbench in XR - the Electron window appears as a monitor - and for someone who must lie down or cannot sit at a desk that is an accessibility gain by itself. It adds nothing to the agent loop: no observations beyond keyboard and mouse, no presence, no approvals. Out of scope.

### 2.5 Comparison and ranking for a local-first desktop harness in 2026

| Rank | Bridge | EHC ships | Headset side | Transport | Dev mode or sideload | Input EHC can get | Output to the user | PC GPU load | Feasibility |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Zero-install WebXR page (2.3.1) | TypeScript page (three.js, MIT) + loopback WebSocket | stock browser: Quest Browser, Chrome on Android XR, Safari on visionOS (VR only) | WebSocket over `adb reverse` (loopback) or LAN opt-in | Developer Mode only for the ADB variant | head pose, pinch and select, hand joints (WebXR hand input), gamepad, microphone audio | text panels, images, controller haptics | none (standalone) | **High** - core path |
| 2 | VRChat OSC / OSCQuery (2.3.2) | TypeScript OSC + OSCQuery module, address profiles | VRChat (store app) | UDP 9000/9001, OSCQuery | none | avatar parameters out (LAN path to verify), head and wrist poses after a legal notice, `/input/*` buttons | chatbox (144 characters), avatar parameters, input axes and buttons | none | **High** for output, **medium** for input; zero-cost proof |
| 3 | PC VR through the system browser | the same page, launched in Edge or Chrome app mode | any OpenXR PC headset through SteamVR, Meta Link, PICO or Monado | loopback WebSocket | none (the runtime is the user's) | controllers, head pose; hands only controller-inferred on SteamVR; no eye gaze in WebXR | full VR scene | **high** (render, compositor, encode) | **Medium-high** where a GPU is free; SteamVR is the active runtime on the reference machine [M] |
| 4 | Minimal companion app, Godot (2.3.3, section 6) | MIT app in its own repository | Quest, Android XR, PICO, PC VR, visionOS (early) | WebSocket, OSC, VMC | Developer Mode or store | hand joints, eye-gaze events where present, body (vendor extensions), controllers, microphone | native panels, passthrough, haptics | none (standalone) | **Medium** - phase 2, only where rank 1 is not enough |
| 5 | ROS 2 through XRoboToolkit (robot lane) | `ehc_bridge` subscription | PICO 4 Ultra, Quest | `adb reverse` or Wi-Fi to a PC service, then ROS 2 | app install | head, controllers, hands, motion trackers | stereo video to the headset | low | **Medium** for the robot lane; adopt, do not rebuild |
| 6 | OpenXR overlay or SteamVR driver on the PC | native sidecar executable | PC VR | local IPC | none (the user runs SteamVR) | every tracked device while a SteamVR session runs | overlay | low to medium | **Low-medium** - native code; overlay extension not advertised by SteamVR or Meta |
| 7 | CloudXR + Foveated Streaming (Vision Pro) | PC OpenXR application on the CloudXR runtime + a Swift client | Apple Vision Pro | Wi-Fi (system discovery, local or remote) | entitlement, Mac, Xcode, NVIDIA GPU | hand and controller positions, microphone; never eye data | streamed immersive video | high | **Low-medium** - experimental; the reference machine has no NVIDIA GPU (`docs/GPU.md`) |
| 8 | Native Node OpenXR addon (2.2) | native module or sidecar | PC VR | - | - | all | none | low | **Low** - no maintained bindings |
| 9 | Custom Electron build with OpenXR (2.1) | a forked Electron | PC VR | in process | none | WebXR subset | full VR | high | **Low** - a fork per release, VR only |
| - | Remote desktop (2.4) | nothing | Quest, Vision Pro | vendor stream | none | keyboard, mouse | EHC as a monitor | encode | display: high; control: none |

Ranking logic: 1 and 2 need nothing installed on the headset, keep the render loop off the PC, and are TypeScript in the MIT core. 3 reuses the same page but costs GPU on a machine whose GPU is already budgeted (`docs/GPU.md`). Everything below 5 is native code or a vendor dependency for a capability the top paths already cover.

## 3. Input as accessibility

### 3.1 What each input can and cannot do

The field's own assessment is blunt: a CHI 2026 interview study with 25 XR practitioners found that current guidelines "systemically fail to address XR's unique technical requirements", and that practitioners want platform-integrated tools, Unity-compatible packages and OpenXR integration rather than documents [V S66]. EHC cannot fix the platforms; it can make its own XR surface operable by every input below.

| Input | Where it works | API | Limits, with evidence | Rate class | Permission on the device |
|---|---|---|---|---|---|
| Head pose | every runtime, every WebXR browser | OpenXR view and reference spaces; WebXR viewer pose | needs a neck movement; the fallback when nothing else exists. Meta lists head gaze as a first-class modality [V S15] | 72-144 Hz | none |
| Eye-gaze dwell | SteamVR, Steam Frame, Quest Pro, PICO 4 Ultra, Android XR, Magic Leap 2, HoloLens 2 | `XR_EXT_eye_gaze_interaction` | absent on Quest 3 and 3S (no hardware) [V S8]; never exposed on visionOS; not exposed through CloudXR [V S22]; not in WebXR (visionOS offers `transient-pointer` instead) [V S30] | event | Meta: `com.oculus.permission.EYE_TRACKING`, a "dangerous" runtime permission [V S7]. Spec: a runtime with a permission system must invalidate the pose until access is allowed, and applications that store or transfer eye data should "always ask the user for active and specific acceptance" [V S5] |
| Bare hands | Quest (the system itself uses them for Direct Touch: tap, scroll, type on a virtual keyboard [V S14]), Android XR, PICO, Magic Leap 2, visionOS; SteamVR only inferred from controllers [V S52] | `XR_EXT_hand_tracking`, `XR_EXT_hand_interaction`, `XR_FB_hand_tracking_aim`, `XR_EXT_palm_pose`; WebXR hand input | Meta: hand tracking "is not intended to replace controllers in all scenarios, especially with games or creative tools that require a high degree of precision"; "For users with limited hand mobility, alternative input methods or adaptive controllers should be provided" [V S15]. Hands leaving the cameras' view are covered on Quest by Wide Motion Mode [V S15] | event; joints 30-120 Hz | WebXR in Safari on visionOS asks for hand-tracking permission [V S30] |
| Voice | everywhere; system or EHC's own | device voice control, or microphone audio to EHC | Meta Voice Control (Horizon OS 2.10): "hands-free navigation and interaction with 2D panels using only voice commands and head movements", enabled under Accessibility [V S12]. visionOS: Voice Control and Sound Actions [V S23] | utterance | microphone |
| Switch | through HID, gamepad or VRChat `/input/*` buttons | EHC's planned switch source (`docs/SENSORS-ACCESSIBILITY.md` section 4.1); WebXR gamepad | XAUR: a single switch plus scanning should let a user navigate and interact in XR [V S34]. visionOS has Switch Control [V S23]. Meta lists "switch device compatibility" among its accessibility features; its scope on Quest is unverified [R S11] [?] | below 10 Hz | none |
| Haptics (output) | controllers, some hands | OpenXR `xrApplyHaptics`; WebXR `GamepadHapticActuator` | not on visionOS for third-party apps [?] | pulse | none |
| Screen-based eye tracker (Tobii) | no headset needed | Tobii Stream Engine 7.2 (C, C#, Unity) | the Eye Tracker 5 "without the L is a pure gaming device and cannot be used for development purposes"; the SDK needs a development licence [V S62] | 120 Hz class [?] | desktop |

Two facts to design around:

- **Eye data is low-confidence by design.** Meta's interaction gaze is one combined pose; the per-eye "social" gaze is temporally smoothed and its confidence value is fixed at 0.5 [V S6]. Gaze can name a target; it should never be the only evidence that a target was meant.
- **The platforms' own screen readers assume controllers.** Quest's screen reader is experimental and "Navigating with a screen reader requires you to be using Touch controllers" [V S13]. Anyone who cannot hold controllers is outside the built-in assistive technology on Quest today - which is the gap EHC's own XR surface can fill if it is scan-operable from day one.

### 3.2 Gaze and dwell, precisely

- **visionOS does the accessible version itself, and it is a good reference design.** Dwell Control offers "Long Look to Tap" with adjustable activation time, movement tolerance and a highlight outline on the control that will fire, and "Glance Up to Tap" with a confirmation circle [V S25]. visionOS 27 revisits it so a glance up at a marker confirms instantly [V S28]. Apple's developer guidance: give people "a way to access all of your app's behavior using only these interactions" (eyes only), add menu commands for every custom gesture so they can be entered from a keyboard or assistive device, and avoid head-anchored content because it fights head-driven assistive technology [V S24].
- **visionOS keeps adding eyes-only and switch-only routes.** visionOS 26 brought typing with Dwell Control and Switch Control through QuickPath, Live Captions, Braille Access and Live Recognition [V S26]. Announced for 2026: face gestures for taps, a new way to select with the eyes while using Dwell Control, and power-wheelchair control from Apple Vision Pro [V S27].
- **EHC's dwell rule** follows `docs/SENSORS-ACCESSIBILITY.md` section 2.2 unchanged: gaze presence never auto-triggers anything; a dwell completes into an **event** naming the target; per-user dwell time; a cancel affordance; nothing fires without a separate confirm (pinch, switch, voice word) unless the user has explicitly chosen dwell-only mode.
- **What crosses the wire:** `{ kind: "xr.eyegaze.dwell", payload: { target: "approve:<id>" } }` - never the gaze ray. Raw gaze is sensitive personal data; retention stays `none` and no gaze stream enters a prompt.

### 3.3 Mapping to EHC's `Observation` sources

The envelope is now concrete in `src/server/sensorBus.ts`: `Observation = { source, kind, t, seq, payload, ref? }`, and `pushObservation` stamps `t` as `Date.now()` and `seq` itself, so a source passes neither [M - file read on 2026-11-27; in flight and untracked at the time]. Two consequences for XR sources. First, `t` is the PC's wall clock when the bus received the message; a headset-side timestamp (OpenXR time maps onto system clocks through `XR_KHR_convert_timespec_time` and its Win32 sibling [V S2]) has to ride in `payload` until the clock-domain field that `docs/SENSORS-ACCESSIBILITY.md` section 2.1 asks for exists. Second, `kind` is a free string, so the namespaced kinds below need no change to the bus. An XR source registers with the class `bridge`, like the ROS 2 node.

| `kind` | Trigger | `payload` | Source examples | Core or premium |
|---|---|---|---|---|
| `xr.head.pose` | throttled summary, not raw poses | yaw and pitch bucket, "looking at panel X" | WebXR page, Godot companion | core |
| `xr.gaze.dwell` | head-gaze dwell completed | target id | WebXR page | core |
| `xr.eyegaze.dwell` | eye-gaze dwell completed | target id | Godot companion on a device with the extension | core (event only) |
| `xr.select` | pinch, trigger, tap, controller select | target id, which hand | WebXR page, VRChat `/input/*` | core |
| `xr.hand.pose` | joint positions | 26 joints per hand | companion app, WebXR hand input | premium |
| `xr.hand.microgesture` | thumb or finger gesture | gesture name | Quest through `XR_META_hand_tracking_microgestures` | premium |
| `xr.voice.transcript` | speech recognised | text, language, confidence | microphone to EHC's whisper.cpp lane | core |
| `switch.press` | single switch closed | which switch | HID, gamepad, VRChat `/input/*` button | core |
| `xr.presence` | headset put on or taken off | boolean | `XR_EXT_user_presence` where advertised | core |
| `xr.body.pose` | joint positions | joints | SlimeVR through SolarXR, Meta body tracking | premium |
| `xr.gaze.sample` | raw gaze | - | - | **not an Observation source**: never stored, never in a prompt |

Rules:

- **Observations are permission `ask` for the agent**, like `camera_look`: the agent may ask "what did the user select?" and the user approves; the agent can never open a sensor.
- **VRChat-sourced observations are untrusted input**, like web content (`docs/BROWSER.md`): OSC has no authentication and any host on the LAN can send to port 9000. They can drive the UI scan and the STOP; they are never approval authority on their own.
- **Rates differ by four orders of magnitude** (switches below 10 Hz, poses up to 144 Hz). Caps live in the bus, as the accessibility memo says, and pose streams are reduced to events on the headset side so the wire carries tens of messages a second at most - the bus's own bridge listener caps a connection at 20 lines a second.

**Transport.** The bus in flight already has the right shape for a local peripheral. `ensureBridgeListener()` opens a TCP listener on `127.0.0.1` with a random port and a random per-launch token, writes them owner-only to `~/.eventhorizon/sensors.json` for same-user sidecars, speaks JSON lines under the name `ehc-bridge/1`, and audits every open and close [M - `src/server/sensorBus.ts`]. The XR bridge should copy that model exactly - loopback, per-launch token, JSON lines, a rate cap, an audit entry per connection - with one difference: a browser page cannot open a raw TCP socket, so the WebXR page needs the same messages over a WebSocket, and the token has to reach the user as a short-lived pairing code shown by EHC rather than a file read on the headset. A native companion can speak `ehc-bridge/1` as it is.

### 3.4 Consent and approvals in XR

The gates do not change: ask, an armed toggle the model cannot set, a bounded duration, a stop independent of the model. What changes is how they are presented and triggered.

| Rule | Why | Source |
|---|---|---|
| Every approval card announces itself on three channels at once: visual card, spoken text (EHC's TTS already exists), one haptic pulse | a silent modal is invisible to a screen-reader user and to a gaze user looking elsewhere | `docs/SENSORS-ACCESSIBILITY.md` 2.3, 2.4 |
| No press-and-hold anywhere in the path; no dwell-only arming | tremor, fatigue and sip-puff breathing make holds unreliable; dwell alone is the Midas touch | same, 2.2 and 2.3 |
| Arming is a **sequence**: select "Arm", then confirm with a different modality than the one that selected it (for example pinch to select, a switch or a spoken word to confirm), inside a generous, configurable window | a single accidental pinch or a word from a television must not arm anything | same, 2.3 |
| STOP costs exactly one action from any state, and maps to a physical control if one exists: a gamepad button, a switch, the VRChat `/input/PanicButton` address, or a key on the PC keyboard | for a switch user the stop is the thing that must cost one press | same, 2.3; `docs/SENSORS.md` 3f |
| No timeouts on a consent card, or a user-set one (10-30 s is normal for scanning) | scanning a dialog is slower than typing | same, 2.3 |
| Cards are world-anchored at a user-chosen distance, never head-locked | head-anchored content fights head-driven assistive technology and adds vection | [V S24] |
| A decision names the approval id and is validated by the server against the same arguments as the desktop card | "the decision binds to those arguments" (`AGENTS.md`) must hold when the card is in a headset | `src/server/approvals.ts` |
| The XR surface receives **typed projection state, never model-authored markup** | frontier coding agents "still struggle with XR development tasks", especially those needing "continuous reasoning over embodied interactions and asynchronous XR runtime state" | [V S65] GenXR-Bench |

What the headset displays is therefore three small things, all generated by EHC's server: a status line (listening, thinking, waiting for approval, running, stopped), the tail of the conversation as plain text, and approval cards built from the same `ApprovalSummary { kind, title, detail }` the desktop shows.

### 3.5 Voice

EHC already has a local voice lane: press the microphone button to record, press again to transcribe, a 60-second cap, the transcript lands in the composer and "is never sent on its own" (`docs/SENSORY.md`). That model carries over unchanged and already avoids press-and-hold. In XR: the headset captures audio, posts it to `/api/sensory/transcribe`, the transcript appears as a card to confirm or edit. An utterance can select and confirm; it should not be the only factor for arming (3.4).

### 3.6 The desktop gaze lane, no headset needed

A Tobii screen tracker plus a small sidecar turns "look at the Approve button for a second" into `gaze.fixation` on the ordinary EHC window - the cheapest gaze input EHC can offer, and independent of any headset. It needs Tobii's developer licence for the 5L-class hardware [V S62]; it is an optional sidecar, never bundled. Webcam-based gaze was not evaluated [?].

## 4. Agent-in-XR patterns

### 4.1 What exists

| Pattern | Examples, 2026 | What EHC should take |
|---|---|---|
| Virtual monitors (remote desktop) | Immersed (up to five virtual screens; free tier with three), Meta Quest Remote Desktop, Fluid; Workrooms and Mesh are gone [V S18][R S68] | nothing for the agent loop; useful as the "just see it" path |
| Native panels and windows | visionOS windows and volumes in a Shared Space; Quest 2D panels; Android XR runs ordinary Android apps in floating windows [V S28][R S55] | panels are the right primitive: text, world-anchored, few |
| A 2D panel app next to an immersive app | a 2026 VRChat companion runs as a 2D panel on the Quest and relays OSC; Horizon OS "suspends a 2D panel the moment you drop into" an immersive app, so it runs a foreground service to keep its socket alive [R S47] | if a Quest panel app is ever built, expect to need a foreground service |
| Prompting an LLM from inside the headset | XR Blocks "Gem": the user types a prompt into a floating interface on Galaxy XR, the model writes code, a human reviews it on a virtual screen, the result appears live; a desktop simulator stands in for the headset between runs [V S65] | the review step; the simulator-to-headset loop for EHC's own tests |
| LLM intent from gaze and hands | SIAgent turns eye and hand motion into a language description an LLM reads, then runs the task with a virtual hand; 97.2% intent accuracy against 93.1% for gaze plus pinch, with less arm fatigue (60+ tasks, two studies) [V S65] | gaze and hands as a *description* for the model, not as a command alphabet the user must memorise |
| Privacy-aware capture | PRISM-XR crops the captured frame and asks the user to confirm before anything is uploaded to a cloud model [V S65] | exactly EHC's loud-consent rule, arrived at independently |
| Agents that build XR, not agents in XR | OrchestrXR (multi-agent study authoring), XARP (Python toolkit with an MCP server), DreamCodeVR (spoken behaviour to live C# scripts) [V S65] | not EHC's problem; a reminder that the agent writing XR UI on the fly is the risky direction |
| Agents that operate on data in VR | Super-Gaussian runs a function-calling agent and an intent-parsing agent over a volume the user is inside [V S65] | long-term: the robot and sensor lanes are EHC's equivalent |
| Commercial AI in headsets | Meta AI built into Horizon OS and Meta VR Glasses; Gemini on Galaxy XR; Immersed's "Curator" [V S10][R S68] | all cloud assistants tied to a platform; EHC's local lane is the difference |

### 4.2 Code in VR: what the research says

- Learners in a fully 3D node-based coding environment treated code as tangible objects - moving nodes, hovering them in space, tracing wires - to plan and predict; the same paper warns that "a perceptually rich workspace may ultimately distract users" [V S65].
- An earlier VR-native live programming study found participants arranging several methods in 3D space to use the extra room, and valuing immediate execution [V S65].
- Text legibility, reading speed and typing in XR were **not** measured or surveyed in this session [?]. They must be measured on real hardware before an immersive workbench is promised to anyone.

### 4.3 Spatial Presence

Today the Presence tab shows a built-in SVG face or an image and GIF the user picks (`src/renderer/CameraWindow.tsx`, `docs/SENSORS.md` 3a). In space:

| Stage | What the user sees | Mechanism | Layer |
|---|---|---|---|
| v0 | a status line and the conversation tail, on one world-anchored panel or in the VRChat chatbox (visibility set to "Mine" so other players do not read code) | projection state over WebSocket; OSC `/chatbox/input` | core |
| v0 | the same face image or GIF the user already chose, drawn on the panel; blinks on a timer, mouth opens on the sound of EHC's TTS | reaction loops stay on the headset - only state crosses the wire | core |
| v1 | an avatar that reflects the agent's state: "thinking", "waiting for you", "speaking" | VRChat avatar parameters the avatar exposes; typed toggles from EHC | core |
| v2 | a VRM avatar with bones, blendshapes and gaze driven over VMC | VMC Protocol (MIT); the protocol already carries blendshapes, gaze and keyboard input; "Super Agent Party" is an AI desktop character that sends VMC [V S50] | premium |
| v3 | face and eye tracking of the **user** mirrored onto the agent, body from SlimeVR | `XR_FB_face_tracking`, SolarXR | premium; sensitive data, opt-in per source |

Rule: the agent never addresses the user from behind. A presence panel is placed where the user put it and stays there.

### 4.4 The pattern this memo recommends

A **narrow projection**: the headset is a window onto a small, typed, server-generated slice of EHC - status, conversation tail, approval cards, one STOP. The agent's reasoning stays on the desktop, where the audit log, the approval binding and the gates already are. Hand-tracked editing and an immersive multi-window workbench are premium work on top of the same projection channel, not prerequisites for it.

## 5. AR

### 5.1 Where AR overlays are possible

| Surface | passthrough | anchors and planes | WebXR | Native | Status |
|---|---|---|---|---|---|
| Quest 3 and 3S | `XR_FB_passthrough` and Meta extensions [V S3] | `XR_EXT_spatial_anchor`, `XR_EXT_spatial_plane_tracking` | `immersive-ar` in Quest Browser, with passthrough, plane detection and anchors [R S56] | OpenXR, Unity, Godot (OpenXR Vendors plugin) | shipping |
| Android XR (Galaxy XR, XREAL Aura) | system compositor; `XR_ANDROID_passthrough_camera_state` | `XR_EXT_spatial_anchor`, `XR_EXT_spatial_plane_tracking`, `XR_ANDROID_device_anchor_persistence`; ARCore for Jetpack XR gives depth, persistent anchors, hit testing and planes [V S53] | `immersive-ar` in Chrome 129+ [V S39] | Jetpack, Unity, Unreal, Godot 4.6.2+ | shipping; SDK in beta |
| PICO 4 Ultra | `XR_FB_passthrough` | `XR_BD_spatial_anchor`, `XR_BD_spatial_plane` | n/a | OpenXR, Unity | shipping |
| Steam Frame | monochrome camera passthrough [V S60] | none advertised in the inventory file checked | no | OpenXR | AR in name only |
| visionOS | full passthrough; windows, volumes and anchors are the system's own model | ARKit anchors; object tracking of known physical objects since visionOS 2 [V S20] | **no `immersive-ar`**; `<model>` in stereo, and immersive website environments since Safari 27 [V S29][V S31] | RealityKit, SwiftUI, Unity PolySpatial (Pro subscription), Godot through CompositorServices | shipping; a different model - the OS composes, apps contribute |
| Android phones | camera | ARCore planes, hit tests, persistent anchors | `immersive-ar` in Chrome 81+ | ARCore | shipping |
| iPhone and iPad | camera | ARKit | **no WebXR**; AR Quick Look with a USDZ file [R S56] | ARKit, RealityKit | shipping |
| HoloLens 2 | optical see-through | MSFT anchors with persistence | no | OpenXR 1.0, MRTK | out of production; end of support 2027-12 [V S63] |

### 5.2 Phone as scanner and annotator, paired with the desktop

EHC can already look: `camera_look` sends one frame to a local vision lane and returns text, with the loud opt-in for any remote lane (`docs/SENSORS.md` 3a). The phone is a second camera with a screen you hold:

1. A page served by EHC opens on the Android phone through `adb reverse`, so the URL is `http://localhost:<port>` - a secure context, loopback only, no certificate [? - to test]. The page shows the camera and a hit-test reticle.
2. Tap to place an anchor. The page posts one frame to the existing look endpoint and gets text back.
3. The answer is drawn as a label pinned to that anchor: "cup, 0.77 confidence", or "this is the motor driver; the red wire is 12 V".
4. The label is an Observation the user created ("annotate: motor driver") - a note in the session, not a stream.

Over plain LAN `http://` the same page loses camera and WebXR, because it is not a secure context; that is why the USB route comes first. On iPhone there is no ADB, so a native ARKit app or real TLS would be needed - premium.

### 5.3 AR overlays of agent output, desktop plus phone

| Idea | How it would work | Layer |
|---|---|---|
| Point at the screen | an ArUco marker drawn in EHC's status bar registers the phone against the physical monitor; pointing the phone at a file tab or a terminal line tells EHC which region is meant, and the answer appears as a label over that region | core experiment (a marker and a region lookup, nothing platform-specific) |
| Pinned explanations | an anchor on a physical object holds the last thing the agent said about it | premium |
| Persistent annotations | anchors that survive sessions (`XR_ANDROID_device_anchor_persistence`, ARCore persistent anchors) | premium; Android XR only |
| Diagnostics on the desk | EHC's lint and diagnostic output as labels next to the printed listing the user is pointing at | premium |

### 5.4 Passthrough is a camera, with camera rules

Passthrough frames are camera data. VRChat's head-tracking output needs a legal notice accepted in-headset [V S44]; PICO's stereo camera needs special approval [V S51]; Meta ships a privacy indicator from Horizon OS 2.10 ("a persistent purple dot" whenever an app uses microphone, camera or location) [V S12]. For EHC the rule is already written: sensing is permission `ask`, a feed is live only while its window is open, and an indicator is up the whole time. In AR the indicator must be visible inside the headset.

## 6. Engine choice for a companion app

| Engine | Licence and cost | OpenXR | Quest | Android XR | PC VR | visionOS | Hands, eyes, passthrough | Fit for a tiny open bridge |
|---|---|---|---|---|---|---|---|---|
| No engine: WebXR page with three.js 0.187 (MIT) or Babylon.js 9.38 (Apache-2.0); `@pmndrs/xr` 6.6.32 optional | MIT / Apache-2.0, free | through the browser | browser | browser | browser (Edge, Chrome) | browser, VR only | hand input where the browser has it; no eye gaze; `immersive-ar` on Quest and Android XR | **best**: nothing to install, TypeScript, the page is EHC's own |
| Godot 4.6+ with OpenXR Vendors plugin 5.1 and Godot XR Tools | MIT, free | built in; 1.1 since 4.6 | yes | yes, official since 2026-05 | yes (SteamVR, Meta Link, PICO, Monado) | CompositorServices support announced at WWDC26 [V S28] - maturity unverified [?] | hand skeletons, hand data source, passthrough through alpha blend, Meta full-body tracking, foveation | **best native option**: one MIT code base, every target, no subscription |
| Unity 6 | editor free under $200k revenue and funding; Pro $2,310 per seat per year; PolySpatial and fully immersive visionOS apps need Pro [V S58] | built in | yes | yes | yes | yes, through PolySpatial | complete | only if visionOS immersive or the Unity ecosystem is the priority |
| Bevy with `bevy_mod_openxr` 0.6.0 | MIT / Apache-2.0, free | community crate; Bevy has no first-party XR [V S57] | Android target exists [?] | no | yes | no | passthrough behind a feature flag | not for a bridge; for a Rust team later |
| Native C with the OpenXR SDK | Apache-2.0 | direct | yes | yes | yes | CompositorServices | everything | too much plumbing for a panel and a socket |

**Recommendation.** Ship the bridge as a WebXR page first - it is TypeScript, it is MIT, and it runs today in Quest Browser, Chrome on Android XR and Safari on visionOS. Build the **Godot 4.6 companion** only when a measured need appears that the browser cannot meet: eye-gaze events, full-rate hand joints, passthrough with plane data, or a persistent background service. The companion stays a separate MIT repository that speaks the same WebSocket protocol as the page, so the core never depends on it.

Things to verify before the companion is started [?]: Godot has no built-in HTTP server or mDNS, so OSCQuery discovery would be manual; the size of a Godot Android export was not measured.

## 7. Core versus premium

| Capability | Layer | Why it sits there | Depends on |
|---|---|---|---|
| `EHC-XR` bridge protocol: `obs`, `project`, `ctl` messages over WebSocket; loopback by default | **core (MIT)** | the base VR/AR feature; TypeScript only | nothing |
| TypeScript OSC 1.0 and OSCQuery module with a VRChat profile | **core** | reaches every standalone Quest with no app; MIT and Apache dependencies | `node-osc` or `osc-js` |
| WebXR page (status, conversation tail, approval card, STOP) served by EHC | **core** | the minimal companion app; nothing to install | three.js (MIT) |
| Observation sources: head pose summary, head-gaze dwell, select, switch, voice transcript, presence | **core** | accessibility inputs are not a paid feature; all are events | sensor bus |
| Multi-channel consent: card + spoken + haptic; sequence arming; single-action STOP | **core** | consent, approvals and the stop are never paywalled | TTS, approvals.ts |
| Spatial Presence v0 and v1 (status line, face image, state toggles) | **core** | the Presence tab extended into space with what already exists | projection channel |
| Eye-gaze **events** on devices that expose them | **core** | an accessibility input; event only, retention none | Godot companion |
| Simulator tests with no hardware (OSC loopback, protocol tests, permission tests) | **core** | every gate needs a test that does not need a headset | `guards:test`, `sensors:test` |
| Immersive multi-window workbench (editor, terminal, diffs in space) | premium | large surface, needs measured legibility and a real GPU budget | projection channel |
| Hand-tracked editing (joint-level gestures, direct manipulation of text) | premium | precision work; Meta itself steers precision tools to controllers | companion app |
| Advanced AR overlays: persistent anchors, object-detection overlays, visionOS native | premium | per-platform native work | section 5 |
| Multi-headset and co-presence | premium | it is the Mission Control seam already named in `docs/FRONTIER.md` | A2A lane |
| VRM avatar over VMC; user face and eye tracking mirrored to the agent | premium | avatar pipeline; sensitive data | VMC, face extensions |
| Body tracking through SlimeVR | premium | hardware most users do not have | SolarXR |
| Gaze recording, heatmaps, attention analytics | **not in core; premium only with explicit per-session consent** | eye data is sensitive personal data under the OpenXR spec's own wording | - |
| Foveated Streaming and CloudXR | premium | NVIDIA GPU, Mac, entitlement | section 2.5 rank 7 |
| VRChat, SteamVR, Meta Link, Godot editor, Tobii SDK, XRoboToolkit | **external - the user installs; never bundled** | third-party licences and policies; EHC only speaks the protocol | - |

The boundary test, in one line each: consent, approvals and STOP are never premium; an accessibility input is never premium; nothing that puts a heavy binary or a non-MIT dependency inside the app is core; anything that listens beyond loopback is opt-in, audited, and never silent.

## 8. Phased plan

### 8.0 Phase 0 - prove it with the cheapest hardware (days, near zero cost)

| # | Prove | Hardware | Passes when |
|---|---|---|---|
| 1 | EHC to VRChat over OSC, no headset | none: VRChat in Desktop mode on the PC | an approval event puts text in the chatbox; chatbox visibility is "Mine"; time from event to visible text is measured |
| 2 | The WebXR page on a real headset | one Quest (3 or 3S), or any headset with a WebXR browser | `http://localhost:<port>` over `adb reverse` is a secure context; `immersive-vr` starts; head-gaze dwell plus pinch approves and denies a **real** approval card; STOP pauses the runtime; click-to-acknowledgement and click-to-server times are measured |
| 3 | The same page over PC VR on the reference machine | the headset already paired with this machine, SteamVR | the session starts from Edge; frame timing is recorded while a small model runs on EHC's engine |
| 4 | VRChat over Wi-Fi, both directions | Quest and PC on one network | documents whether PC to Quest on 9000 and Quest to PC through OSCQuery work, and what the router needs (multicast, no AP isolation) |
| 5 | Hand selection quality | Quest browser | false selections counted over 100 pinches |
| 6 | Single-switch scan | any USB gamepad or switch adapter | the whole approval card is operable with one button, including STOP |

### 8.1 Phase 1 - core (weeks)

- `src/server/xrbridge.ts` (proposed name): the WebSocket endpoint built on the `ehc-bridge/1` model (per-launch token, JSON messages, rate cap, audit), the projection state, the Observation producers registered as `bridge` sources; loopback only.
- The OSC module and the VRChat profile; the WebXR page under EHC's server.
- Consent presentation and sequence arming, built on `approvals.ts` and the existing TTS.
- Tests without hardware: protocol round-trips, permission tests ("an XR observation cannot approve anything without a pending approval id"), a STOP test that bypasses the model, audit entries per capture and per actuation.
- `docs/SPATIAL-XR.md` updated from measurements, as `docs/SENSORS.md` was.

### 8.2 Phase 2 - only where Phase 0 and 1 show a measured need

- The Godot companion: eye-gaze events on Steam Frame or Quest Pro, hand joints, passthrough with planes, a background service.
- Android XR as a first-class target (Godot 4.6.2+ and the same WebXR page).
- The robot lane through XRoboToolkit and `ehc_bridge`; SlimeVR through SolarXR; LSL through the inlet already proposed in `docs/SENSORS-ACCESSIBILITY.md`.

### 8.3 Phase 3 - premium

- Multi-window workbench, hand-tracked editing, persistent AR overlays, multi-headset presence tied to Mission Control, VRM avatars.

### 8.4 Hardware ladder

| Step | Device | Cost | What it unlocks | What it lacks |
|---|---|---|---|---|
| 0 | none | - | OSC loopback, protocol tests, VRChat Desktop | any tracking |
| 1 | Android phone | owned | WebXR `immersive-ar`, camera as scanner | hands-free use |
| 2 | Quest 3 or 3S | about $600 (512 GB, as reported) [R S60] | hand tracking, passthrough AR, VRChat, browser, Developer Mode | eye tracking (no hardware) |
| 3 | a PC VR headset with SteamVR | a headset the user already has; SteamVR is the active runtime on the reference machine and a Pimax runtime is installed there [M], and `docs/SENSORS.md` records a headset on it | the same page over PC VR; SteamVR's eye-gaze extension if the headset has an eye tracker | untethered use; GPU budget |
| 4 | Steam Frame | $1,059 as reported [R S60] | eye tracking on an open runtime, wireless PC VR | colour passthrough |
| 5 | Galaxy XR | $1,799.99 [V S54] | Android XR, eye gaze, anchors, Chrome | SDK still in beta |
| 6 | Apple Vision Pro | about $3,500-3,700 as reported [R S60] | look and pinch, Dwell and Switch Control, Foveated Streaming (needs an NVIDIA GPU) | raw gaze, WebXR AR, sideloading without Apple's programme |

## 9. Gaps and risks

| Risk | Evidence | What EHC does about it |
|---|---|---|
| **Stock Electron has no XR device** | measured, 2.1 | the bridge is the architecture; never plan on in-process WebXR |
| **Secure context** | measured: `navigator.xr` absent on a non-secure page | serve the page as `http://localhost` over `adb reverse`, or real TLS; never a bare LAN `http://` address |
| **Quest walled garden** | installing an app needs Developer Mode, which needs a developer team, a verified account (SMS two-factor or a payment method), age 18+; "Developer Mode is intended for development tasks ... Engaging in other activities may result in account limitations, suspension, or termination"; store publication needs organisation verification with a government ID [V S16][V S17]. SideQuest's no-developer-mode wireless setup was removed in October 2026 [R S69] | the core path needs no install: browser and VRChat are store apps. The companion is sideloaded by the user, at their own risk, with the policy quoted in the docs |
| **visionOS walled garden** | building needs a Mac and Xcode; Foveated Streaming needs an entitlement; distribution is the App Store or Managed App Distribution [V S19][V S21] | visionOS is reached through Safari (VR only) in core; anything native is premium |
| **Android XR, PICO** | Android XR is Android, with Google Play; some PICO firmware needs a PICO developer account before USB debugging can be enabled [R S51] | same answer: the browser first |
| **Two latencies that must not be confused** | cybersickness: delays above 40 ms can evoke it, significant symptoms from 75 ms, many researchers advise below 20 ms; latency jitter matters; "maintain a stable frame rate" [V S67]. Frame budgets: 72 Hz 13.9 ms, 90 Hz 11.1 ms, 120 Hz 8.3 ms, 144 Hz 6.9 ms | the render loop never waits on EHC: no `await` on the network inside a frame; a click is acknowledged locally within one frame; the agent answers in its own time. The standalone paths keep rendering off the PC entirely |
| **GPU contention on a shared machine** | the reference machine reserves an Intel Arc B70 for training and pins Electron to an AMD RX 7900 XTX, with a rule to keep at least 8 GB free on the B70 (`docs/GPU.md`); SteamVR's compositor and stream encoding would land on the same 7900 XTX | prefer standalone rendering; measure in Phase 0 item 3; a PC VR session is opt-in and shown in the capability list as a GPU cost |
| **Tracking loss** | hands leave the cameras' view (Wide Motion Mode covers Quest); eye-tracking confidence is fixed at 0.5; Quest's own "Hide Hands" gesture can switch hand tracking off [V S12] | every selection has a head-gaze and a switch path; a lost hand is "no input", never a wrong input |
| **Motion sickness, and users who are more susceptible** | a 15.6% mean dropout from VR sickness across 46 experiments; older adults are particularly susceptible to low frame rates; Apple's guidance: no motion "missing a stationary frame of reference", and do not make people move to reach content [V S67][V S23] | no artificial locomotion in core; one stationary panel; nothing head-locked; the headset is optional, always |
| **Privacy: eye and face data** | "dangerous" permissions on Quest; the spec asks for "active and specific acceptance"; gaze is GDPR-class sensitive data (interpretation, not legal advice - `docs/SENSORS-ACCESSIBILITY.md` 2.1) | events not streams; retention none; gaze recording is not a core feature |
| **Privacy: VRChat is an online service** | account required; other players see the chatbox unless visibility is "Mine"; OSC output needs a legal notice | VRChat is an opt-in third-party path, labelled as such; it is never the default |
| **Network exposure** | OSC is unauthenticated UDP; EHC's server is loopback with a password; `docs/FRONTIER.md` keeps networked surfaces out of the free core | `adb reverse` first; a LAN listener, if ever, is a separate narrow endpoint for the projection only, never the full runtime API |
| **Protocol fragility** | OSCQuery depends on mDNS and multicast; routers split Wi-Fi from wired clients [R S49] | manual IP and port as the fallback; a 30-minute test instead of an assumption |
| **Platform churn** | Workrooms and Mesh retired; HoloLens 2 out of production; WMR support ending; Quest 2 and Pro in maintenance; the Android XR SDK in beta; SideQuest's wireless setup removed | protocols, not products; every dependency is behind an adapter with a capability check |
| **Licences** | Unity Pro for immersive visionOS; Tobii developer licence; `@pmndrs/xr` licence text not confirmed; liblsl licence file non-standard; VRChat app proprietary | core depends on MIT and Apache packages only, each checked before pinning (the rule `docs/SENSORS.md` 3b already states) |

**Open questions this memo did not close [?]:** the "TUST" name; camera-based hand tracking on Steam Frame; VRChat on a standalone Quest sending OSC to a PC over Wi-Fi; the eye-tracking permission policy on Android XR; Magic Leap 2 availability; whether SteamVR tolerates a frame-less OpenXR session; Godot on visionOS in practice; `adb reverse` plus WebXR secure-context behaviour on Quest and Android; whether a CloudXR endpoint can be used for input only; the scope of Meta's "switch device compatibility"; text legibility and typing performance in XR.

## 10. Sources

**Standards and registries**

- [S1] Khronos, OpenXR conformant products - https://www.khronos.org/conformance/adopters/conformant-products/openxr
- [S2] Khronos, OpenXR 1.1 specification (1.1.65) - https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html
- [S3] Khronos OpenXR-Inventory, runtime extension support - https://github.khronos.org/OpenXR-Inventory/runtime_extension_support.html and https://github.com/KhronosGroup/OpenXR-Inventory/tree/main/runtimes
- [S4] Khronos, OpenXR BOF, SIGGRAPH 2026 slides - https://www.khronos.org/assets/uploads/developers/presentations/OpenXR_BOF_v2_SIGG_2026_-_Slides.pdf
- [S5] `XR_EXT_eye_gaze_interaction`, specification source - https://github.com/KhronosGroup/OpenXR-Docs/blob/main/specification/sources/chapters/extensions/ext/ext_eye_gaze_interaction.adoc
- [S33] W3C, WebXR Device API (Candidate Recommendation Draft, 2026-11-09) - https://www.w3.org/TR/webxr
- [S34] W3C, XR Accessibility User Requirements (Working Group Note) - https://www.w3.org/TR/xaur

**Chromium and Electron**

- [S35] Chromium, `device/vr` README (platform support table) - https://chromium.googlesource.com/chromium/src/+/refs/heads/main/device/vr
- [S36] Chromium, `device/vr/buildflags/buildflags.gni` - https://chromium.googlesource.com/chromium/src/+/refs/heads/main/device/vr/buildflags/buildflags.gni
- [S37] Chromium issue 506004811, WebXR on Linux - https://issues.chromium.org/issues/506004811 ; utzcoz, "First Milestone: WebXR on Linux Chromium with OpenXR" - https://utzcoz.github.io/2026/11/07/webxr-in-chromium-on-linux-with-openxr.html
- [S38] Chromium issue 40698217, WebXR flags - https://issues.chromium.org/issues/40698217
- [S39] Immersive Web Community Group, Chrome hardware support - https://immersiveweb.dev/chrome-support.html
- [S40] Electron `DEPS`, branches 42-x-y, 43-x-y and main - https://github.com/electron/electron/blob/42-x-y/DEPS
- [S41] Electron issues - https://github.com/electron/electron/issues/35011 and https://github.com/electron/electron/issues/21446
- [S42] J. Baicoianu, "Electron + WebXR" (2021) - https://bai.dev/projects/webxr-electron-apr2021.html
- [S43] Stack Overflow, "What is the status of WebXR in Electron?" - https://stackoverflow.com/questions/64650129/what-is-the-status-of-webxr-in-electron
- [S74] Google issue tracker, "WebXR/OpenXR: support immersive-ar passthrough" (2026-10-13) - https://issuetracker.google.com/issues/573058980

**Apple, NVIDIA**

- [S19] Apple Developer Documentation, Foveated Streaming - https://developer.apple.com/documentation/foveatedstreamming ; "Creating a foveated streaming client on visionOS" - https://developer.apple.com/documentation/FoveatedStreaming/creating-a-foveated-streaming-client-on-visionos
- [S20] WWDC26, "Build next-generation experiences with visionOS 27" (transcript) - https://developer.apple.com/videos/play/wwdc2026/287 ; "Use foveated streaming to bring immersive content to visionOS" - https://developer.apple.com/videos/play/wwdc2026/286
- [S21] Apple, visionOS 26.4 release notes - https://developer.apple.com/documentation/visionos-release-notes/visionos-26_4-release-notes
- [S22] NVIDIA CloudXR SDK - https://docs.nvidia.com/cloudxr-sdk/latest/getting_cloudxr.html and https://docs.nvidia.com/cloudxr-sdk/latest/usr_guide/foveated_streaming/index.html
- [S23] Apple, Human Interface Guidelines, Designing for visionOS - https://developer.apple.com/design/human-interface-guidelines/designing-for-visionos
- [S24] Apple, Improving accessibility support in your visionOS app - https://developer.apple.com/documentation/visionos/improving-accessibility-support-in-your-visionos
- [S25] Apple Support, Use Dwell Control on Apple Vision Pro - https://support.apple.com/guide/apple-vision-pro/perform-actions-with-your-eyes-tan0ba69a1f1/visionos
- [S26] Apple Support, About visionOS 26 updates - https://support.apple.com/en-us/123024
- [S27] Apple Newsroom, accessibility features (2026-05-19) - https://www.apple.com/newsroom/2026/05/apple-unveils-new-accessibility-features-and-updates-with-apple-intelligence/
- [S28] Apple, visionOS what's new - https://developer.apple.com/visionos/whats-new/ ; WWDC26 visionOS guide - https://developer.apple.com/wwdc26/guides/visionos
- [S29] Apple, Safari 27 release notes - https://developer.apple.com/documentation/safari-release-notes/safari-27-release-notes
- [S30] WebKit blog, "WebKit Features in Safari 18.0" - https://webkit.org/blog/15865/webkit-features-in-safari-18-0
- [S31] Apple Developer Forums, "WebXR Augmented Reality Module" - https://developer.apple.com/forums/thread/826845
- [S32] Unity Manual, visionOS platform - https://docs.unity.com/en-us/engine/6000.6/manual/platform-specific/vision-os

**Meta**

- [S6] Meta Horizon OS Developers, Eye Tracking in Movement SDK for OpenXR - https://developers.meta.com/horizon/documentation/native/android/move-eye-tracking
- [S7] Meta, Movement OpenXR API reference (permissions) - https://developers.meta.com/horizon/documentation/native/android/move-api/
- [S8] Meta, Horizon OS input - https://developers.meta.com/vr/essentials/horizon-os-input
- [S9] Meta, Compare devices - https://developers.meta.com/vr/resources/compare-devices/
- [S10] Meta, "Introducing Meta VR Glasses" (2026-09-23) - https://www.meta.com/blog/meta-vr-glasses-announcement-meta-connect ; Unite Tokyo 2026 developer notes - https://developers.meta.com/vr/blog/unite-tokyo-2026-highlights-building-for-meta-vr-glasses
- [S11] Meta, accessibility features for Meta Quest - https://www.meta.com/help/quest/674999931400954 ; Meta Accessibility, features - https://www.meta.com/accessibility/features
- [S12] Meta Quest release notes (Horizon OS 2.10) - https://www.meta.com/help/quest/172903867975450
- [S13] Meta, Screen reader on Meta Quest - https://www.meta.com/help/quest/1214695769962939
- [S14] Meta, Direct Touch - https://www.meta.com/help/quest/804044858396824
- [S15] Meta design documentation - input modalities: https://developers.meta.com/horizon/design/interactions-input-modalities ; hands: https://developers.meta.com/horizon/design/hands
- [S16] Meta Horizon OS Developers, Device Setup - https://developers.meta.com/horizon/native/android/mobile-device-setup
- [S17] Meta Horizon OS Developers, Verify your organization - https://developers.meta.com/horizon/resources/publish-organization-verification
- [S18] Meta Quest Help, "Meta Horizon Workrooms is being discontinued" - https://www.meta.com/help/quest/2464765133873078

**Android XR, Samsung, Google**

- [S53] Android Developers Blog - Android XR updates for Unity, Unreal and Godot (2026-05-19): https://android-developers.googleblog.com/2026/05/android-xr-updates-unity-unreal-godot.html ; Developer Preview 4: https://android-developers.googleblog.com/2026/05/android-xr-sdk-developer-preview-4-updates.html ; Jetpack XR SDK beta (2026-08-18): https://android-developers.googleblog.com/2026/08/jetpack-xr-sdk-core-libraries-beta.html ; tooling and ecosystem (2026-06-15): https://developer.android.com/blog/posts/what-s-new-in-android-xr-tooling-engine-support-and-ecosystem-updates ; Godot on Android XR: https://developer.android.com/develop/xr/godot/add-support
- [S54] Samsung Newsroom, Galaxy XR - https://news.samsung.com/global/introducing-galaxy-xr-opening-new-worlds ; UK launch - https://news.samsung.com/uk/samsung-galaxy-xr-arrives-in-the-uk
- [S55] TechCrunch, Xreal Aura (2026-10-28) - https://techcrunch.com/2026/10/28/xreal-aura-is-a-new-wired-headset-powered-by-android-xr ; Digital Immersive Box, "Android XR Explained" (2026-11-14) - https://digitalimmersivebox.com/articles/android-xr-explained

**Valve, HTC, Tobii, Microsoft**

- [S60] Steamworks, Steam Frame - custom engines: https://partner.steamgames.com/doc/steamhardware/steamframe/engines/custom ; Valve Developer Community, Steam Frame: https://developer.valvesoftware.com/wiki/Steam_Frame ; IGN announcement: https://www.ign.com/articles/valve-announces-steam-frame-its-next-gen-vr-headset ; Road to VR specifications: https://www.roadtovr.com/valve-steam-frame-release-date-price-specs ; VR.org price comparison: https://vr.org/meta-vr-glasses
- [S61] `mbucchia/Pimax-EyeTracker-SteamVR` - https://github.com/mbucchia/Pimax-EyeTracker-SteamVR ; ValveSoftware/openvr issue 1886: https://github.com/ValveSoftware/openvr/issues/1886 ; `frameeyeosc`: https://github.com/sasaken1102r/frameeyeosc
- [S62] Tobii, "OpenXR announces first extension for eye tracking" - https://www.tobii.com/blog/openxr-announces-the-first-extension-for-eye-tracking ; Tobii Streams SDK: https://www.tobii.com/products/integration/tobii-streams-sdk ; Psychtoolbox forum, "VR Eye tracking": https://psychtoolbox.discourse.group/t/vr-eye-tracking/5757
- [S63] Microsoft Learn, Mixed Reality support options - https://learn.microsoft.com/en-us/hololens/hololens2-support ; HoloLens 2 purchase: https://learn.microsoft.com/en-us/hololens/hololens2-purchase ; BestInXR, "Microsoft HoloLens in 2026": https://bestinxr.com/post/microsoft-hololens ; AR Compare, "Is HoloLens 2 discontinued?": https://www.arcompare.com/guides/is-hololens-2-discontinued/
- [S64] AR Compare, OpenXR conformant devices - https://www.arcompare.com/guides/openxr-conformant-devices/ ; ExplorXR, "What Is OpenXR?": https://explorxr.com/posts/what-is-openxr/ ; Hivebook, OpenXR: https://hivebook.wiki/wiki/openxr-khronos-cross-vendor-xr-api
- [S71] Monado, Getting started - https://monado.freedesktop.org/getting-started.html

**VRChat, OSC, VMC, SlimeVR, XRoboToolkit**

- [S44] VRChat documentation - OSC overview: https://docs.vrchat.com/docs/osc-overview ; avatar parameters: https://docs.vrchat.com/docs/osc-avatar-parameters ; input controller: https://docs.vrchat.com/docs/osc-as-input-controller ; OSCQuery: https://docs.vrchat.com/docs/oscquery ; release 2023.3.1: https://docs.vrchat.com/docs/vrchat-202331 ; launch options: https://docs.vrchat.com/docs/launch-options
- [S45] VRChat Wiki, OSC - https://wiki.vrchat.com/wiki/OSC ; community wiki, OSCQuery: https://github.com/vrchat-community/osc/wiki/OSCQuery ; OSC resources and library comparison: https://wiki.vrchat.com/wiki/Community:OSC_Resources
- [S46] `vrchat-community/vrc-oscquery-lib` - https://github.com/vrchat-community/vrc-oscquery-lib ; OSCQuery proposal: https://github.com/Vidvox/OSCQueryProposal
- [S47] `VRChat-Legends/vrc-osc-companion` (third-party, GPL-3.0) - https://github.com/VRChat-Legends/vrc-osc-companion
- [S48] SlimeVR documentation - OSC (standalone tracking): https://docs.slimevr.dev/server-setup/osc-information.html ; Linux installation and firewall ports: https://docs.slimevr.dev/tools/linux-installation.html ; SolarXR-Protocol: https://github.com/SlimeVR/SolarXR-Protocol ; SlimeVR-Server: https://github.com/SlimeVR/SlimeVR-Server ; product page: https://slimevr.dev/
- [S49] VRCOSC, Connecting - https://vrcosc.com/docs/v2/connecting ; Amethyst, OSC plugin on Quest: https://docs.k2vr.tech/en/osc/ ; `minetake01/vrchat_osc` network notes: https://github.com/minetake01/vrchat_osc
- [S50] VMC Protocol - specification: https://protocol.vmc.info/english ; reference implementations and applications: https://protocol.vmc.info/Reference
- [S51] XRoboToolkit - Unity client: https://github.com/XR-Robotics/XRoboToolkit-Unity-Client ; Quest client: https://github.com/XR-Robotics/XRoboToolkit-Unity-Client-Quest ; ROS packages: https://github.com/XR-Robotics/XRoboToolkit-Teleop-ROS ; PC service: https://github.com/XR-Robotics/XRoboToolkit-PC-Service ; PICO's entry: https://github.com/Pico-Developer/XRoboToolkit ; PICO setup with `adb reverse`: https://github.com/wuji-technology/wuji-hand-teleop/blob/main/docs/PICO.md ; teleoperation guide: https://fiveages-sim.github.io/docs/2-how_to/5-teleoperation/6-vr_teleop.html
- [S76] `Seventh-Void/WiVRn-QPro-OSC` (third-party) - https://github.com/Seventh-Void/WiVRn-QPro-OSC

**Engines and packages**

- [S52] Godot documentation - OpenXR hand tracking: https://docs.godotengine.org/en/stable/tutorials/xr/openxr_hand_tracking.html ; OpenXR settings: https://docs.godotengine.org/en/stable/tutorials/xr/openxr_settings.html ; "Godot OpenXR Vendors plugin v5.1" (2026-05-19): https://godotengine.org/article/godot-xr-update-may-2026 ; Khronos blog, Godot OpenXR integration update (2025-11-10): https://www.khronos.org/blog/godot-openxr-integration-project-update-major-openxr-features-now-production-ready
- [S56] WebXR browser support, 2026 - https://digitalimmersivebox.com/articles/webxr-browser-vr-ar ; https://threejsresources.com/webxr/browsers ; Meta, WebXR overview: https://developers.meta.com/vr/documentation/web/webxr-overview
- [S57] Bevy XR - `awtterpip/bevy_oxr`: https://github.com/awtterpip/bevy_oxr ; `bevy_mod_openxr`: https://crates.io/crates/bevy_mod_openxr ; Bevy discussion 21495: https://github.com/bevyengine/bevy/discussions/21495
- [S58] Unity - pricing updates: https://unity.com/products/pricing-updates ; XR packages: https://docs.unity.cn/6000.7/Documentation/Manual/xr-support-packages.html
- [S59] `pmndrs/xr` - https://github.com/pmndrs/xr ; `node-xr/node-openxr` - https://github.com/node-xr/node-openxr
- [S70] GitHub REST API and the npm registry, queried 2026-11-27 for stars, last push, licence and latest version of the repositories and packages named in the text.

**Research**

- [S65] Vibe Coding XR, arXiv 2603.24591 - https://arxiv.org/html/2603.24591 ; GenXR-Bench, arXiv 2610.29014 - https://arxiv.org/html/2610.29014 ; XARP, arXiv 2508.04108 - https://arxiv.org/html/2508.04108 ; SIAgent, arXiv 2603.00522 - https://arxiv.org/abs/2603.00522 ; OrchestrXR, arXiv 2607.01588 - https://arxiv.org/html/2607.01588 ; PRISM-XR, arXiv 2602.10154 - https://arxiv.org/html/2602.10154 ; Super-Gaussian, arXiv 2608.04475 - https://arxiv.org/html/2608.04475 ; Wu et al., "Coding in Virtual Reality", ACM TOCE 26(3), 2026 - https://dl.acm.org/doi/10.1145/3787850 ; Geier et al., "Toward a VR-Native Live Programming Environment", PAINT 2022 - http://www.hirschfeld.org/writings/media/GeierTiedtBeckmannTaeumelHirschfeld_2022_TowardAVrNativeLiveProgrammingEnvironment_AcmDL.pdf ; "End-user automation authoring in VR and AR through conversations", Behaviour and Information Technology, 2026 - https://iris.cnr.it/bitstream/20.500.14243/596682/1/published_End-user%20automation%20authoring%20in%20VR%20and%20AR%20through%20conversations%20patterns%20errors%20and%20user%20recovery%20strategies.pdf
- [S66] XR accessibility research - Wang et al., CHI 2025: https://dl.acm.org/doi/full/10.1145/3706598.3713927 ; "How Well Can 3D Accessibility Guidelines Support XR Development?", CHI 2026: https://dl.acm.org/doi/10.1145/3772318.3790520 ; Mott et al., ASSETS 2020: http://cutrell.org/papers/Mott-ASSETS2020-understanding_vr_accessibility.pdf ; VR accessibility reviews, arXiv 2508.13051: https://arxiv.org/html/2508.13051 ; ITU-T FGMV-04: https://www.itu.int/en/ITU-T/focusgroups/mv/Documents/List%20of%20FG-MV%20deliverables/FGMV-04.pdf
- [S67] Cybersickness - systematic review, Virtual Reality 2021: https://link.springer.com/article/10.1007/s10055-021-00513-6 ; survey, Computers 2022: https://www.mdpi.com/2073-431X/11/4/51 ; "Are you feeling sick?", ACM Computing Surveys 2024: https://dl.acm.org/doi/full/10.1145/3670008 ; latency review, Frontiers in Virtual Reality 2020: https://www.frontiersin.org/journals/virtual-reality/articles/10.3389/frvir.2020.582204/full ; meta-analysis, Frontiers in Human Neuroscience 2020: https://www.frontiersin.org/journals/human-neuroscience/articles/10.3389/fnhum.2020.00096/full ; Kim et al. 2020 on display lag: https://www.sciencedirect.com/science/article/pii/S0747563220302363

**Products, market, policy**

- [S68] Immersed investor page (self-reported figures) - https://invest.immersed.com/ ; Gadget Review interview (2026-09): https://www.gadgetreview.com/apples-vision-pro-weighs-a-pound-this-one-weighs-six-ounces ; Startup Stash, Workrooms alternatives: https://startupstash.com/alternatives/horizon-workrooms ; Katmai, virtual office vendor status (2026-10): https://katmaitech.com/blog/which-virtual-office-companies-are-still-standing
- [S69] Metaverse Watcher, sideloading Quest 3 in 2026 (SideQuest wireless setup removed) - https://www.metaversewatcher.io/how-to-sideload-quest-3-games-guide/ ; Quest Developer Hub notes (Quest 2 and Pro feature development ended 2026-11-02) - https://shattered.io/meta-quest-developer-hub-developer-mode-adb-sideload-12-steps-2026/
- [S72] EHC's own documents, read for this memo: `AGENTS.md`, `docs/SENSORS.md`, `docs/SENSORS-ACCESSIBILITY.md`, `docs/SENSORY.md`, `docs/GPU.md`, `docs/FRONTIER.md`, `docs/ROADMAP.md`, `src/renderer/CameraWindow.tsx`, `src/server/approvals.ts`, `src/server/sensory-catalog.ts`, and `src/server/sensorBus.ts` (in flight and untracked when read).
- [S73] The Verge, Meta VR Glasses hands-on - https://www.theverge.com/tech/999517/meta-vr-glasses-connect-2026-hands-on ; Road to VR - https://roadtovr.com/meta-vr-glasses-unveiled-price-release-date/

**Measured on the reference machine (2026-11-27), all read-only except the two probe files kept in the temp folder and deleted afterwards:**

- Electron version and binary strings: `node_modules\electron\dist\version`; a Latin-1 string search of every `.exe` and `.dll` in `dist` and of the two installed `msedge.dll` builds for `xrCreateInstance`, `xrGetInstanceProcAddr`, `XR_EXT_win32_appcontainer_compatible` and `immersive-vr`.
- Runtime probe: a temporary Electron main script with a hidden `BrowserWindow` loading a `file://` page, `navigator.xr.isSessionSupported()` for `inline`, `immersive-vr` and `immersive-ar`, run twice (second time with `--enable-features=OpenXR,WebXRIncubations --force-webxr-runtime=openxr`).
- OpenXR runtime registration: `HKLM:\SOFTWARE\Khronos\OpenXR\1` (`ActiveRuntime` and `AvailableRuntimes`); XR-related processes; PnP devices; free memory before the probe (5.4 GB of 64.5 GB).
- Source: Electron `DEPS` on `42-x-y`, `43-x-y` and `main`; Electron `BUILD.gn` and `patches/config.json` on `42-x-y`; Chromium `BUILD.gn`, `device/vr/BUILD.gn` and `device/vr/buildflags/buildflags.gni`; the OpenXR specification page (25.3 MB) for extension names; fourteen runtime files of the OpenXR-Inventory.
