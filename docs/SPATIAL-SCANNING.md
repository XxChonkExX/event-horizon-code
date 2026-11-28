# Spatial scanning: 3D scanners and depth cameras on EHC's sensor bus

*Research memo for Event Horizon Code (EHC) - 2026-11-27. Scope: 3D scanning as a first-class sensor class in the physicalization totem, with disabled users as a primary lens. Sections 1-2 are a sourced survey; sections 3-4 are a design - none of the scanner code in them exists. The sensor bus they plug into (`src/server/sensorBus.ts`) was being written by another session while this was researched; its types, routes and limits are quoted as read at about 17:05 and may have moved since. Legend: **measured** = read off the reference machine today, command quoted; **(unverified)** = single source, forum post, or not confirmed on a primary page; **(not re-verified)** = taken from memory or a secondary list. Prices are USD as listed at the cited store on the cited date, before tax; sale prices say so.*

## Short version

1. **RealSense is not dead.** It left Intel on 2025-07-11 (RealSense, Inc., $50M Series A) and Cognex signed to buy it for about $500M on 2026-09-22 (close expected Q4 2026). The D400 line grew (D456, D457, D555 PoE, D585 Pro). One refurbisher blog still says Intel "wound down" development - contradicted by the vendor's product list.
2. **No scanner was attached to the reference machine today**, so the operator's device is unidentified (section 0). The plan is device-agnostic and starts with a path that needs no hardware at all.
3. **Prove it with** an RGB-D camera that computes depth on the camera and is UVC-compliant (Orbbec Gemini 335-class, RealSense D435/D455/D405, Orbbec Femto Bolt), read by a stdio sidecar through the vendor SDK v2 Python binding, with OpenCV `CAP_OBSENSOR` as the no-SDK fallback. Not ZED (NVIDIA-only SDK, and this machine has no NVIDIA GPU). Not a handheld (no live API - they export files).
4. **The Observation carries a bounded JSON summary, never points.** Points live in a binary file that the Observation references through the bus's `ref` field, which is a string. Measured: 200,000 points are **17.73 MB** as JSON objects and **2.86 MB** as binary PLY (6.2x); gzipped JSON is still 1.9x the PLY.
5. **Retention none by default, server-enforced.** The bus keeps a 200-entry in-memory ring and no files; keeping a scan is a per-capture action with a server-held grant. A scan captures bystanders and is biometric-adjacent.
6. **Viewer:** phase 1 is zero-dependency WebGL2, which is how `ShaderBackground.tsx` already draws. Add three.js (MIT) only when meshes with textures (GLB, USDZ) must load. Babylon.js (Apache-2.0) is not needed for a viewer.
7. **No new agent tool and no new bus routes are needed.** `src/server/sensorBus.ts` already has start, stop, observe and watch routes and an always-asks `sensor_observe` tool; a scanner registers as a source. **Core** = that source, a simulated depth source, bounded observations, keep and delete, the viewer, the ROS 2 bridge mapping. **Premium candidates** = photogrammetry/NeRF/3DGS, meshing + print prep, multi-scan registration, people scrubbing, semantic 3D labels, hand-eye and collision meshes.
8. **This machine cannot run most vendor heavy stacks.** ZED SDK, Creality Scan, Shining 3D EXScan/FreeScan, Meshroom dense and gsplat need NVIDIA CUDA; it has an AMD and an Intel GPU. Only **5.5 GB of 63 GB RAM was free** while training ran. CPU Open3D plus the Orbbec/RealSense/Revopoint stacks are what work here.

---

## 0. What was measured on the reference machine (2026-11-27)

| Fact | Value | How |
|---|---|---|
| OS, CPU | Windows 11 Home 10.0.26300; AMD Ryzen 9 7900X, 12 cores / 24 threads | `Get-CimInstance Win32_OperatingSystem`, `Win32_Processor` |
| RAM | 63.0 GB total, **5.5 GB free** (the training workload is resident) | `Win32_OperatingSystem` |
| GPUs | AMD Radeon RX 7900 XTX (driver 32.0.31021.6002); Intel Arc Pro B70 (32.0.101.9175); AMD Radeon integrated graphics (32.0.21043.12001); one virtual display adapter. **No NVIDIA GPU.** | `Get-CimInstance Win32_VideoController` |
| Depth cameras or scanners attached | **(updated 2026-11-27)** `Creality CR-Scan Ferret` (`USB\VID_2BC5&PID_069C`, Orbbec; `CR-Scan Ferret Depth Camera`, `CR-Scan Ferret IR Camera`, `CR-Scan Ferret RGB Camera`, class Camera, OK) in addition to `PimaxSensor`, `HD Pro Webcam C920`. See "H4 live test" below. | `Get-PnpDevice -PresentOnly` |
| USB | AMD xHCI (USB 3.10 / 3.20), ASMedia USB 3.20 xHCI, USB4 host router. Which physical ports are USB 2.0 only was not checked | same |
| Renderer engine (at measurement time) | Electron 42.11.18 = Chromium 148 | `node_modules/electron/dist/version`; electronjs.org release post | **EHC now ships Electron 45.5.0 = Chromium 156** |
| Renderer today | WebGL2 already used dependency-free (`src/renderer/ShaderBackground.tsx`, opt-in, default off). No 3D library; 6 runtime dependencies | `grep "getContext("` in `src/renderer`; `package.json` |
| Pop-out kinds allowlisted | `terminal`, `chat`, `camera` (`window:popout` in `src/main/index.ts`) | grep `popout` |
| Sensor bus (in flux) | `src/server/sensorBus.ts` appeared during this research (last write 17:03; another session's work). As read: `Observation { source, kind, t, seq, payload, ref?: string }`; payload cap 64 KB, a larger payload is replaced by a truncated notice; history is a 200-entry in-memory ring; source ids must match `[a-z0-9][a-z0-9_-]{0,39}`; at most 8 watches, interval at least 2 s, length at most 30 min; a token-gated loopback TCP bridge (`ehc-bridge/1`) with a 256 KB line cap and 20 lines per second | read; `scripts/test-sensorbus.ts` |
| Bus routes and tool (in flux) | `GET /api/sensors`; `POST /api/sensors/:id/start`, `/stop`, `/observe` and `/watch`; `POST /api/sensors/stop-all`; `GET /api/sensors/observations`. Agent tool `sensor_observe { source, question }`, in the always-ask list | grep `/api/sensors` in `src/server/http.ts`; `src/server/agentTools.ts`; `src/server/approvals.ts` |
| Python on this machine | 3.14.5, 64-bit, `%LOCALAPPDATA%\Programs\Python\Python314`. Has numpy, scipy, opencv-python, torch, torchvision, onnxruntime, scikit-learn. **No** open3d, laspy, pye57, pyrealsense2, pyorbbecsdk, trimesh. `python` is not on PATH (the `py` launcher is) | `python.exe -c "import importlib.metadata ..."` |
| Other tooling | `wsl.exe` present. No ros2, docker, colmap, meshroom, blender, CloudCompare or pdal on PATH | `Get-Command` |
| Download allowlist | `github.com` and `huggingface.co` only (plus redirect suffixes and install pages); catalog rows are SHA-256 pinned | `src/shared/externals.ts`, `src/server/sensory-catalog.ts` |

Consequences that shape everything below:

- **CUDA-only software is out here**: ZED SDK (any function, "including for recording SVO files"), Creality Scan on Windows, Shining 3D EXScan and FreeScan, Meshroom's dense stage, gsplat.
- **The scanner is a source on the bus, not a new kind of bus.** Start, stop, observe and watch already exist and the agent already has `sensor_observe`; only probing devices, keeping, importing and previewing are scanner-specific.
- **The sidecar's Python dependencies come from PyPI, which EHC may not download from.** They have to arrive by the user's own hand ("the user's existing stack" rung) or as a GitHub-release bundle pinned in the catalog.
- **RAM headroom is below every vendor minimum** (16-32 GB) while training runs. A scan session must check headroom first, as `npm run pack` already does.

To identify the operator's scanner once it is plugged in (read-only):

```powershell
Get-PnpDevice -PresentOnly | Where-Object { $_.FriendlyName -match 'RealSense|Orbbec|Astra|Gemini|Femto|Kinect|ZED|Luxonis|OAK|Revopoint|Creality|EinScan|FreeScan|Depth|3D|Scanner' } | Select-Object Class, FriendlyName, InstanceId
```

---

## 1. Device landscape 2026

Legend for "Cloud?": **none** = works with no cloud; **hybrid** = both; **cloud** = requires it.

### 1a. Depth cameras

| Name | Class | Output | OS | SDK/API | Licence | Cloud? | Source URL |
|---|---|---|---|---|---|---|---|
| RealSense D405 | Active stereo, depth computed on the camera (D4 ASIC); global shutter; ideal 7-50 cm; $325 | Depth map, IR, RGB; point cloud on host | Windows, Ubuntu, macOS (partial), Jetson, Android | librealsense2 2.59.2 (C/C++, `pyrealsense2`, C#, ROS 2 `realsense2_camera` 4.59.2) | SDK and ROS wrapper Apache-2.0; hardware proprietary | none | https://www.realsenseai.com/products/ |
| RealSense D415 | Rolling shutter; 65 x 40 deg; 40 cm-3 m; $325 | same | same | same | same | none | https://www.realsenseai.com/products/ |
| RealSense D435, D435i (+ D435f, D435if, D436) | D430 series: global shutter, 87 x 58 deg, widest field of view; D435 $375 (no IMU), D435i $399 (IMU), D435f $399, D435if $425, D436 $425 | same | same | same | same | none | https://www.realsenseai.com/product-family/430-series/ |
| RealSense D455 (+ D455f, D456, D457) | D450 series: 95 mm baseline, 60 cm-6 m; $499 / $525 / $560 (IP65) / $599 (GMSL/FAKRA, not USB) | same | same | same | same | none | https://www.realsenseai.com/product-family/450-series/ |
| RealSense D555 PoE | Ethernet with power over one cable, IP65, 1280x720 at 90 fps, "native ROS 2 streaming over Ethernet"; $649 | same | Windows, Linux (Ubuntu) | librealsense2 | Apache-2.0 | none | https://www.realsenseai.com/product-family/555-series/ |
| RealSense D585 Pro | Flagship, "AI-native depth", 12 cm-10 m+; not on the store at the 2026-10 check; specifications **(unverified)** | depth | - | - | - | none | https://www.realsenseai.com/product-family/pro-series/ |
| Orbbec Gemini 335 | Active and passive stereo, depth computed on the camera (MX6800 ASIC); 50 mm baseline; ideal about 0.3-3 m; 1280x800 at 30 fps; global shutter; under 1.5% at 2 m; 97 g; **UVC-compliant**; $264 | Depth map, IR, RGB, IMU; point cloud via SDK | Windows 10+, Linux x64 (Ubuntu 20.04/22.04/24.04), Linux ARM64 (Jetson), macOS (tested M2), Android 13 | Orbbec SDK v2 2.10.6 (C/C++), `pyorbbecsdk2`, OpenCV `CAP_OBSENSOR`, ROS 2 `orbbec_camera` 2.10.7 | SDK MIT (plus a proprietary extension library usable with Orbbec products only); ROS wrapper Apache-2.0 | none | https://store.orbbec.com/products/gemini-335 |
| Orbbec Gemini 336, 335L, 336L | 336 = 335 with IR-pass filter, $284; 335L = 95 mm baseline, IP65, ideal 0.25-6 m, under 0.8% at 2 m, $359; 336L $379 | same | same | same | same | none | https://www.orbbec.com/gemini-330-series/ |
| Orbbec Gemini 305, 305g | Entry stereo; $229 / $279; specifications not retrieved | depth | same | Orbbec SDK v2 | same | none | https://store.orbbec.com/collections/stereo-vision-camera |
| Orbbec 335Lg, 338Lg, 335Le, 338Le, 435Le | Rugged variants: GMSL2 or Gigabit Ethernet with PoE; **not UVC**; 435Le: 95 mm baseline, ideal 0.31-10 m, 1280x800 at 10 fps, IP67; $429 / $429 / $464 / $464 / $499 | depth, RGB, IMU | Windows, Linux | Orbbec SDK v2 | same | none | https://www.orbbec.com/gemini-435le |
| Orbbec Femto Bolt | Time of flight with Microsoft's Azure Kinect technology; NFOV 640x576 at 30 fps (0.5-3.86 m), WFOV 1024x1024 at 15 fps (0.25-2.21 m); 4K RGB; IMU; **depth processed on the host**; typical error under 11 mm + 0.1% of distance; indoor 10-25 C; USB-C 3.2; **UVC-compliant**; $418 | Depth map, IR, RGB, point cloud | Windows, Linux, macOS | Orbbec SDK v2, Orbbec SDK K4A Wrapper | MIT SDK | none | https://www.orbbec.com/products/tof-camera/femto-bolt |
| Orbbec Femto Mega, Mega I | Networked (Ethernet/PoE) versions of the same time-of-flight engine; $695 / $1,995 | same | Windows, Linux | Orbbec SDK v2 | MIT SDK | none | https://store.orbbec.com/collections/tof-camera |
| Orbbec Astra, Gemini E, DaBai, Gemini 2 XL (older) | OpenNI protocol; served by the closed pre-built SDK v1; firmware migration to UVC began with SDK v2.5.5 (October 2025) and splits devices by firmware major version | depth | Windows, Linux | Orbbec SDK v1 | proprietary | none | https://orbbec.github.io/OrbbecSDK_v2/ |
| Stereolabs ZED 2i | Passive stereo camera; **depth is computed on an NVIDIA GPU in the host**; USB 3.1; IP66; $499 | Left/right video (UVC), depth map, point cloud, pose, spatial map (SDK) | Windows 10/11, Ubuntu LTS, Jetson; **no macOS** | ZED SDK 5.6 (C++, Python, C#, C), ROS 2 `zed_wrapper` | SDK proprietary (Stereolabs Software and Services License Agreement); samples MIT; ROS 2 wrapper Apache-2.0 | none | https://www.stereolabs.com/store/products/zed-2i |
| Stereolabs ZED X, ZED Mini | ZED X: GMSL2, needs a Jetson plus a ZED Link capture card or a ZED Box; $599 and $569 (reseller-listed **(unverified)**) | same | Jetson (ZED X), Windows/Ubuntu (ZED Mini) | same | same | none | https://www.roboticscenter.ai/guides/robot-vision/zed-camera-guide |
| Luxonis OAK-D S2 family (not in the brief; noted) | Stereo depth computed on the device (Myriad X, 4 TOPS); 75 mm baseline, ideal 0.7-12 m; USB 2/3; $329. Also OAK-D Lite $269, OAK-D Pro $429, OAK-D W $429, OAK-D LR $779, OAK 4 D (Linux, IP67, 52 TOPS) $1,049 | Depth, RGB, neural-network results | Linux, macOS, Windows | DepthAI 3.12.2 (Python 3.9+, C++) | MIT | none | https://shop.luxonis.com/collections/oak-cameras-col |

### 1b. Handheld scanners

| Name | Class | Output | OS | SDK/API | Licence | Cloud? | Source URL |
|---|---|---|---|---|---|---|---|
| Revopoint POP 3 | Handheld structured-light scanner; up to 0.1 mm accuracy, 18 fps; $593 (sale, list $659); **listed out of stock on 2026-11-10**, replaced by POP 3 Plus / POP 4 | Fused point cloud, mesh, textured mesh; PLY, OBJ, STL | Windows x86_64, macOS ARM64, Android, iOS; **no Linux** | None public for the handheld line **(unverified)**; a C++ SDK exists only for Revopoint's industrial area-scan cameras | Revo Scan free, proprietary | none | https://global.revopoint3d.com/products/portable-3d-scanner-pop3 |
| Revopoint POP 3 Plus, POP 4 | $526 / $671 (sale). POP 4 adds blue-laser and near-infrared modes, Wi-Fi 6, 3D Gaussian Splat export (`.splat`), STL/OBJ/3MF export | same | same | none | same | none | https://www.revopoint3d.com/products/portable-3d-scanner-pop3 |
| Revopoint MIRACO, MIRACO Pro, MIRACO Plus | Standalone (screen and battery, no PC needed); up to 4 x 4 x 4 m; up to 0.05 mm accuracy; $1,286 (sale) / $1,583 / $1,869 (sale) | same | Windows, macOS ARM64, iOS, Android | none | same | none | https://global.revopoint3d.com/products/standalone-3d-scanner-miraco |
| Revopoint RANGE 2 (RANGE 3 and 3 Pro are newer) | Large objects and people; up to 0.3 mm accuracy; 253 g; $729 (reseller **(unverified)**) | PLY, OBJ, STL | Windows, macOS, Android, iOS | none | same | none | https://www.revopoint3d.com/blogs/blog/best-revopoint-3d-scanners-guide |
| Revopoint MIRACO 2 | Kickstarter from 2026-11-18, from $1,425, delivery estimated January 2027; exports 1:1 Gaussian splats | mesh, splats | Windows, macOS | - | - | none | https://www.revopoint3d.com/blogs/news/revopoint-launches-miraco-2-on-kickstarter-scan-in-one-create-with-agents |
| Creality RaptorX | Hybrid: 34 crossed + 7 parallel blue laser lines plus near-infrared structured light; up to 0.02 mm; objects 5 mm-4 m; Wi-Fi 6 bridge; $2,629 (list $4,599) | Point cloud, mesh; OBJ, STL, PLY | Windows, macOS (Apple silicon); **no Linux**; Windows wants an NVIDIA GPU with 6 GB **(unverified on AMD/Intel)** | Creality Scan (proprietary); no public SDK found **(unverified)** | Proprietary, free with the scanner | none | https://us.store.creality.com/products/creality-raptorx |
| Creality CR-Scan Raptor, Raptor Pro, Otter, Ferret Pro | $824-879 / $1,274 / $674-899 / $359 (several on sale) | OBJ, STL, PLY | Windows, macOS | none | same | none | https://store.creality.com/products/cr-scan-otter-3d-scanner |
| Shining 3D EinScan H2 | Handheld LED plus infrared structured light; $4,999-$5,299 | Mesh, point cloud; OBJ, STL, PLY | **Windows 10/11 only**; NVIDIA CUDA mandatory | EXScan (free), EXScan O&P (orthotics and prosthetics edition) | Proprietary | none stated | https://support.einscan.com/en/support/solutions/folders/60000496551 |
| Shining 3D Einstar | Entry handheld; $759 | mesh | Windows | EXStar | Proprietary | none stated | https://afinia.com/collections/3d-scanners |
| Shining 3D FreeScan UE Pro (also Combo, Trio) | Blue-laser metrology scanner; no texture; $19,999 | ASC, OBJ, STL, PLY | **Windows only**; NVIDIA GPU with at least 1280 CUDA cores; CPU with AVX | FreeScan (free, USB licence dongle); EXModel and EXMeasure paid | Proprietary | none | https://www.skylab3d.com/products/freescan-ue-pro |

### 1c. Phone LiDAR and apps

| Name | Class | Output | OS | SDK/API | Licence | Cloud? | Source URL |
|---|---|---|---|---|---|---|---|
| Apple ARKit `sceneDepth` | LiDAR depth API (LiDAR-capable iPhone Pro and iPad Pro) | Float32 depth map **256 x 192 at 60 Hz** plus a confidence map | iOS 14+, iPadOS 14+ | ARKit (Swift, Objective-C) | Apple SDK, proprietary, free with a developer account | none | https://developer.apple.com/documentation/arkit/arframe/scenedepth |
| Apple AVFoundation LiDAR depth camera | Depth as a capture device | Streaming depth up to 320 x 240; photo depth up to 768 x 576 | iOS | AVFoundation `AVCaptureDepthDataOutput` | same | none | https://developer.apple.com/videos/play/wwdc2022/110429 |
| Apple ARKit scene reconstruction | Polygon mesh of the room, optionally with per-face classification (floor, table, seat, window, ...) | mesh | iOS 13.4+, LiDAR devices | ARKit | same | none | https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/scenereconstruction |
| Apple RoomPlan | Parametric room model: walls, openings, doors, windows, furniture, appliances; several rooms merged into one structure | Parametric data, USD, USDZ | iOS 16+ | RoomPlan | same | none | https://developer.apple.com/documentation/roomplan |
| Apple Object Capture | Photogrammetry on the phone | USDZ | iOS 18+; LiDAR and A14 or newer | RealityKit `PhotogrammetrySession` | same | none | https://developer.apple.com/documentation/realitykit/scanning-objects-using-object-capture |
| Apple reference-object tracking in iOS 27 (WWDC26) | Finds an object whose USDZ was trained in Create ML; returns poses in metric space | poses | iOS 27 | ARKit `detectionObjects`, `trackingObjects` | same | none | https://developer.apple.com/videos/play/wwdc2026/283 |
| Google ARCore Depth API | Depth from motion, merged with hardware depth where present; 0-65 m, best 0.5-5 m; valid only after the phone moves; white walls imprecise. Over 85% of active ARCore devices support it (2026-11) | Depth image, raw depth, reprojection to points | **Android only** | ARCore SDK (Java, NDK, Unity) | Apache-2.0 | none | https://developers.google.com/ar/develop/depth |
| Polycam | App: LiDAR, photogrammetry, Gaussian splats, floor plans | Mesh (OBJ, FBX, DAE, GLTF, STL, USDZ); point cloud (LAS, PLY, PTS, XYZ, DXF) on Business and above; free plan exports GLTF only | iOS, Android, web | proprietary | Proprietary, freemium: Basic $150/year, Business $400 per user per year | **hybrid**: LiDAR, Space and Floorplan scans process on the device; Object, 360 and Splats need the cloud; link sharing is cloud | https://learn.poly.cam/hc/en-us/articles/27756102599572-What-File-Types-Can-Polycam-Export |
| Scaniverse (Niantic Spatial) | App: LiDAR, photogrammetry, Gaussian splats | Mesh (OBJ, FBX, GLB, USDZ, LAS); splats (PLY, SPZ). No direct STL | iOS, Android | proprietary | "Classic" mode free; cloud tiers $20 and $50 per month | **hybrid**: Classic processes entirely on the device; the newer platform is cloud | https://dev.scaniverse.com/support |
| Matterport Pro3 | LiDAR plus 360-degree camera tied to a cloud service; $3,995 | Dollhouse mesh; E57 is a paid add-on and needs a Pro camera | iOS, Android (capture app) | Matterport cloud | Proprietary; Pro3 needs a Professional plan or higher | **cloud** - every model is processed and hosted on Matterport's servers, usually for hours | https://support.matterport.com/s/article/FAQ-Pro3-Camera |

### 1d. Survey-grade laser scanners and their software

| Name | Class | Output | OS | SDK/API | Licence | Cloud? | Source URL |
|---|---|---|---|---|---|---|---|
| Leica BLK360 (current G2) | Imaging laser scanner on a tripod; 4 mm at 10 m; 0.5-45 m; up to 680,000 points/s; $26,500 | Registered point cloud: E57, LGS, RCP, PTS, PTX, LAS; HDR photospheres | Capture control from iOS and Android (free BLK Live app can export E57); office work on Windows | Cyclone REGISTER 360 PLUS (BLK Edition) | Proprietary; REGISTER 360 PLUS subscription $5,100 (shop listing) | **hybrid**: BLK Live is local; 500 GB of Hexagon GeoCloud for 6 months is bundled | https://shop.leica-geosystems.com/reality-capture/blk360/buy |
| Leica BLK2GO | Handheld SLAM scanner; $37,500 | point cloud | same | same | Proprietary | hybrid | https://shop.leica-geosystems.com/reality-capture/shop |
| FARO Focus Premium | Terrestrial laser scanner; kits $58,000-$84,000 (reseller-listed) | FLS, FWS, LSProj (proprietary); E57 export | Windows (SCENE) | proprietary | Proprietary | none stated | https://www.3dmag.com/3d-scanners/3d-laser-scanner-for-buildings-price-2026 |
| Artec Ray II | Long-range laser scanner; $97,800 (listed) | point cloud, mesh | Windows | proprietary | Proprietary | none stated | https://www.3dmag.com/3d-scanners/3d-laser-scanner-for-buildings-price-2026 |

### 1e. Reading the landscape

- **RealSense corporate status, from primary sources.** Spin-out: 2025-07-11, RealSense, Inc., $50M Series A with Intel Capital and the MediaTek Innovation Fund. Acquisition: Cognex press release and SEC Form 8-K of 2026-09-22, about $500M cash, expected to close in Q4 2026, with the facial-authentication line spun out first. The SDK moved to `github.com/realsenseai/librealsense`; the old `IntelRealSense` links redirect, but the README says "we cannot guarantee how long it will remain active". A PCN of 2026-02-27 swaps Intel user guides for RealSense ones from about April 2026.
- **Where depth is computed decides what runs on this machine.** On camera: RealSense D400, Orbbec Gemini 330 series, Luxonis OAK. On host GPU, NVIDIA only: ZED. On host CPU: Femto Bolt.
- **UVC is the "generic" in "generic UVC depth camera".** UVC-compliant: Gemini 330 series, Femto Bolt, ZED (stereo images only). Not UVC: 33xLg, 33xLe, 435Le (GMSL2 or Ethernet). Luxonis speaks DepthAI instead.
- **Handheld scanners are file producers, not devices.** None of the three vendors publishes a live API for its handheld line that this research could find. They differ in host requirements: Revopoint runs on CPU (GPU optional, 16 GB minimum for POP 3-class, 32 GB minimum for POP 4, INSPIRE 2, Metro and Trackit); Creality Scan and Shining 3D need CUDA.
- **Price classes.** Depth cameras $229-$649. Consumer handhelds $359-$2,629. Metrology handhelds $4,999-$19,999. Tripod laser scanners $26,500-$97,800, before software subscriptions.

---

## 2. Open SDKs, processing and formats

### 2a. SDK and processing inventory

| Name (version checked) | What it does | Licence | Windows | Linux | macOS | Notes for EHC | Source URL |
|---|---|---|---|---|---|---|---|
| librealsense2 2.59.2 | RealSense SDK; intrinsics, depth scale, alignment, sync | Apache-2.0 | yes | yes (Ubuntu, `dkms` package) | listed as "macOS High Sierra"; "full feature support varies by platform" | Depth comes from the camera, so no GPU needed | https://github.com/realsenseai/librealsense |
| `pyrealsense2` 2.59.2.11152 | Python binding | Apache-2.0 | yes: `win_amd64` wheels for Python 3.9-3.14 | yes (x86-64, ARM64) | not listed | Fits the machine's Python 3.14 | https://pypi.org/project/pyrealsense2 |
| `realsense2_camera` 4.59.2 | ROS 2 driver | Apache-2.0 | "not meant to be supported on Windows" | Humble, Jazzy, Kilted, Lyrical | no | Bridge target | https://github.com/realsenseai/realsense-ros |
| Orbbec SDK v2 2.10.6 | Orbbec SDK, C/C++ | MIT, plus a proprietary extension library (binaries in `extensions/`; free for personal, academic and commercial use with Orbbec products; no reverse engineering) | yes | yes (Ubuntu 20.04/22.04/24.04, Jetson) | tested on M2 | Depth on camera | https://github.com/orbbec/OrbbecSDK_v2 |
| `pyorbbecsdk2` | Python binding (import name `pyorbbecsdk`) | same repo **(assumed, unverified)** | yes: wheels for Python 3.8-3.14 | yes | yes (Apple Silicon) | Windows needs a one-time metadata registration that elevates to administrator. The old `pyorbbecsdk` package is deprecated; its Windows wheel shipped macOS binaries (issue 194) | https://github.com/orbbec/pyorbbecsdk |
| `orbbec_camera` 2.10.7 | ROS 2 driver | Apache-2.0 | no | Foxy, Humble, Jazzy, Lyrical, Rolling | no | Bridge target; ships `orbbec_description` (URDF) | https://github.com/orbbec/OrbbecSDK_ROS2 |
| OpenCV 4.x (4.10 or newer) | `cv.VideoCapture(0, cv.CAP_OBSENSOR)` reads Orbbec UVC depth without installing the Orbbec SDK; exposes fx, fy, cx, cy | Apache-2.0 | yes | yes | needs a source build with `-DOBSENSOR_USE_ORBBEC_SDK=ON` since 4.11 | Already installed in the machine's Python: the no-SDK fallback | https://docs.opencv.org/4.x/d1/d33/tutorial_orbbec_uvc.html |
| DepthAI 3.12.2 | Luxonis OAK SDK | MIT | yes | yes | yes | Later backend | https://pypi.org/project/depthai/ |
| ZED SDK 5.6 (2026-11-16) | Stereolabs SDK | Proprietary | Windows 10/11 | Ubuntu LTS, Jetson | no | Needs an NVIDIA GPU with compute capability 7.5 or newer; WSL unsupported ("USB camera passthrough is unreliable") | https://docs.stereolabs.com/docs/development/zed-sdk/supported-platforms |
| `zed-ros2-wrapper` | ROS 2 driver | Apache-2.0 | no | Humble, Jazzy, Lyrical | no | Linux and NVIDIA only | https://github.com/stereolabs/zed-ros2-wrapper |
| Open3D 0.20.0 (2026-09-16) | Point-cloud and mesh processing: voxel downsample, statistical outlier removal, normals, `segment_plane` (RANSAC), `cluster_dbscan`, oriented bounding boxes, ICP, TSDF, Poisson reconstruction, convex hull | MIT | yes: `win_amd64` wheels for Python 3.10-3.14 (79.3 MB) | yes (CUDA wheel) | yes | CPU is enough for bounded clouds. `open3d-xpu` adds Intel GPUs; no AMD backend is listed **(absence of evidence)**. `cluster_dbscan` precomputes neighbours and "can require a lot of memory" for a large epsilon | https://www.open3d.org/docs/latest/getting_started.html |
| PCL | The C++ point-cloud library behind ROS 2 | BSD-3-Clause | builds | yes | builds | Heavy; reached through ROS 2 rather than directly | https://github.com/PointCloudLibrary/pcl |
| COLMAP | Structure from motion and multi-view stereo | BSD-3-Clause (dependencies may differ) | binaries on GitHub releases | yes | builds | Without CUDA everything works except dense reconstruction; CPU mode is "a significant slow-down" and RAM-hungry | https://colmap.github.io/faq.html |
| Meshroom 2025.1.0 | Node-based photogrammetry | MPL-2.0 | yes | yes | no official release | Dense depth maps need an NVIDIA GPU; without one only "Draft Meshing" works. An unofficial ZLUDA build for AMD exists | https://github.com/alicevision/Meshroom/releases |
| Nerfstudio | NeRF and Gaussian Splat training | Apache-2.0 | Linux-oriented **(not re-verified)** | yes | partial | Needs a CUDA GPU in practice **(not re-verified)** | https://github.com/nerfstudio-project/nerfstudio/issues/2684 |
| 3D Gaussian Splatting (INRIA) | Original implementation | **Non-commercial research licence** | - | - | - | Not for a product | https://github.com/nerfstudio-project/nerfstudio/issues/2684 |
| gsplat | CUDA rasteriser for Gaussian splats | Apache-2.0 | - | yes | - | CUDA only | https://github.com/nerfstudio-project/gsplat |
| MeshLab 2025.07, PyMeshLab 2025.7 | Mesh cleaning and repair | GPL-3.0 | yes | yes | yes | External tool only; never link | https://www.meshlab.net/ |
| Blender | Mesh editing | GPL **(not re-verified; blender.org returned HTTP 403)** | yes | yes | yes | External tool only | https://www.blender.org/about/license/ |
| CloudCompare | Point-cloud viewing, comparison, conversion (E57, LAS, PLY and more) | GPL-2.0-or-later | yes | yes | yes | External tool only | https://github.com/CloudCompare/CloudCompare |
| PDAL | Point-cloud translation pipelines | BSD **(not re-verified)** | builds | yes | builds | Heavy import and conversion | https://pdal.org/en/latest/about.html |
| `laspy` 2.7.0 | Read and write LAS 1.0-1.5; LAZ through `lazrs` or `laszip`; chunked reading | BSD-2-Clause | yes | yes | yes | Light import path for LAS/LAZ | https://pypi.org/project/laspy |
| `pye57` 0.4.19 | Read and write E57 (wraps libE57Format) | MIT | yes | yes | yes | Light import path for E57 | https://github.com/skand-io/pye57 |
| three.js | WebGL2 and WebGPU renderer with loaders | MIT | n/a | n/a | n/a | Viewer, phase 2 | https://threejs.org/docs/pages/PLYLoader.html |
| Babylon.js | Full engine: GUI, inspector, physics, WebXR | Apache-2.0 | n/a | n/a | n/a | Not needed for a viewer | https://github.com/BabylonJS/Babylon.js |

### 2b. What actually runs on the reference machine

| Stack | Runs here? | Why |
|---|---|---|
| Orbbec SDK v2, `pyorbbecsdk2`, OpenCV `CAP_OBSENSOR` | **Yes** | Depth on camera; wheels for Python 3.14; OpenCV already installed |
| librealsense2, `pyrealsense2` | **Yes** | Depth on camera; `cp314` `win_amd64` wheel exists |
| Luxonis DepthAI | **Yes** (not installed) | Depth on device; MIT |
| ZED SDK | **No** | "Cannot run on machines without a compatible NVIDIA GPU" |
| Revo Scan 6 (Revopoint) | **Yes on CPU, if RAM allows** | GPU optional for POP 3-class scanners; minimum 16 GB RAM. GPU fusion is enabled only on an enumerated list of RTX 20/30/40 and RX 6600/6750/7700/9060/9070 cards; the RX 7900 XTX is not named |
| Creality Scan | **No** (Windows needs NVIDIA) | Third-party requirement table **(unverified on AMD)** |
| Shining 3D EXScan, FreeScan | **No** | "NVIDIA graphics card is mandatory"; "AMD graphics cards are not supported" |
| Meshroom dense, COLMAP dense, gsplat, Nerfstudio | **No** | CUDA |
| COLMAP sparse (CPU), Meshroom Draft Meshing, Open3D on CPU | **Yes** | No CUDA needed; slower |

### 2c. Formats

| Format | Holds | Standard and licence | Size facts | Role in EHC |
|---|---|---|---|---|
| PLY (binary, little-endian) | Points and/or triangle mesh; vertex colours; custom properties | De facto spec (Stanford); no licence burden | Measured: 15 bytes per point with colour; 200,000 points = 2.86 MB. Read by Open3D, CloudCompare, MeshLab, three.js `PLYLoader`, every handheld scanner | **Canonical sidecar file for point clouds** (and simple meshes) |
| Raw depth frame | 16-bit depth map plus intrinsics | - | Measured: 848x480 = 814,080 bytes; 1280x800 = 2,048,000 bytes | Internal to the sidecar; never crosses the bus |
| PCD | PCL point cloud; LZF compression | PCL, BSD | - | Optional, for ROS 2 tools |
| OBJ (+ MTL) | Mesh with materials; several files | De facto | Larger than GLB | Import only |
| STL | Triangle mesh; no colour, no units | De facto | - | Export only, for slicing |
| 3MF | Mesh with units, materials, print settings | 3MF Consortium | - | Export, for print prep (premium) |
| GLB / glTF 2.0 | Mesh, PBR materials, textures in one binary file | Khronos, royalty-free; ISO/IEC 12113:2022 | Draco and meshopt compression | **Canonical sidecar file for textured meshes** the viewer renders |
| USD / USDZ | Composable scene description; USDZ is the packaged form used by Apple AR | OpenUSD under TOSTL-1.0 (Apache-2.0 text with a different trademark clause) | - | Import (RoomPlan, Object Capture, Scaniverse); export in premium |
| E57 | Point clouds, images, poses, sensor metadata; structured scans | ASTM E2807 (the standard text is sold; implementations are free) | Vendor-neutral. Terrestrial-scan files are large: one estimate puts a single room at 2-8 GB **(unverified)** | Import only, through `pye57`; never loaded by the viewer directly |
| LAS / LAZ | Geospatial LiDAR points | ASPRS LAS 1.4 R15 (LAS 1.5 supported by `laspy` 2.7.0); LAZ 1.4 is an OGC Community Standard since 2026-09-03. LASzip is Apache-2.0 in its repository; older releases were LGPL-2.1 or later - check the version shipped | LAZ is 7-20% of LAS, lossless | Import and export for geospatial work only |
| OctoMap (`.bt`, `.ot`) | Probabilistic occupancy octree | BSD-3-Clause | Compact | Robot navigation maps (premium) |
| SPZ, `.splat` | Compressed Gaussian splats | SPZ is published by Niantic **(licence unverified)** | - | Premium |
| NPY / NPZ | NumPy arrays | BSD | Fast, local | In-process only, never a kept artefact |

### 2d. Measured: JSON against binary

Node, in memory, 200,000 random points with four-decimal coordinates and 8-bit colour (no file was written):

| Encoding | Size | Serialize | Parse |
|---|---|---|---|
| JSON array of `{x,y,z,r,g,b}` objects | **17.73 MB** | 86 ms | 61 ms |
| JSON columnar `{x:[], y:[], ...}` | 12.77 MB | 54 ms | - |
| Binary PLY, float32 xyz + uint8 rgb (15 bytes per point) | **2.86 MB** (208-byte header) | - | - |
| Raw float32 xyz only (12 bytes per point) | 2.29 MB | - | - |
| gzip of the JSON array | 5.35 MB | - | - |
| gzip of the PLY | 2.49 MB | - | - |

JSON objects are 6.2x the PLY, and compressing the JSON still leaves it 1.9x larger than the uncompressed binary.

Raw depth bandwidth, before infrared and colour streams:

| Depth frame | Bytes | At 30 fps | At 90 fps |
|---|---|---|---|
| 320 x 240, 16-bit | 153,600 | 4.4 MB/s | - |
| 640 x 400, 16-bit | 512,000 | 14.7 MB/s (7.3 MB/s at 15 fps) | - |
| 848 x 480, 16-bit | 814,080 | 23.3 MB/s | 69.9 MB/s |
| 1280 x 720, 16-bit | 1,843,200 | 52.7 MB/s | 158.2 MB/s |
| 1280 x 800, 16-bit | 2,048,000 | 58.6 MB/s | - |

### 2e. Recommendations

1. **Binary sidecar files, referenced from the Observation.** PLY for point clouds, GLB for textured meshes. The bus, the prompt and the audit log never carry points.
2. **Processing in Open3D on the CPU**, installed by the user into their own Python (the machine has 3.14 with numpy and OpenCV already). Open3D's reader list does not include E57 or LAS; use `pye57` and `laspy[lazrs]` for those.
3. **Import, do not adopt:** MeshLab, Blender and CloudCompare are GPL tools the user runs themselves. EHC reads and writes their files.
4. **Vendor SDKs stay out of process.** librealsense2 and Orbbec SDK v2 are permissively licensed, but they are native libraries with device state; they belong in the sidecar, never in the Electron app.
5. **Licence checks before pinning anything**, in line with `docs/SENSORS.md`: the INRIA 3DGS code is non-commercial; WebODM and OpenSplat are AGPL **(not re-verified)**; LASzip's licence changed over releases.

---

## 3. EHC adoption plan

### 3a. Where a scanner sits in the sensor bus

```
source                        sidecar (own process)                      bus (src/server/sensorBus.ts)               consumers
---------------------------   -----------------------------------------   ------------------------------------------   ------------------------------
UVC RGB-D camera          ->  backend ladder: SDK v2, then OpenCV     ->  a registered SensorSource "scanner"        ->  agent tool sensor_observe (asks every use)
handheld export (PLY,       deproject, voxel, planes, DBSCAN,            observe() returns { kind, payload, ref }    ->  Scanner window (viewer)
OBJ, STL, GLB)              boxes, text template                        pushObservation() stamps t and seq,         ->  watches (no faster than every 2 s)
phone export (USDZ,                                                     caps payload at 64 KB, keeps a ring of 200  ->  ehc_bridge (ROS 2)
PLY, LAS)                   binary: ~/.eventhorizon/scans/<session>/     bridge: token-gated loopback TCP, push only
E57 / LAZ
```

It follows the six invariants in `docs/SENSORS.md` unchanged: off until started, observations not streams, nothing leaves the machine, sensing and actuating are separate gates, the ladder, and perception out of process.

### 3b. The `scanner` source class and the Observation schema

`src/server/sensorBus.ts` defines `Observation = { source, kind, t, seq, payload, ref? }`. The bus stamps `t` and a bus-wide `seq`, replaces any payload over 64 KB with a truncated notice, and keeps the last 200 observations in memory - that is what "retention none" means in code. `ref` is an optional string, cut to 512 characters when it arrives over the bridge, so the scanner describes its file inside the payload and uses `ref` for a short id.

```ts
// What the scanner puts in an Observation. source, t and seq are the bus's.
type ScanRef = `ply:${string}`;   // the format and the first 16 hex digits of the file's sha-256

type ScanArtefact = {            // only when a file exists: a live preview or a kept scan
  id: string;                    // full sha-256: identity and integrity
  rel: string;                   // path relative to the scan root, never absolute
  format: "ply" | "glb" | "stl" | "obj" | "usdz" | "e57" | "laz";
  bytes: number;
  points?: number;
  lifetime: "preview" | "kept";
};

// payload of a scan.* observation: ScanArtefact under "artefact", plus the kind-specific fields
type ScanPayload = { artefact?: ScanArtefact } & Record<string, unknown>;

// The source is registered as id "scanner" (ids must match [a-z0-9][a-z0-9_-]{0,39});
// the device's name and ids travel in the payload, not in the source id.
```

Kinds and bounds:

| Kind | Produced when | Payload holds | Bounds |
|---|---|---|---|
| `scan.frame` | Each preview tick or capture | points raw and voxel-filtered, valid-pixel ratio, range, voxel size, depth profile, timing | 1 KB |
| `scan.scene` | On `observe` or a watch tick | planes, clusters with oriented boxes, clearances, one text line | 8 KB, 32 objects, 8 planes |
| `scan.mesh` | After an import or a handheld export | vertices, triangles, bounding box, watertight flag, estimated units | 1 KB |
| `scan.device` | Start, stop, loss of device, USB fell back to 2.0; pushed by the scanner module, not an answer to `observe` | state, reason | 0.5 KB |
| `scan.error` | Any failure | what was tried, what to do | 1 KB |

Example `scan.scene` payload (illustrative numbers, not from a capture):

```json
{
  "units": "m",
  "frame": "camera-optical",
  "stats": { "pointsRaw": 407040, "pointsVoxel": 61234, "voxelM": 0.01, "validRatio": 0.62, "rangeM": [0.28, 4.9], "planeResidualMm": 4.1, "elapsedMs": 240 },
  "planes": [ { "id": "plane-0", "kind": "support", "n": [0.01, 0.99, -0.02], "d": 0.74, "areaM2": 0.81, "inlierRatio": 0.33 } ],
  "objects": [ { "id": "obj-3", "label": "unknown", "shape": "box", "center": [0.12, 0.79, 1.21], "sizeM": [0.31, 0.29, 0.30], "support": "plane-0", "distanceM": 1.23, "side": "right", "points": 1840 } ],
  "clearance": { "floorCorridorM": 0.9, "direction": "left" },
  "artefact": { "id": "9f2c71e0a4b8d31c6e5f7092ab8cd4ef1a3b5c7d9e0f2a4b6c8d0e1f2a3b4c5d", "rel": "s3/preview.ply", "format": "ply", "bytes": 918718, "points": 61234, "lifetime": "preview" },
  "text": "Support surface 0.74 m high with 3 objects on it. Nearest: box-like object about 31 x 29 x 30 cm at 1.23 m, right of centre (label unknown: no detector lane). Floor clear about 0.9 m to the left. 62% valid depth pixels."
}
```

Rules:

- **Retention none is two things:** the bus's in-memory ring, and scratch that the scanner overwrites in place and deletes on stop. A file survives only if the user kept it.
- **Kept scans are a ledger kept by the scanner module**, because the bus holds no files. `artefact.lifetime` says `preview` or `kept`.
- **`artefact.rel` is validated against the scan root**, the same containment discipline as the `fs:` operations.
- **One observation per `observe` call.** Preview ticks at most 5 Hz (the bridge accepts 20 lines per second). A watch ticks no faster than every 2 s.
- **The scanner's bounds (8 KB) sit well under the bus cap (64 KB)** on purpose: over the cap, the bus replaces the payload with `{ truncated: true }`, and a scene that silently became that would read to the agent as an empty answer.

### 3c. The sidecar

`src/server/sensorBus.ts` gives a peripheral two entrances, and the scanner can use either:

| Entrance | How it works | Fits |
|---|---|---|
| Registered source (`kind: "process"`) | EHC spawns the sidecar and talks JSON lines on its stdin and stdout. The source's `start`, `stop` and `observe` hooks wrap it; `observe` returns `{ kind, payload, ref }` and the bus does the rest | The depth camera, where the server must ask for captures |
| Loopback bridge (`kind: "bridge"`) | EHC listens on `127.0.0.1` with a per-launch token, written owner-only to `~/.eventhorizon/sensors.json`. The first line must be `{"type":"hello","token":...}`; after that only `{"type":"observation",...}` lines. A line over 256 KB, more than 20 lines per second or a wrong token closes the connection | A process EHC does not spawn: the ROS 2 bridge node, a vendor tool, a phone relay |

The bridge carries observations in one direction, so a scanner that must be asked for captures belongs on the registered-source entrance. The stdio protocol for that entrance, binaries never on stdio (a home such as `integrations/ehc-scan/` is a suggestion; nothing exists there yet):

| Direction | Message | Answer |
|---|---|---|
| server to sidecar | `{"id":1,"op":"probe"}` | available backends, devices (vendor id, product id, name, backend that would claim them, UVC yes or no), Python and library versions, free memory |
| server to sidecar | `{"id":2,"op":"start","device":"...","profile":"desk"}` | the profile actually achieved |
| server to sidecar | `{"id":3,"op":"capture","mode":"frame"}` | one `{ kind, payload, ref }`, which `observe()` hands to the bus |
| server to sidecar | `{"id":4,"op":"import","path":"..."}` | `scan.mesh` plus `scan.scene` |
| server to sidecar | `{"id":5,"op":"stop"}` | scratch deleted |
| sidecar to server | `{"event":"observation",...}`, `{"event":"log",...}` | the scanner module pushes observations to the bus with `pushObservation` |

Keeping is not a sidecar operation: the server copies the artefact the user chose into the folder the user chose (section 3d).

Backend ladder, chosen from the USB vendor and product id:

| Device | Vendor id | Product ids seen | First backend | Fallback | Source of the ids |
|---|---|---|---|---|---|
| RealSense D400 | 0x8086 | D415 0x0AD3; D435 and D435f 0x0B07; D435i and D435if 0x0B3A; D455, D455f, D456 0x0B5C; D405 0x0B5B | `pyrealsense2` | plain 16-bit UVC on Linux only; on Windows an honest error | Intel D400 datasheet, revision 017 |
| Orbbec | 0x2BC5 | Gemini 2 0x0670, Gemini 2 L 0x0673; Gemini 330-series ids not retrieved **(unverified)** | `pyorbbecsdk` | OpenCV `CAP_OBSENSOR` | Orbbec datasheets |
| Stereolabs | 0x2B03 | ZED 2i 0xF880, ZED 1 0xF580 (user-posted `lsusb` logs) | none on this machine | honest error: "ZED SDK needs an NVIDIA GPU" | Stereolabs forum **(unverified)** |
| anything else | - | - | OpenCV `CAP_OBSENSOR` | honest error with the ids, asking for a device profile | - |

Profiles (requests; the sidecar reports what it achieved):

| Profile | Depth | Voxel | Range clip | Use |
|---|---|---|---|---|
| `desk` | 640 x 400 at 15 fps | 1 cm | 0.2-2 m | Objects on a table, workstation description |
| `room` | 848 x 480 at 15 fps | 2 cm | 0.3-6 m | Clearance, doors, steps |
| `close` (D405-class) | 848 x 480 at 30 fps | 2 mm | 0.07-0.5 m | Small objects, print prep |

Guards inside the sidecar: at most 1,000,000 raw points per capture; a 1.5 GB memory budget; refuse to start under a configurable free-memory floor (proposed 6 GB; today's 5.5 GB would be refused, which is the behaviour `AGENTS.md` asks for while training runs).

Routes. The generic ones already exist in `src/server/http.ts`: `GET /api/sensors`, `POST /api/sensors/:id/start`, `/stop`, `/observe` and `/watch`, `POST /api/sensors/stop-all`, `GET /api/sensors/observations`. A source named `scanner` gets all of them, and the agent reaches it through `sensor_observe { source, question }`, which is in the always-ask list. What scanning adds:

| Route | Who calls it | Note |
|---|---|---|
| `GET /api/sensors/scanner/devices` | Scanner window | runs `probe`; lists candidate devices and the backend that would claim each |
| `POST /api/sensors/scanner/import` | window | a file the user picked; answers with `scan.mesh` and `scan.scene` |
| `POST /api/sensors/scanner/keep`, `DELETE /api/sensors/scanner/keep/:id` | window | explicit keep and delete; `keep` is refused without a grant minted in main |
| `GET /api/sensors/scanner/preview/:id` | Scanner window | binary, loopback, ticketed like the other routes |

The profile (desk, room, close) is a source setting changed in the Scanner window, not a per-call argument: `ObserveArgs` carries only `question` and `initiator`. A zone watch is the ordinary `POST /api/sensors/scanner/watch` with an interval of at least 2000 ms. The agent cannot start the source, exactly as it cannot open the camera: `sensor_observe` works only on a live source.

The Scanner pop-out needs no camera grant: clouds arrive from the server, not from `getUserMedia`. The Electron permission handler stays as it is.

### 3d. Privacy and consent

1. **Off until the user starts it** in the Scanner window; a red **SCANNER LIVE** indicator with a clock, as for the camera; closing the window stops it.
2. **Retention none, enforced by the server.** Frames live in the sidecar's memory and in `~/.eventhorizon/scans/<sessionId>/`, which `stop` empties. One audit entry per capture: the bus already records the source, the kind and the payload's byte length - never content.
3. **Keeping is per capture and visible.** "Keep this scan" asks for a folder; the file is copied there and its ledger entry becomes `kept`; the status bar shows how many scans are kept and offers "Delete all kept scans".
4. **People.** A room scan captures bystanders. The start card says so. Body and face scans get their own consent prompt (`kind: "scan.mesh"` with `subject: "body"`); face geometry is biometric data (interpretation, not legal advice).
5. **Nothing remote.** Point clouds never leave the machine in core. A depth snapshot rendered as an image may go to a BYOK vision provider only with `allowRemote: true`, the pattern `src/server/sensors.ts` already enforces with a 403.
6. **Never memory.** Scan content is not written to the engram store or to `.harness/memory.md`; the agent sees the bounded payload only.
7. **Never in a worktree.** Scratch lives under `~/.eventhorizon/`, not in the project tree, so a scan cannot be committed by accident.
8. **Stop-all stops the scanner too.** `stopAllSensors()` is the one switch that ends everything; for the scanner it must also end the sidecar and empty the scratch.

### 3e. The Scanner panel and the 3D viewer

| | Raw WebGL2 (no library) | three.js | Babylon.js |
|---|---|---|---|
| Licence | none needed | MIT | Apache-2.0 |
| Size (minified and gzipped) | 0 | about 185 kB (`three`), about 300 kB (`three/webgpu`) | about 1.8 MB for all of `@babylonjs/core`; modular by package |
| Weekly npm downloads, 2026-09 | - | 12.2 million | 315,000 |
| Point clouds | one vertex array, one draw call | `THREE.Points`; Potree for octree-streamed clouds (licence **unverified**) | `PointCloudSystem` |
| Format loaders | none: the server hands over a normalised binary | `PLYLoader` (ASCII and binary, colours, faces), `GLTFLoader` (Draco, KTX2, meshopt), `STLLoader`, `OBJLoader`; a USD loader for USD/USDA/USDC/USDZ is reported **(unverified)** | OBJ, STL, glTF built in |
| WebGPU | no | `WebGPURenderer` with WebGL2 fallback | yes, WGSL-native since 8.0 |
| CPU per draw call, Windows WebGL2 (Chrome 154 benchmark, many small meshes) | - | 2.10 microseconds (r186) | 4.83 microseconds (9.29) |
| Memory per object at 20,000 objects (same benchmark) | - | 3-6 KB | 17-22 KB |
| Built-in GUI, inspector, physics, WebXR | no | no | yes |
| SolidJS fit | `onMount` with a canvas ref | same; no React-only wrapper needed | same; the wrapper that exists is React-only |

Facts about the renderer here: Chromium 148; WebGL2 is on by default; WebGPU is on by default on Windows x64 since Chromium 113, but on Linux only for Intel Gen12+ and recent NVIDIA drivers on Wayland, so WebGL2 stays the baseline. Chromium on Windows uses one GPU adapter and `powerPreference` has no effect, so on this three-GPU machine the viewer cannot choose its GPU.

**Recommendation.** Phase 1 uses raw WebGL2 for points and wireframes. The server parses PLY, OBJ and STL (pure TypeScript, testable under `npm run scanner:test`) and serves normalised float32 positions and uint32 indices, so the renderer contains no format code. Add three.js when textured GLB or USDZ must be displayed, imported lazily in the Scanner window only. Babylon.js earns its size only if EHC wants an in-app 3D GUI or WebXR.

Accessibility of the viewer: a canvas is invisible to screen readers (`docs/SENSORS-ACCESSIBILITY.md`, item 8). The window renders the Observation's `text` as real DOM beside the canvas, gives the canvas an `aria-label` with the same sentence, and offers keyboard view presets (front, top, side, fit).

### 3f. Point cloud to text

CPU pipeline in Open3D, one capture:

1. Deproject the 16-bit depth map with the camera intrinsics; drop zeros; clip to the profile's range.
2. Voxel-filter to the profile's size; statistical outlier removal; estimate normals.
3. Segment up to three planes with RANSAC (`segment_plane`). The plane whose normal is closest to gravity (from the IMU when present) is the floor; the next near-horizontal plane above it is a support surface.
4. Remove the planes; cluster the remainder with `cluster_dbscan` (eps 4-6 cm, 10-20 points).
5. For each cluster: oriented bounding box, centroid, distance and bearing from the camera, lowest point relative to the support plane ("on the table").
6. Shape heuristics from the box: box-like when the extents are comparable, flat when the smallest is under 2 cm, elongated when the largest is over three times the smallest.
7. Clearance: project the free floor band to a 5 cm grid; report the widest corridor and any step (a second horizontal plane more than 1 cm away).
8. Fill the text template and the JSON. Labels are `unknown` in core; the S3b detector or the vision lane can attach one by projecting the 3D box into the aligned colour image.

Budget: a target of 500 ms per `scan.scene` for 500,000 input points on the CPU. **Not measured** - Open3D is not installed and no device was attached.

Accuracy to state in the text, not hide: a Gemini 335 is specified at under 1.5% at 2 m, so about 3 cm at that range; a RealSense D405 is sub-millimetre only between 7 and 50 cm; a phone gives 256 x 192 depth. A "31 cm box" from a depth camera on a desk means 31 give or take 2-3 cm.

### 3g. How a scan becomes a robot task input

- **The `scan.scene` objects are already pick targets**: `center` and `sizeM` in a named frame. `ehc_bridge` republishes a kept cloud as `sensor_msgs/PointCloud2` and each object as a `geometry_msgs/PoseStamped`.
- **The ROS 2 node enters through the loopback bridge**: `hello` with the token from `~/.eventhorizon/sensors.json`, then `observation` lines. Twenty lines per second is ample for a downsampled summary and far too little for a cloud, so the node writes the cloud to a file and sends the `ref`.
- **Frames must be declared.** Camera coordinates are optical (x right, y down, z forward). The bridge needs the camera's pose in the robot frame, taken from the URDF that `realsense2_description` and `orbbec_description` ship, or from a static transform the user enters.
- **Scans go stale.** Every Observation carries `t`. Before a target is used, the bridge compares a fresh frame with the scan by ICP (`registration_icp`: fitness and inlier RMSE - API names from Open3D's registration tutorial, not re-verified today); a fitness below a threshold marks the scene changed and the target invalid.
- **Gates are unchanged.** Using a scan to move hardware still needs the `ask` approval, the armed toggle the model cannot set, a bounded duration and a model-independent stop. EHC publishes observations and targets, never velocity or joint commands (`docs/SENSORS-ACCESSIBILITY.md`, 2.6).
- **Precision comes from the right scanner.** Grasping within a few millimetres needs a close-range camera (D405-class) or a metrology scan; a room scan is for navigation, not for grippers.
- **The phone loop (iOS 27).** Object Capture makes a USDZ; Create ML trains a reference object from it; ARKit returns the object's pose in metric space; the bridge turns that into a target.

### 3h. Phases

**Phase 0 - no hardware: file import, the envelope and the viewer**

- A `scanner` source registered on the bus (`kind: "process"`), a **simulated depth source** (`sim-depth`: a synthetic floor, three boxes and a step, deterministic - the scanner's answer to `registerSimulatedLidar()`), the scanner-specific routes above and the scratch root. The bus already writes the audit entries.
- Import backend in pure TypeScript: binary PLY, OBJ, STL statistics and bounding boxes; `scan.mesh` with a text line.
- `ScannerWindow.tsx` as a fourth pop-out kind (`scanner` added to the allowlist in `src/main/index.ts`), raw WebGL2, text twin, keyboard presets.
- Tests in the style of `scripts/test-sensorbus.ts` (`npm run scanner:test`): payload bounds, stop leaves nothing on disk, path containment, keep refused without a grant, `sim-depth` answers `sensor_observe` with the expected text.
- Done when: a sample PLY from an allowlisted host produces an Observation of 8 KB or less, the window draws it, `sensor_observe` on `sim-depth` and on `scanner` returns text, the scratch root is empty after stop, and `npm run sensorbus:test` and `npm run sensors:test` still pass.

**Phase 1 - the depth camera**

- The sidecar in the user's Python 3.14 with the backend ladder, `probe`, profiles, memory and RAM guards.
- `scan.frame`, live point preview at up to 5 Hz, consent card, live indicator.
- Device table by vendor and product id; USB 2.0 fallback detected and reported as `scan.device`.
- One `pip install` line shown in the panel for the user to run themselves (`pyorbbecsdk2`, `pyrealsense2`, `open3d`); EHC downloads none of it.
- Done when, with the operator's camera: start within 2 s, first cloud within 1 s, the scratch root empty after stop, and the camera window still starts in its usual time (no USB contention).

**Phase 2 - scene to text, keep and export**

- Planes, clusters, boxes, clearances, text; labels from the detector or vision lane; measurement questions (point to point) answered from the last capture; a zone watch through the bus's watch route.
- Keep as PLY or GLB; delete; the kept-scans counter.
- three.js for textured meshes; calibration self-check against a printed 100 mm cube, with the error reported in the Observation.

**Phase 3 - robot task input**

- `ehc_bridge` mapping, frame declaration, staleness check, gates. Tested first with a simulated `PointCloud2` publisher, as planned for the Radar panel.

**Phase 4 - handheld and phone ingest**

- Exports from Revo Scan, Creality Scan, EXScan, Polycam and Scaniverse; E57 and LAZ through `pye57` and `laspy`; USDZ from RoomPlan and Object Capture.

---

## 4. Core and premium

| Capability | Where | Why |
|---|---|---|
| A `scanner` source on the bus, a simulated depth source, the scanner-specific routes | **Core** | Start, stop, observe, watch, audit and `sensor_observe` already exist |
| Sidecar contract and the backend ladder (Orbbec, RealSense, OpenCV, file import) | **Core** | One adapter per protocol, not per product |
| Bounded observations: cloud statistics, planes, oriented boxes, mesh summary, text | **Core** | The agent's actual input |
| Keep and delete with a server-held grant; PLY and GLB export | **Core** | Privacy controls are not a feature to upsell |
| Scanner window with a point and wireframe viewer; text twin for screen readers | **Core** | The visual check that a device is live |
| `sensor_observe` on the scanner, measurement questions, zone watch | **Core** | The tool exists and already asks on every use |
| ROS 2 bridge mapping (`PointCloud2`, `PoseStamped`), frames, staleness | **Core** | The planned `ehc_bridge` |
| Photogrammetry and NeRF or Gaussian Splat pipelines (COLMAP, Meshroom, Nerfstudio, gsplat) | **Premium candidate** | CUDA-class GPUs, long runs, licence review (INRIA code is non-commercial) |
| Automatic meshing and print preparation (meshing, hole filling, wall thickness, decimation, 3MF export, orientation) | **Premium candidate** | A multi-step pipeline with quality settings |
| Multi-scan registration (ICP, markers, loop closure, room-scale fusion, octree streaming in the viewer) | **Premium candidate** | The hardest geometry in the set |
| People scrubbing before a scan is kept | **Premium candidate** | Needs segmentation models |
| Semantic 3D labels (detector and vision-model grounding in the cloud) | **Premium candidate** | Depends on S3b models |
| Hand-eye calibration, collision meshes, grasp pose generation | **Premium candidate** | Robot-specific |
| Phone companion: RoomPlan and reference-object tracking | **Premium candidate** | A second code base |

---

## 5. Accessibility uses

| Use | Evidence | What EHC would compute or do |
|---|---|---|
| Environment mapping for wheelchair users | RAIS (ASSETS 2024): a vacuum robot with a phone running RoomPlan maps a room and flags accessibility issues; 6.5-10 minutes for 32-48 m2, with some issues missed against a manual inspection. Earlier work used a Kinect depth map at 5 mm voxels to test wheelchair passage (Yasumuro and others, 2013). "Bring Environments to People" (W4A 2023) gave 14 wheelchair users virtual tours of scanned rooms for remote accessibility assessment. CoNav Chair (arXiv 2501.09680) is a ROS-based shared-control wheelchair with RGB-D SLAM | From a `room` scan: door and corridor clear width, step and ramp height, table height and knee clearance, the widest free path - the same plane and cluster code as section 3f. Output as text, speech and a tactile-printable floor plan (premium) |
| Object description for blind and low-vision users | A stereo camera that detects head-level obstacles and speaks their range reached 2.8 cm mean range error and 91% identification by users (Scientific Reports, 2025). A 2026 system combines an OAK-D Lite, a small LiDAR, YOLOv4-tiny, ROS 2 and **Piper** text to speech on a Raspberry Pi 5, with no network. NavWear (2025) pairs an RGB-D camera with haptics. A 2023 review finds RGB-D cameras the prevalent sensor in navigation aids. Apple's own Detection Mode uses LiDAR and on-device models for doors, people and furniture, and says it "should not be relied on ... for navigation" | `sensor_observe` answered through the local speech lane EHC already ships: "the mug is about 30 cm right of the keyboard, 40 cm away". A head-level hazard flag (a cluster whose lowest point is above 1.2 m and within 1.5 m). The same disclaimer Apple uses |
| An accessible route to scanning itself | Revo Scan, Creality Scan and EXScan are mouse-driven 3D interfaces, invisible to screen readers | Voice in (whisper.cpp) -> agent -> `sensor_observe` -> speech out, with a fixed desk-mounted camera or a turntable instead of hand motion. Start and stop on a single switch, as in `docs/SENSORS-ACCESSIBILITY.md` |
| Printing assistive devices from scans | Smartphone photogrammetry reached sub-millimetre surface accuracy on static limb models (Sensors, 2026) but oversized a direct amputee scan by 63% in volume, against an EinScan H2 (2025). 3D-printed transtibial sockets have a systematic review (PLoS ONE 2022, cited in Ellis and others 2026; not read here). Shining 3D ships an orthotics and prosthetics edition of EXScan | Scan-to-print for **assistive gadgets**: switch mounts, key guides, adapted handles, cable guides, joystick guards, tactile maps. Sockets and orthoses are clinical devices and stay out of scope (the medical-device boundary in `docs/SENSORS-ACCESSIBILITY.md`, item 11) |
| Output that suits low vision | - | Depth as a high-contrast false-colour map in the viewer; every number also spoken; large-type text twin |

Honest limits: EHC is a desktop harness, not a wearable, so it describes a workstation and a room, not a street. Nothing here is a navigation aid.

---

## 6. Honest gaps and risks

1. **Driver fragility (documented).** The RealSense repositories were renamed and the redirect's lifetime is not guaranteed. The old `pyorbbecsdk` Windows wheel contained macOS binaries (issue 194, 2025-12). Orbbec's OpenNI-to-UVC firmware migration splits older cameras by firmware version. ZED owners report a camera that Windows sees and the SDK does not (2025 forum threads). iOS 26.4 and later drift in world tracking on LiDAR phones when depth is enabled (Apple Developer Forums, thread 833040, 2026-06). RealSense's ROS wrapper is "not meant to be supported on Windows". *Mitigation:* the sidecar isolates the crash; capability is probed when the user starts, never at install; every failure is an `scan.error` that names what was tried.
2. **USB bandwidth (computed).** Depth alone is 52.7 MB/s at 1280x720 and 30 fps and 158.2 MB/s at 90 fps, before two infrared streams and colour. A USB 2.0 port or hub silently throttles (ZED: "the maximum supported resolution is VGA at 30 FPS" on USB 2.0). Two or more cameras on one controller is why 33xLe and 435Le exist on Ethernet. *Mitigation:* start in a low profile, report the negotiated speed as `scan.device`, never raise it automatically; raw frames never cross stdio.
3. **Shared machine (measured).** 5.5 GB free of 63 GB while training runs, against vendor minimums of 16-32 GB; `AGENTS.md` asks for at least 8 GB of headroom before heavy work. No NVIDIA GPU: no ZED SDK, no Creality Scan, no Shining 3D software, no dense photogrammetry. *Mitigation:* the memory floor in the sidecar; CPU Open3D with hard budgets; a user-visible "training is running" refusal rather than a swap storm. `open3d-xpu` could use the Arc Pro B70 **(unverified on this machine)**.
4. **Calibration.** Creality asks for recalibration with the board after any bump and a 30-minute warm-up before precision work. Depth cameras need depth-to-colour alignment and a depth scale, and drift with temperature. Reflective, black and transparent surfaces defeat depth (Apple exposes a confidence map for exactly this; Luxonis lists glass and glossy black as weak fits). *Mitigation:* a printed 100 mm reference cube measured at the start of a session, with the error in the Observation; confidence-thresholded points; "unknown" rather than a guess.
5. **Data size (measured and reported).** JSON is 6.2x binary for the same points. Terrestrial scans run to gigabytes per room. Revopoint's own forum staff answer that fusion is bound by RAM, not GPU. *Mitigation:* binary sidecars, voxel filtering before anything else, a scratch quota, viewer clouds capped at 200,000 points (2.9 MB). `PLYLoader` returns float64 for double-precision files, which the WebGL renderer cannot upload. On the bus there are three more ways a mis-sized scanner payload fails quietly: a payload over 64 KB is replaced by a truncated notice, a bridge line over 256 KB closes the connection, and `ref` is cut to 512 characters.
6. **Privacy of spaces and people.** A room scan is a floor plan with belongings and bystanders; a body or face scan is biometric-adjacent. Kept scans are ordinary files unless they fall under the at-rest encryption described in `docs/ENCRYPTION.md` (**not checked for this memo**). *Mitigation:* section 3d, plus a decision for the operator on whether kept scans inherit the encryption posture.
7. **Accuracy claims are best cases.** Vendors say "up to"; volumetric error grows with size (RaptorX: 0.02 mm + 0.06 mm per metre); RaptorX is not tested to VDI/VDE 2634 (one database's note). Depth cameras are at percent-level at 2 m; phone LiDAR is 256 x 192. *Mitigation:* the text template carries the tolerance.
8. **Dependencies EHC cannot fetch.** Open3D, laspy and pye57 are on PyPI, which is not on the download allowlist. *Mitigation:* the user installs them (rung 2 of the ladder), or a bundle is pinned from GitHub releases after a licence check.
9. **(resolved 2026-11-27)** The operator's scanner is **Creality CR-Scan Ferret** (`VID_2BC5&PID_069C`, Orbbec). Probe + first capture verified live; depth needs Orbbec SDK. See "H4 live test" below. (Originally: scanner unknown and not attached; section 0 has the probe; phase 1 is file import work; the phase plan needs no hardware until then.)s with any handheld or phone.
10. **Market churn during the research window.** RealSense is being acquired; Leica replaced its RTC line in June 2026; Revopoint listed POP 3 as out of stock on 2026-11-10 and launched MIRACO 2 on 2026-11-18; Scaniverse moved to a new platform where "Classic accounts and scans don't carry over". *Mitigation:* no vendor name in the schema; versions pinned in the catalog.
11. **Not verified here.** Blender's licence page returned 403. Potree's licence. three.js USD and LAS loaders. Handheld vendors having no SDK (absence of evidence). OpenCV exposing generic 16-bit depth on Windows for unknown cameras. Open3D on AMD GPUs. The ARCore depth image being 160 x 90 (one developer's report). Any latency figure for section 3f. The sensor bus file was still being edited while this was read; its constants are quoted from a read at about 17:05.
12. **Incidental, outside this memo's scope:** Electron 42 reached end of life on 2026-10-20 (supported lines are 43-45); `package.json` now pins `electron 45.5.0` (42->45 upgrade applied, `docs/UPGRADE-ELECTRON.md`; 42 reached EOL 2026-10-20).

---

## 7. Sources

Checked 2026-11-27 unless a date is given.

**RealSense**

- Cognex press release, 2026-09-22: https://www.cognex.com/en/company/press-releases/cognex-to-acquire-realsense
- SEC Form 8-K, 2026-09-22: https://www.sec.gov/Archives/edgar/data/851205/0000851205-26-000071.txt
- Product list and ranges: https://www.realsenseai.com/products/ ; https://www.realsenseai.com/product-family/430-series/ ; https://www.realsenseai.com/product-family/450-series/ ; https://www.realsenseai.com/product-family/555-series/ ; https://www.realsenseai.com/product-family/pro-series/
- Spin-out, store prices (2026-11-06), D555 details: https://physicalailab.io/en/intel-realsense-spinout-cameras-buy-sdk-2026/
- SDK (Apache-2.0) and repository notice: https://github.com/realsenseai/librealsense ; https://github.com/realsenseai/librealsense/blob/master/LICENSE ; https://docs.ros.org/en/jazzy/p/librealsense2/
- ROS wrapper: https://github.com/realsenseai/realsense-ros ; https://index.ros.org/p/realsense2_camera/
- Python wrapper: https://pypi.org/project/pyrealsense2
- Vendor and product ids: https://www.realsenseai.com/wp-content/uploads/2023/10/Intel-RealSense-D400-Series-Datasheet-September-2023.pdf
- The stale "wound down" claim: https://www.roboticscenter.ai/blog/best-depth-cameras-robotics

**Orbbec**

- Gemini 335: https://store.orbbec.com/products/gemini-335 ; https://www.orbbec.com/gemini-330-series/ ; https://www.orbbec.com/compare-products-spec
- Store prices: https://store.orbbec.com/collections/stereo-vision-camera ; https://store.orbbec.com/collections/tof-camera
- Femto Bolt: https://www.orbbec.com/products/tof-camera/femto-bolt ; https://doc.orbbec.com/documentation/Orbbec%20Femto%20Bolt%20Documentation/Femto%20Bolt%20Hardware%20Specifications
- Gemini 435Le: https://www.orbbec.com/gemini-435le ; https://store.orbbec.com/products/gemini-435le
- SDK v2 (MIT, platforms, device table, licence text): https://github.com/orbbec/OrbbecSDK_v2 ; https://github.com/orbbec/OrbbecSDK_v2/blob/main/LICENSE.txt ; https://orbbec.github.io/OrbbecSDK_v2/ ; https://www.orbbec.com/developers/orbbec-sdk/
- Python wrapper and issue 194: https://github.com/orbbec/pyorbbecsdk ; https://github.com/orbbec/pyorbbecsdk/issues/194 ; https://orbbec.github.io/pyorbbecsdk/source/2_installation/install_the_package.html
- ROS 2 wrapper (Apache-2.0): https://github.com/orbbec/OrbbecSDK_ROS2 ; https://index.ros.org/r/orbbec_camera_v2/
- Vendor and product ids: https://www.orbbec.com/wp-content/uploads/2023/04/ORBBEC_Datasheet_Gemini-2-1.pdf

**Stereolabs**

- ZED 2i: https://www.stereolabs.com/store/products/zed-2i
- Supported platforms and GPU requirement: https://docs.stereolabs.com/docs/development/zed-sdk/supported-platforms ; https://docs.stereolabs.com/docs/development/zed-sdk/linux ; https://support.stereolabs.com/articles/8942016062-which-graphics-cards-are-supported-by-the-zed-sdk
- SDK licence: https://www.stereolabs.com/SoftwareandServicesLicenseAgreement
- ROS 2 wrapper: https://github.com/stereolabs/zed-ros2-wrapper ; https://docs.stereolabs.com/docs/integrations/ros-2
- Samples (MIT): https://github.com/stereolabs/zed-sdk
- Prices for ZED Mini and ZED X (reseller): https://www.roboticscenter.ai/guides/robot-vision/zed-camera-guide
- USB ids and detection reports: https://community.stereolabs.com/t/zed-camera-detected-by-usb-but-not-recognized-by-sdk-and-apps/9452 ; https://community.stereolabs.com/t/zed1-usb-not-recognized-camera-works-in-windows-11/9633

**Luxonis**

- https://shop.luxonis.com/collections/oak-cameras-col ; https://shop.luxonis.com/products/oak-d ; https://checkout.luxonis.com/products/oak-d-s2 ; https://shop.luxonis.com/products/oak-4-d
- DepthAI (MIT): https://pypi.org/project/depthai/

**Revopoint**

- Downloads and compatibility: https://www.revopoint3d.com/pages/support-download ; https://www.revopoint3d.com/pages/revo-scan-6
- POP 3 and POP 3 Plus: https://global.revopoint3d.com/products/portable-3d-scanner-pop3 ; https://www.revopoint3d.com/products/portable-3d-scanner-pop3
- MIRACO: https://global.revopoint3d.com/products/standalone-3d-scanner-miraco
- Model comparison: https://www.revopoint3d.com/blogs/blog/best-revopoint-3d-scanners-guide
- Out-of-stock notice (2026-11-10) and OS requirements: https://support.revopoint3d.com/hc/en-us/articles/12766536732187-How-much-do-the-scanners-cost ; https://support.revopoint3d.com/hc/en-us/articles/16660918097819-What-OS-operating-system-does-the-scanner-require
- Revo Scan 6 system requirements: https://revopedia.revopoint3d.com/en/Revoscan/Revoscan6usermanual
- MIRACO 2: https://www.revopoint3d.com/blogs/news/revopoint-launches-miraco-2-on-kickstarter-scan-in-one-create-with-agents
- Prices (2026-11-13): https://www.meshy.ai/blog/best-3d-scanner-for-3d-printing ; https://3dp.sale/3d-scanners ; https://precision3dworks.com/collections/3d-scanners
- Industrial area-scan SDK: https://3dcamera.revopoint3d.com/html/Areascan2/index.html

**Creality**

- RaptorX: https://us.store.creality.com/products/creality-raptorx ; https://wiki.creality.com/en/3d-scanner/raptorx/tutorial
- Requirements and formats: https://printstock.io/printers/creality-raptorx ; https://top3dshop.com/product/creality-raptorx-3d-scanner
- Other models: https://store.creality.com/products/cr-scan-otter-3d-scanner ; https://3dp.sale/3d-scanners

**Shining 3D**

- FreeScan software and requirements: https://support.shining3d.com/en/support/solutions/articles/60001191260-software-download-for-freescan-handheld-scanners ; https://support.shining3d.com/en/support/solutions/articles/60001193073-system-requirements-for-freescan-ue-pro
- EXScan PC guide (CUDA requirement): https://support.einscan.com/en/support/solutions/articles/60000788964-pc-configuration-guide
- EXScan editions: https://support.einscan.com/en/support/solutions/folders/60000496551
- Software and paid add-ons: https://benchmarksutra.in/blog/shining-3d-scanner-software-explained
- Prices: https://www.skylab3d.com/products/freescan-ue-pro ; https://top3dshop.com/3d-scanner/ ; https://afinia.com/collections/3d-scanners

**Apple and Google**

- ARKit depth: https://developer.apple.com/documentation/arkit/arframe/scenedepth ; https://developer.apple.com/documentation/arkit/ardepthdata ; https://developer.apple.com/documentation/arkit/arconfiguration/framesemantics-swift.struct/scenedepth
- Depth resolutions (WWDC22): https://developer.apple.com/videos/play/wwdc2022/110429 ; depth at 60 Hz (WWDC20): https://developer.apple.com/videos/play/wwdc2020/10611
- Scene reconstruction: https://developer.apple.com/documentation/arkit/arworldtrackingconfiguration/scenereconstruction
- RoomPlan: https://developer.apple.com/documentation/roomplan ; https://developer.apple.com/documentation/roomplan/scanning-the-rooms-of-a-single-structure
- Object Capture: https://developer.apple.com/documentation/realitykit/scanning-objects-using-object-capture
- iOS 27 object tracking (WWDC26): https://developer.apple.com/videos/play/wwdc2026/283
- LiDAR tracking drift (iOS 26.4): https://developer.apple.com/forums/thread/833040
- Detection Mode: https://support.apple.com/guide/iphone/detect-doors-people-and-furniture-around-you-iph35c335575/ios ; https://support.apple.com/en-us/HT209517 ; https://www.apple.com/newsroom/2022/05/apple-previews-innovative-accessibility-features
- ARCore depth: https://developers.google.com/ar/develop/depth ; https://developers.google.com/ar/devices ; https://codelabs.developers.google.com/codelabs/arcore-rawdepthapi
- ARCore depth resolution (one developer's report): https://maziminds.com/blog/ar-depth-android-phones

**Polycam, Scaniverse, Matterport**

- https://poly.cam/pricing ; https://learn.poly.cam/hc/en-us/articles/27756102599572-What-File-Types-Can-Polycam-Export ; https://poly.cam/blog/polycam-vs-scaniverse-for-professional-scanning-what-each-one-is-built-for ; https://poly.cam/blog/obj-vs-fbx-vs-glb-which-3d-scan-format-should-you-export
- https://dev.scaniverse.com/support ; https://www.skyebrowse.com/news/posts/polycam-vs-scaniverse ; https://www.3dmag.com/3d-scanners/best-3d-scanning-apps/
- https://support.matterport.com/s/article/FAQ-Pro3-Camera ; https://support.matterport.com/s/article/Subscription-Plans ; https://support.matterport.com/s/article/How-long-does-a-model-take-to-process

**Survey-grade scanners**

- https://shop.leica-geosystems.com/reality-capture/blk360/buy ; https://shop.leica-geosystems.com/reality-capture/shop ; https://leica-geosystems.com/products/laser-scanners/scanners/leica-blk360
- https://www.3dmag.com/3d-scanners/3d-laser-scanner-for-buildings-price-2026 ; https://www.skyebrowse.com/news/posts/faro-vs-leica ; https://swyvl.io/blog/how-to-share-faro-leica-scan-data-online
- Cyclone export settings: https://rcdocs.leica-geosystems.com/cyclone-register-360/latest/export-settings

**Formats**

- LAS: https://www.loc.gov/preservation/digital/formats/fdd/fdd000418.shtml
- LAZ and LASzip: https://github.com/LASzip/LASzip ; https://www.ogc.org/announcement/ogc-announces-publication-of-the-laz-1-4-community-standard ; https://packagehub.suse.com/packages/laszip
- E57: http://www.libe57.org/
- `laspy`: https://github.com/laspy/laspy ; https://pypi.org/project/laspy
- `pye57`: https://github.com/skand-io/pye57
- OpenUSD licence: https://github.com/PixarAnimationStudios/OpenUSD/blob/dev/LICENSE.txt
- glTF: https://github.com/KhronosGroup/glTF ; https://www.khronos.org/gltf
- PCL: https://github.com/PointCloudLibrary/pcl ; https://pointclouds.org/about/
- OctoMap: https://github.com/OctoMap/octomap/blob/devel/octomap/LICENSE.txt
- Omniverse point-cloud workflow (third-party licence table for laspy, pye57, lazrs, PotreeConverter): https://docs.omniverse.nvidia.com/extensions/latest/ext_point-cloud/workflow-user-guide.html

**Processing**

- Open3D: https://open3d.org/ ; https://www.open3d.org/docs/latest/getting_started.html ; https://www.open3d.org/docs/latest/tutorial/geometry/pointcloud.html ; https://pypi.org/project/open3d
- OpenCV and Orbbec UVC: https://docs.opencv.org/4.x/d1/d33/tutorial_orbbec_uvc.html ; https://opencv.org/blog/orbbec-3d-uvc-cameras-are-now-supported-by-opencv
- COLMAP: https://colmap.github.io/license.html ; https://colmap.github.io/faq.html
- Meshroom: https://github.com/alicevision/Meshroom ; https://github.com/alicevision/Meshroom/releases ; https://meshroom-manual.readthedocs.io/en/latest/faq/needs-cuda/needs-cuda.html ; https://github.com/alicevision/Meshroom/issues/2140
- Gaussian Splatting licences: https://github.com/nerfstudio-project/gsplat ; https://github.com/nerfstudio-project/nerfstudio/issues/2684 ; https://radiancefields.com/radiance-field-license-comparison
- MeshLab: https://www.meshlab.net/
- CloudCompare: https://github.com/CloudCompare/CloudCompare
- PDAL: https://pdal.org/en/latest/about.html

**Renderer**

- Electron 42 and Chromium 148: https://www.electronjs.org/blog/electron-42-0 ; https://releases.electronjs.org/release/v42.11.0 ; end of life: https://endoflife.ai/article-electron-42-eol
- WebGPU availability: https://github.com/gpuweb/gpuweb/wiki/Implementation-Status ; https://developer.chrome.com/docs/web-platform/webgpu/troubleshooting-tips
- three.js against Babylon.js: https://www.utsubo.com/blog/threejs-vs-babylonjs-vs-playcanvas-comparison ; https://app.cinevva.com/guides/threejs-vs-babylonjs.html ; https://threejsresources.com/compare/three-js-vs-babylon-js ; https://blog.logrocket.com/three-js-vs-babylon-js
- Engine benchmark: https://github.com/mvaligursky/web-engines-compare
- three.js loaders: https://threejs.org/docs/pages/PLYLoader.html ; https://threejs.org/docs/pages/GLTFLoader.html ; https://threejs.org/docs/pages/STLLoader.html
- Potree: https://github.com/potree/potree

**Accessibility**

- RAIS: https://dl.acm.org/doi/10.1145/3663548.3688512 ; https://makeabilitylab.cs.washington.edu/project/rais
- Barrier-free verification with depth maps: https://eres.scix.net/pdfs/convr-2013-56.pdf
- Virtual tours for wheelchair users: https://dl.acm.org/doi/fullHtml/10.1145/3587281.3587292 ; https://dl.acm.org/doi/fullHtml/10.1145/3597638.3608410
- CoNav Chair: https://arxiv.org/html/2501.09680v1 ; eNav: https://pmc.ncbi.nlm.nih.gov/articles/PMC8883793/
- Head-level obstacle detection: https://www.nature.com/articles/s41598-025-01529-7
- Vision alarming system with Piper on a Raspberry Pi: https://pmc.ncbi.nlm.nih.gov/articles/PMC13211286
- NavWear: https://www.tandfonline.com/doi/full/10.1080/17483107.2025.2477681
- Smartphone depth imaging: https://www.mdpi.com/2076-3417/12/6/2802/htm ; survey: https://link.springer.com/article/10.1007/s11042-023-17552-7 ; https://dl.acm.org/doi/10.1145/3733155.3734895
- Prosthetics and orthotics scanning: https://www.mdpi.com/1424-8220/26/4/1251 ; https://www.tandfonline.com/doi/full/10.1080/03091902.2025.2540096 ; https://link.springer.com/article/10.1186/s12938-026-01515-8

**Inside this repository**

- `docs/SENSORS.md` (invariants, the bus, the camera lanes), `docs/SENSORS-ACCESSIBILITY.md` (the Observation envelope, ROS 2 bridge limits, the screen-reader and medical-device items), `docs/SENSORY.md` (the ladder), `docs/ARCHITECTURE.md` (principle 5, no unasked dependencies), `AGENTS.md` (download policy, headroom rule)
- `src/server/sensorBus.ts` (the Observation type, the payload cap, the ring, watches, the simulated lidar, the loopback bridge), `src/server/http.ts` (the `/api/sensors` routes), `src/server/agentTools.ts` and `src/server/approvals.ts` (`sensor_observe` and the always-ask list), `scripts/test-sensorbus.ts` - all read while another session was writing them
- `src/server/sensors.ts` (the `allowRemote` refusal, the frame-request pattern), `src/shared/externals.ts` (the host allowlist), `src/server/sensory-catalog.ts` (SHA-256 pinned rows), `src/renderer/ShaderBackground.tsx` (WebGL2 today), `src/main/index.ts` (`window:popout`), `package.json`

---

## H4 live test (2026-11-27) — Creality CR-Scan Ferret plugged in

**Device identified.** `Creality CR-Scan Ferret`, USB `VID_2BC5&PID_069C`, **Orbbec**, class `Camera`, `OK`. **Three camera interfaces:** `CR-Scan Ferret Depth Camera` (MI_00), `CR-Scan Ferret IR Camera` (MI_02), `CR-Scan Ferret RGB Camera` (MI_04). `Get-PnpDevice -PresentOnly`. Creality app present is `C:\Program Files\Creality\Creality Print 7.0` (slicer); **no separate Creality Scan app**; **no Orbbec SDK installed** (nothing was downloaded); `Creality Scan` itself **needs NVIDIA CUDA** (item 8) and this machine has **AMD RX 7900 XTX + Intel Arc Pro B70, no NVIDIA**.

**CUDA vs Orbbec — a correction.** `Creality Scan` requires **NVIDIA CUDA**; **Orbbec SDK v2 does not require an NVIDIA GPU** for streaming depth. No NVIDIA here is not, by itself, a blocker for the Orbbec path.

**Probe + first capture — measured.** Standalone Electron 45.5.0 (Chromium 156.0.8078.109), secure context, camera permission granted, `navigator.mediaDevices` (the exact path EHC uses).
- **RGB Camera: CAPTURED.** Real 640×480 frame, ~15 fps; `track.getSettings()` (colorTemperature 5000, contrast 40, saturation 32, sharpness 99, exposureMode continuous, ...); **non-blank pixels** (meanLuma 111, spread 46, min 0, max 172); **PNG saved** (`creality-ferret-rgb.png`, ~506 KB).
- **Depth Camera: `AbortError Timeout starting video source`. IR Camera: `AbortError Timeout starting video source`.** Depth + IR are **not exposed as ordinary webcam streams** in Chromium. **Depth (3D) capture requires a supported Orbbec SDK device.** **Orbbec SDK v1.10.37 AND v2.10.6 tried — `Creality CR-Scan Ferret` (`VID_2BC5&PID_069C`) is NOT a supported Orbbec device** (not in either supported-product list; `No device found`, status 112; `PID_069C` unrecognized); `Creality Scan` needs CUDA and isn't installed. **Orbbec SDK v2.10.6** (`C:\Program Files\OrbbecSDK 2.10.6`, installer; `bin\OrbbecSDK.dll`, `depthengine.dll`, `OrbbecViewer`, `tools\`; `examples` built with `build_examples.ps1` + VS2026: `ob_point_cloud`, `ob_depth_c`, `ob_enumerate`, `ob_device_record_nogui`, `ob_multi_streams`, `ob_preset`, …). **Depth/point cloud NOT captured on this scanner.** No-NVIDIA is not itself a blocker (no NVIDIA here; Orbbec lists no NVIDIA requirement; `Creality Scan`'s CUDA requirement is separate). The intended path for a *supported* Orbbec device + a **stdio source** + `N4b` stands.

**Vision model on the physical scanner capture — measured (2026-11-27).** The bundled engine (`gemma4-e4b` GGUF + `mmproj`, `modalities.vision:true`, GPU) describing the saved `creality-ferret-rgb.png`, `POST /api/sensors/camera/look lane=engine`:
- *"The picture shows a bedroom scene featuring a bed with a brown patterned comforter, a white pillow, and a table with various items in the background."* (and variants). The model accurately identifies the indoor scene; `usage.prompt_tokens ~156`, ~88 tok/s.
- **Robustness finding + fix.** `gemma4-e4b` is a **thinking** model: it emits `message.reasoning_content`, and with `numPredict`/`max_tokens=180` it can hit `finish_reason:"length"` with `message.content` empty, yielding `camera_look`/`sensor_observe` = "no text." EHC reads `message.content`. **Fixed:** `src/server/sensors.ts` `look()` `numPredict: 180` -> `numPredict: 400` (engine + Ollama + BYOK); `sensors:test` + `typecheck` + a live re-test on the Ferret capture all green. `think:"low"` kept.
- Agent `camera_look`/`sensor_observe` on this source are permission `ask`, local-engine-only, refused while sensors are halted; separately `camera_look` agent tool + `requestFrame` + `windowLive` are tested; the full agent-loop `camera_look` on the physical Ferret is not separately chained in this window. `sensor_observe` `camera` (bus form) uses the same `lookFromCamera`.

**Calibration / readiness.** Item 4 applies: **recalibration board after any bump + 30-minute warm-up** before precision work; depth-to-colour alignment + depth scale; temperature drift; reflective/black surfaces. (Not run; recorded, not asserted.)

**EHC integration.** `CR-Scan Ferret RGB Camera` is a normal Chromium camera -> it is **already selectable as EHC's `camera` source**; `windowLive`, `requestFrame`, `deliverFrame`, `camera_look`/`sensor_observe` apply; sensing is permission `ask`, local-only, refused while halted. **3D scanning is NOT yet a sensor-bus source class** (`N4b`); no point-cloud/mesh output.

**Not verified here.** No **depth stream, point cloud, or mesh** produced; `Creality Scan` not run (CUDA); accuracy/resolution/latency not measured; calibration not run; **Orbbec SDK v2 not installed** and depth not captured through it; **I cannot view images** (no image input) - file + pixel statistics reported; not smoke-launched inside EHC's packaged camera window specifically.
