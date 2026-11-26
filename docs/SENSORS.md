# Sensors and presence (S3) - giving the agent a body beyond ears and mouth

**Status: PROPOSED - a design, nothing implemented.** Researched 2026-11-26; sources at the end. Every number quoted here is from a cited paper or product page, not from a measurement on our hardware. Each phase lists what has to be measured before it can be called done.

Operator's direction (2026-11-26): an on-screen agent presence; a camera that lets a vision model see; and a step toward physicalisation - lidar, object detection, RF/EM readers, "advanced state-of-the-art sensors and other possibilities". Privacy and security stay the driving goals: "all the freedom to move, see, hear, speak, understand and act/react - sensors, tools, inference, controls/backstops."

## 1. Invariants (the part that does not change per sensor)

1. **Every sensor is off until the user turns it on.** A feed is live only while its window or watch is open, shows an "in use" indicator the whole time, and is released on close. The microphone already works this way (release measured on every exit path).
2. **The agent gets observations, not streams.** What reaches the model is a bounded, structured description produced on request or under a watch the user defined: text and small JSON. Raw video, point clouds and IQ samples never enter the prompt.
3. **Nothing leaves the machine** except the prompt the user approved, to the model endpoint the user chose. A frame sent to a BYOK vision model leaves the machine - and the UI says so at that moment.
4. **Sensing and actuating are different gates.** Reading a sensor is permission `ask`. Moving anything in the physical world additionally requires an armed state set from the UI, a bounded duration, and a stop that does not depend on the model.
5. **The ladder, as everywhere else:** what the app already has (Chromium's camera and audio capture, the engine's multimodal lane) -> the user's existing stack (ROS 2 drivers, SDR suites, vendor SDKs, run as their own processes) -> optional pinned downloads for models (the same catalog mechanism as whisper.cpp) -> an honest error.
6. **Keep EHC light.** Perception runs out of process, at a frame rate the user caps, and never on the agent loop's critical path.

## 2. Architecture: a sensor bus

One small server-side bus replaces a driver per feature.

```
sources                                  bus (loopback, in the server)               consumers
- device   camera, microphone        ->  Observation { source, kind, t, seq,      ->  agent tools (look, listen, scan)
- process  yolo, lidar driver, sdr        payload | ref, retention: none }        ->  Video / Radar / Spectrum windows
- bridge   ROS 2 node ("ehc_bridge")                                          ->  watches ("tell me if a person appears")
- serial   UART, USB HID, I2C via a sidecar                                   ->  audit log (one entry per capture)
```

- A source is started and stopped by the user (`POST /api/sensors/:id/start|stop`); `GET /api/sensors` lists what exists and what is live.
- `POST /api/sensors/:id/observe { question }` runs perception on the latest frame (vision model or detector) and returns text. This is what an agent tool calls.
- Peripherals talk to the bus, not to the app: a ROS 2 bridge node for anything with a ROS 2 driver, a loopback UDP/TCP or stdin/stdout sidecar for everything else. No native serial/USB module inside the Electron app.
- Retention is `none` by default. Keeping frames is an explicit opt-in per source.

## 3. Phases

### S3a - Camera window and agent presence (first implementation target)

- **A "camera" pop-out window**, built on the existing pop-out mechanism (`window:popout` gains a third allowlisted kind). It shows the user's camera with the same picker the microphone has, and nothing else on v1.
- **A deliberate grant, not a default.** Today the camera is refused to every page in the app. The permission handlers would allow video for exactly one webContents - the camera window - and only after the user opened it. Every other window keeps being refused, and a test asserts it.
- **Eyes.** A button (and an agent tool, `camera_look { question }`, permission `ask`) grabs a frame, downscales it, and sends it over loopback to the engine's multimodal lane (`llama-server --mmproj`, already wired for vision models), or to the user's BYOK vision model if that is what they selected. The answer is text in the chat. The research says to keep output short: generation is over 85 % of a vision model's latency.
- **Agent presence.** Start with something that needs no download: a 2D face driven by the existing speech output's loudness (mouth opens on sound, blinks on a timer, looks at the camera window when it is open). A 3D avatar (VRM) is a later, optional download.
- To measure before calling it done: release on close (as for the mic), camera refused everywhere else, time from "look" to answer on this machine, and that no frame is written to disk.

### S3b - Detection and tracking (YOLO-class)

What the 2026 literature says:

- Small CNN detectors still own the low-power tier. **YOLO26** (Ultralytics) runs without non-maximum suppression; the nano model reaches 40.9 COCO mAP at about **39 ms per frame on CPU (ONNX)**, the small model 48.6 mAP at 87 ms (arXiv 2509.25164).
- Transformers lead on accuracy but need a GPU-class machine: **RT-DETRv4** reports 49.8-57.0 AP at 78-273 FPS on server hardware (arXiv 2510.25257). A 2026 survey finds no DETR variant under 5 GFLOPs.
- On a Raspberry Pi 5, large detectors take seconds per frame on CPU; runtime choice (TensorRT, HailoRT, NCNN) matters as much as the model (Scientific Reports, March 2026). On RK3588, nano and small models run in real time.

Design: detection is a **sidecar** taking frames from the bus and returning boxes as JSON (`[{ label, confidence, box }]`), which becomes a one-line observation ("person 0.91 at centre-left; cup 0.77 at right"). Model and runtime (ONNX Runtime or NCNN) are optional pinned downloads. **Licence check before pinning anything:** Ultralytics YOLO is AGPL-3.0; Apache-2.0 alternatives exist (YOLOX, RT-DETR, RF-DETR) - confirm each before it enters the catalog. As a separate user-downloaded process it does not affect EHC's MIT licence either way, but the catalog should prefer the Apache models.

### S3c - Range: lidar and depth

Prices as listed in November 2026, for orientation only:

| Class | Examples (as listed) | ROS 2 driver | What the agent would get |
|---|---|---|---|
| 2D scanner | RPLIDAR C1 (12 m), S2 (30 m), S3 (40 m); YDLIDAR | `sllidar_ros2` (Slamtec) | nearest obstacle per sector, a planar map |
| 3D, low cost | Unitree L2 (~$419, 360 x 96 deg, 30 m, 64k points/s, built-in IMU) | `unilidar_sdk2` | occupied/free volume around the body |
| 3D, wider | RoboSense Airy Lite (~$599), Airy (~$999); Livox Mid-360 (~$999, 200k points/s, IP67) | `rslidar_sdk`, `livox_ros_driver2` | terrain shape, SLAM input |

- All of these have official ROS 2 drivers, so EHC needs no vendor SDK: the bridge node subscribes to `LaserScan` / `PointCloud2` and publishes downsampled summaries. At 200k points/s the cloud must be voxel-filtered before anything else touches it.
- Depth cameras (RealSense, Orbbec) cover the near field that a 2D scanner misses (table tops, steps).
- UI: a "Radar" panel drawing the latest scan on a canvas - useful to the user and a cheap visual check that a device really is live.

### S3d - Radio and electromagnetic

| Source | What it gives | How it would connect |
|---|---|---|
| RTL-SDR dongle (~$30) | spectrum peaks, signal presence | `rtl_power` / `rtl_tcp` as a sidecar; peaks become JSON |
| KrakenSDR (5 coherent channels, 24 MHz-1.77 GHz) | direction finding (MUSIC), beamforming, decoders for aircraft / ships / ISM devices | its 2026 suite (C++, runs on a Pi 4/5, Windows, macOS) as the user's own process; EHC reads its local output over loopback |
| Magnetometer (RM3100 and similar) | heading, disturbances | serial/I2C sidecar |
| Passive radar (pyAPRIL) | range-Doppler plots of aircraft from broadcast reflections | research-grade; receive-only |

- **Receive only.** Nothing here transmits; transmitting is regulated.
- **Licensing:** KrakenSDR's Heimdall is GPLv3 and its direction-finding app is source-available (free for personal and hobbyist use; commercial use needs a licence). It therefore runs as an external process the user installed, never bundled.
- **Zero cloud:** KrakenRF offers a cloud mapper; EHC would use only the local map and logs.
- A watch example: "tell me when a signal appears on 433.92 MHz" - the same bounded-watch mechanism as for the camera.

### S3e - Environment and other possibilities

IMU, temperature / humidity / gas (BME688, SGP41), time-of-flight, thermal (FLIR Lepton), microphone arrays with direction of arrival (ReSpeaker), UWB or BLE positioning, CAN bus / OBD-II for vehicles, GPIO (Firmata). All fit the same shape: a sidecar or bridge node, an `Observation`, a watch. None needs a design decision beyond "which one first".

### S3f - Physicalisation and robotics

- **ROS 2 is the universal adapter.** One bridge node ("ehc_bridge") turns topics into observations and EHC tools into service or topic calls; Zenoh is the lighter-transport alternative. Everything in S3c and S3e with a ROS 2 driver comes along for free.
- **Actuation gates:** a tool that moves hardware requires (1) the user's `ask` approval, (2) an "armed" toggle in the UI that the model cannot set, (3) a maximum duration, and (4) a stop command that bypasses the model. A hardware e-stop is recommended and is the user's.
- **Vision-language-action models** are not in the first plan. The research shows them feasible on Jetson-class hardware (ROS2SmolVLA, arXiv 2608.23320; LiteVLA-Edge at 6.6 Hz) but they are a different trust model from a tool-calling agent and should be a deliberate later decision.
- Reference low-cost hardware to design against: Unitree Go2 / G1, the SO-100 / SO-101 arm, Nav2 for navigation.

## 4. What the camera can and cannot do - from the literature

- A 256M-parameter vision-language model (SmolVLM, 4-bit GGUF) gave a decision every **150 ms** on a Jetson AGX Orin GPU through llama.cpp, inside a ROS 2 node (arXiv 2603.03380). That is the engine family EHC already bundles.
- On a robot, a scene-description pipeline built on SmolVLM2 was judged **65 % correct**, with up to **8 seconds** between an event and the agent knowing about it (arXiv 2511.02427).
- A 2B vision model answered in under a second on an L4-class GPU but lost accuracy against an 11B model (arXiv 2601.14921); Moondream2 answered in 0.9-2.3 s on Jetson hardware (IPDPSW 2026).
- A natural-language pan-tilt-zoom camera agent found that, once the planner is good enough, **perception becomes the bottleneck** (SCOPE, HRI 2026).
- On phone-class NPUs, on-device vision-language inference is still slow (tens of seconds per turn, arXiv 2610.40039).

Consequences for the design: the camera is a tool the agent asks to use, answers are short, and nothing safety-relevant depends on a continuous feed. "I looked; here is what I saw" - not sight.

## 5. Security and privacy checks every phase must pass

- Camera, microphone and every other feed refused outside its own window; an indicator while live; released on close.
- No frame, scan or sample written to disk unless the user opted in per source.
- One audit entry per capture and per actuation (source, tool, bytes - never the content).
- Web content and sensor output are untrusted input to the model (see `docs/BROWSER.md`).
- Agent-initiated looks and listens are permission `ask`; watches are user-created and visibly listed.

## 6. Decisions for the operator

1. Which hardware is on hand first? A camera is enough for S3a. A lidar or an SDR decides whether S3c or S3d comes next.
2. Agent presence: a simple 2D face first (no download), or go straight to a 3D avatar?
3. Vision on this machine: the bundled engine's multimodal lane, or a BYOK vision model (frames then leave the machine)?

## Sources

- YOLO26 (arXiv 2509.25164); RT-DETRv4 (arXiv 2510.25257); single-stage detection survey, Artificial Intelligence Review 2026; edge benchmarks, Scientific Reports March 2026 and PMC12894890.
- LiDAR comparisons and ROS 2 driver status, November 2026: fictionlab.pl, dexorarobotics.com, xirkit.io; Unitree L2 and Slamtec product pages.
- KrakenSDR Suite V2 (github.com/krakensdr_suite), KrakenRF product pages; passive radar node write-up, tyfsadik.org.
- LiteVLA-Edge (arXiv 2603.03380); SmolVLM2 scene interpretation on edge devices (arXiv 2511.02427); VLMs on the edge for robotic perception (arXiv 2601.14921); on-device VLM measurement study (arXiv 2610.40039); ROS2SmolVLA (arXiv 2608.23320); SCOPE (ACM/IEEE HRI 2026); compact VLM deployment trade-offs (IPDPSW 2026).
- Electron web-embeds guide (github.com/electron/electron).
