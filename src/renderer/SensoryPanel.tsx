// Event Horizon Code - Sensory panel (S2)
// Eyes (vision via the engine's mtmd), ears (STT via whisper.cpp), mouth (TTS
// via piper). States what is present and what is missing - with the doctor's
// install guidance - instead of pretending. House rule: nothing downloads
// automatically; installs are operator-initiated.

import { createSignal, onMount } from "solid-js";
import { apiJson } from "./api";

type Sidecar = { bin: string | null; asset: string | null; ready: boolean; source: string | null };
type Status = { ears: Sidecar; mouth: Sidecar; notes: string[]; tried: { ears: string[]; mouth: string[] } };
type Doctor = Status & { install: string[] };

function flag(ready: boolean): string { return ready ? "[ready]" : "[missing]"; }

export default function SensoryPanel() {
  const [status, setStatus] = createSignal<Status | null>(null);
  const [doctor, setDoctor] = createSignal<Doctor | null>(null);
  const [note, setNote] = createSignal("Sidecars are never downloaded automatically. The doctor says exactly what to install and where.");

  const refresh = async (): Promise<void> => {
    try {
      setStatus(await apiJson<Status>("/api/sensory/status"));
    } catch { setNote("Server not running."); }
  };
  const runDoctor = async (): Promise<void> => {
    try {
      setDoctor(await apiJson<Doctor>("/api/sensory/doctor"));
    } catch { setNote("Server not running."); }
  };
  onMount(() => { void refresh(); void runDoctor(); });

  return (
    <div class="sensory-panel">
      <h3>Sensory</h3>
      {status() && (
        <ul class="sensory-list">
          <li>{flag(true)} eyes - vision (engine mtmd): engine lane only</li>
          <li title={status()!.ears.bin ?? undefined}>{flag(status()!.ears.ready)} ears - STT (whisper.cpp): {status()!.ears.ready ? status()!.ears.asset : "not installed"}</li>
          <li title={status()!.mouth.bin ?? undefined}>{flag(status()!.mouth.ready)} mouth - TTS (piper): {status()!.mouth.ready ? status()!.mouth.asset : "not installed"}</li>
        </ul>
      )}
      <div class="checks">
        <button onClick={() => void refresh()}>Refresh</button>
        <button onClick={() => void runDoctor()}>Doctor</button>
      </div>
      {doctor() && (
        <details>
          <summary class="session-meta">Doctor - what to install and where</summary>
          <ul class="sensory-list">
            {doctor()!.install.map((i) => <li class="session-meta">{i}</li>)}
          </ul>
        </details>
      )}
      <p>{note()}</p>
    </div>
  );
}
