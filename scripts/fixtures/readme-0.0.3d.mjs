// One-shot README refresher for the 0.0.3d release (stale claims -> current state).
import fs from "node:fs";

let s = fs.readFileSync("README.md", "utf8");
let misses = [];
const swap = (from, to) => {
  if (!s.includes(from)) { misses.push(from.slice(0, 70)); return; }
  s = s.replace(from, to);
};

swap(
  "- **Not bundled**: speech-to-text (whisper sidecar), the `sbx` microVM sandbox (the detonation lane refuses plainly without it), the AfterImage engram (imported via subprocess - see `docs/ENGRAM_INTEGRATION.md`), and the AgentWatch `aw` CLI. Every absent dependency is stated plainly in the UI rather than faked.",
  "- **Not bundled**: speech-to-text (whisper sidecar), the AfterImage engram (imported via subprocess - see `docs/ENGRAM_INTEGRATION.md`), and the AgentWatch `aw` CLI. The detonation lane uses OS-level sandbox backends (WSL2 namespaces on Windows, bubblewrap on Linux, Seatbelt on macOS) - if none is available it refuses plainly. Every absent dependency is stated plainly in the UI rather than faked."
);

swap("- **Session switching** reloads the window (in-place tabs are on the roadmap).\n", "");

swap(
  "- **Linux/macOS builds**: the runtime is portable (llama.cpp engine, native Ollama, BYOK to any OpenAI-compatible server - including your own llama-server), but the packer currently stages Windows binaries only. An [Omarchy](https://omarchy.org) shell plugin is on the roadmap after the Linux build.",
  "- **Linux builds**: AppImage + deb are packaged and verified live (0.0.3d); the Windows packer stages the Vulkan engine binaries, while Linux runs use your own llama.cpp/Ollama or the engine from source. An [Omarchy](https://omarchy.org) shell plugin (sessions bar widget + panel) ships in `integrations/omarchy/`."
);

swap(
  "The full hand-driven pipeline lives in [`docs/RELEASE.md`](docs/RELEASE.md): version bump, pre-flight tests, engine staging with SHA-256 verification, `pack:dir`, a release-candidate checklist, artifact hashing, and the tag/publish template. `npm run pack:dir` has been verified end-to-end (engine staged, RC launched, own runtime, health green).",
  "The full hand-driven pipeline lives in [`docs/RELEASE.md`](docs/RELEASE.md): version bump, pre-flight tests, engine staging with SHA-256 verification, `pack:dir`, a release-candidate checklist, artifact hashing, and the tag/publish template.\n\n**Downloads ([releases](https://github.com/XxChonkExX/event-horizon-code/releases))** - tagged `0.0.3d`, marked latest:\n\n| Platform | Artifacts |\n|---|---|\n| Windows 10/11 | NSIS installer + MSI (Vulkan engine staged) |\n| Linux (deb/AppImage) | verified live on Omarchy/Arch |\n| Source | zip at each tag |\n\nEvery release ships a SHA-256 sheet; the binaries are unsigned, so verify before running."
);

swap(
  "Roadmap (post-alpha): Linux/macOS engine staging in the packer, an [Omarchy](https://omarchy.org) shell plugin (bar widget + session menu driven by the local runtime API), speech-to-text sidecar.",
  "Roadmap (post-alpha): macOS packaging, speech-to-text sidecar, and engine staging for Linux in the packer. The Omarchy shell plugin shipped in 0.0.3d."
);

swap(
  "- **Detonation lane** - requires an operator-installed `sbx` microVM; **without it the lane refuses plainly** (never a silent host fallback). Artifact delivery into the guest is not yet implemented and is not claimed — see the implemented/planned table in `docs/DETONATION.md` and `docs/SECURITY.md`.",
  "- **Detonation lane** - untrusted code executes inside per-platform OS-level sandboxes: WSL2 namespaces (Windows), bubblewrap (Linux), Seatbelt (macOS, best-effort). Artifact delivery, host-drive detachment, network isolation, and pgrep-confirmed tree termination are implemented and verified - with per-mechanic verification flags in every result and honest failure when any cannot be verified (`docs/DETONATION.md`)."
);

swap(
  "- Detonated tools (`run_js` with `tier=execute|redteam`) require `sbx`; without it the tool refuses plainly.",
  "- Detonated tools (`run_js` with `tier=execute|redteam`) require a sandbox backend - WSL2 namespaces (Windows), bubblewrap (Linux), or Seatbelt (macOS); without one the tool refuses plainly, never a silent host fallback."
);

swap(
  "Status: **v0.0.2 (alpha patch)**. Windows is the verified packaged target; the local runtime also builds/runs from source on Linux and macOS, but per-platform engine staging in the packer is still roadmap. Rough edges and deferrals are documented in `docs/`; please file issues.",
  "Status: **v0.0.3d (alpha)**. Windows (NSIS/MSI, Vulkan engine) and Linux (AppImage/deb, verified live on Omarchy) are packaged; macOS runs from source. Rough edges and deferrals are documented in `docs/`; please file issues."
);

s = s.replace(/(undefined\s*)+$/m, "").trimEnd() + "\n";

fs.writeFileSync("README.md", s);
console.log("README updated. misses:", misses.length ? misses : "none");
