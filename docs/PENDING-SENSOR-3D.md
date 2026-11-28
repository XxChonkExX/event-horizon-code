# Pending: native-Linux sync + `Filter@FrameProcessor` + Blender turntable

Captured 2026-11-27. **Nothing below is proven; it is a checklist so nothing is forgotten.** Hardware-independent facts are marked; everything unverified is marked **UNVERIFIED**.

## Core achieved (this session, on Windows)

- **Creality CR-Scan Ferret = `2bc5:069c`, `PID_069C`, `sn BC6EB43004M`, Orbbec, `usbvideo`, USB2.0 (here) / USB3 per `tribuutscan`.** Not hardware-blocked; `PID_069C` not in stock Orbbec supported lists.
- **Custom Orbbec SDK + `PID_069C` patch** (`rafik24/OrbbecSDK_v2`, `OrbbecSDK` **v2.7.6**, MIT): `%TEMP%\opencode\pid-069c-orbbec.patch` (4 files +5/-3: `DevicePids.hpp`, `G2DeviceInfo.cpp`, `DeviceClockSynchronizer.cpp`, `PlaybackPropertyAccessor.cpp`); `cmake` + VS2026 + `cmake --build` **SUCCESS**.
- **`ob_enumerate` finds `Orbbec CR-Scan Ferret pid 0x069c`.** `Filter@FrameProcessor` still blocks `pipeline->start`. `rafik24` build `...\build-win\win_x64\bin\extensions\{filters\FilterProcessor,filters\ob_priv_filter,frameprocessor\ob_frame_processor,depthengine\depthengine}.dll` present; **`Gemini2_v1.0.json` referenced by `OrbbecSDKConfig.xml` is MISSING.**
- **RGB + `gemma4-e4b`+`mmproj` vision verified**; `numPredict 180->400`. **RGB + `gemma4-e4b`... always-ask/halt-safe `camera_look`/`sensor_observe`.**
- **Blender 5.3.0** staged `D:\blender3d\blender-5.3.0-windows-x64`; `bpy` + `Movie Clip` verified; **12 frames @1280x720** captured; `D:\blender3d\ferret-photogrammetry.py`; **`tracks:0` on a static no-parallax burst; `detect_features` needs `CLIP_EDITOR`; not verified.**
- **`usbipd-win` 5.3.0** installed `C:\Program Files\usbipd-win`; scanner restored Not-shared + `usbipd-win` service left running; **WSL `vhci_hcd` blocker.**

---

## ✅ NOTE FOR NATIVE LINUX SYNC (don't forget!) — (1) `tribuutscan` + (2) `Filter@`

**On your native Linux box (dual env), `usbipd` + WSL `vhci_hcd` do NOT apply.** `CR-Scan Ferret` should enumerate on stock **`uvcvideo`** directly (`2bc5:069c`; `lsusb`; `/dev/video*`; metadata nodes; `/dev/hidraw*` IMU). Two things to test:

### (1) `tribuutscan` on native Linux — **`PID_069C` + raw 10/14-bit depth, no Orbbec `Filter@`**
```
git clone https://github.com/gegirti/tribuutscan    # python 3.10+; uv sync --all-extras  (Open3D+OpenCV+wgpu; --force-cpu for no NVIDIA)
# udev (not for detection; needed for 14-bit): sudo cp udev/70-tribuutscan.rules /etc/udev/rules.d/ ; sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=usb --attr-match=idVendor=2bc5
python3 -m tribuutscan.viewer  --force-cpu    # no `usbipd`, no WSL vhci_hcd on native Linux
```
- `lsusb | grep 2bc5`, `for d in /sys/class/video4linux/video*; do echo "$d $(cat $d/name)"; done`, `v4l2-ctl -d /dev/video0 --list-formats-ext`
- `tribuutscan` (**UNVERIFIED on your specific unit; tested `CR-Scan Ferret Pro`**): depth 1280x800 `Y10`/`Y14`, `1..1023`, `0=invalid`, ~15-33cm/~20-72cm, vendor UVC ext, `Close_range_mode`/`Long_range_mode`, IR projector, **no Orbbec SDK, no CUDA, no `CrealityScan`.**
- **Orbbec SDK on native Linux:** stock `usbvideo`; Orbbec v2 + `usbipd` NOT needed; **`usbipd` + `vhci_hcd` is WSL-only.**

### (2) `Filter@FrameProcessor` on native Linux — **same error is known + platform-independent**
- `Filter@FrameProcessor: config schema is empty, doesn't have any config value.`
- **Posted Orbbec issues:** `orbbec/OrbbecSDK_ROS2#80`, `#114`, `#83`; `OrbbecSDK_v2`. **v2 `Filter@` needs `FilterProcessor.dll`+`ob_priv_filter.dll`+`ob_frame_processor.dll`+`depthengine.dll` + `OrbbecSDKConfig.xml`, a matching `FilterProcessor`/`OrbbecSDK` version, and `Gemini2_v1.0.json`.** `Gemini2_v1.0.json` (referenced `<DepthFilterDDOConfig>./Gemini2_v1.0.json</DepthFilterDDOConfig>`) is **not shipped**. 
- **Workarounds in posts:** rebuild + `rm -rf build install log`; **Orbbec SDK `main`/v1.10.37 vs v2.7.6**; remove `--symlink-install`; **`FilterProcessor` version match**; `rafik24`/`OrbbecSDK_v2_WIN`; **`#83`-style `if(list not empty) return` vs reverse.** `ob_enumerate` (`PID_069C`) is NOT `pipeline.start`. 
- **My `PID_069C` patch + `rafik24` `2.7.6` + extensions is the starting point; `Filter@` is the open snag.** Your **native Linux + Ghidra/RE** is exactly the place to cut `FilterProcessor.dll`/`ob_frame_processor.dll` open. **My contribution + notes; no RE run.**

---

## ✅ Blender + turntable/spinner (don't forget!) — (3)

**You have a spinner.** 3D-from-RGB (no depth + no NVIDIA + no Orbbec + no `CrealityScan` + no `Filter@`):
```
# Blender 5.3 staged D:\blender3d\blender-5.3.0-windows-x64\blender.exe
# capture a spinner burst with my tool (or screenshot per angle):
node node_modules\electron\dist\electron.exe capture-sequence.cjs <out_dir> <N=24> <step_ms=300>
# my capture used CR-Scan Ferret RGB; on a spinner keep object STATIC, scanner/camera still, object rotating ~10-15°/step, ~70% overlap, even lighting, textured, non-reflective; uncover lenses
blender --background --factory-startup --python D:\blender3d\ferret-photogrammetry.py -- <frames_dir> <out_dir>
```
- `bpy.ops.clip.{open,detect_features,track_markers,set_solver_keyframe,solve_camera,setup_tracking_scene}`; **`detect_features` needs a `CLIP_EDITOR` space** (fails in pure `--background`); prints `tracks`/`solution_error`.
- **UNVERIFIED end-to-end.** First run `tracks:0` on a **static no-parallax** burst. **Need a real multi-angle spinner sequence; verify `solution_error` + output `.ply`; can't visually verify; Blender photogrammetry doesn't need my CUDA hardware.** `Meshroom`-dense + `gsplat` need NVIDIA (not used).

---

## Open / honest unknowns
- No point cloud/mesh produced on `PID_069C`. `Filter@FrameProcessor`. `Gemini2_v1.0.json`. `FilterProcessor` version. `CrealityScan` CUDA not used. No NVIDIA. `PID_069C`-vs-`Gemini215` protocol. **`tribuutscan` UNVERIFIED on your unit; tested Pro.** 
- **`N4b` 3D source class not shipped.** `orbbec`/`ferret-rgb`/`tribuutscan`-stdio source would plug in; `Observation`+`ref`, never raw points. 
- **Bounded-turntable note.** Nothing auto-downloads; nothing hardware spliced; no training touched.
