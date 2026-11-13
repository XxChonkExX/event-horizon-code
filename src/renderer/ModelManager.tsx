// Event Horizon Code — Model Manager (bundled engine lane)
// Agnostic model dirs by default; "Choose folder" adds your own via native dialog.
// Start/stop the chonkllama sidecar with the selected GGUF. Optional mmproj path.

import { createSignal, onMount } from "solid-js";
import { apiFetch, apiJson, pickFolder } from "./api";

type Gguf = { name: string; path: string; sizeBytes: number; dir: string };

export default function ModelManager() {
  const [models, setModels] = createSignal<Gguf[]>([]);
  const [selected, setSelected] = createSignal<string>("");
  const [mmproj, setMmproj] = createSignal<string>("");
  const [note, setNote] = createSignal("Agnostic defaults: ~/.eventhorizon/models + ./models. Add your own below.");
  const [busy, setBusy] = createSignal(false);

  const refresh = async () => {
    try {
      const list = await apiJson<Gguf[]>("/api/engine/models");
      setModels(list);
      if (!selected() && list.length) setSelected(list[0].path);
    } catch { setNote("Server not running."); }
  };
  onMount(() => void refresh());

  const chooseFolder = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setBusy(true);
    try {
      const r = await apiFetch("/api/engine/models/dirs", { method: "POST", body: JSON.stringify({ dir }) });
      const d = (await r.json()) as { ok: boolean; error?: string };
      setNote(d.ok ? `Added ${dir}` : d.error ?? "failed");
      await refresh();
    } finally { setBusy(false); }
  };

  const start = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/engine/start", {
        method: "POST",
        body: JSON.stringify({ ggufPath: selected(), mmprojPath: mmproj() || undefined }),
      });
      const d = (await r.json()) as { ok: boolean; note: string };
      setNote(d.note);
    } finally { setBusy(false); }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/engine/stop", { method: "POST", body: "{}" });
      const d = (await r.json()) as { note: string };
      setNote(d.note);
    } finally { setBusy(false); }
  };

  return (
    <div class="model-manager">
      <h3>Models</h3>
      <select size={4} style={{ width: "100%" }} value={selected()} onChange={(e) => setSelected(e.target.value)}>
        {models().map((m) => (
          <option value={m.path}>{m.name} ({Math.round(m.sizeBytes / 1048576)} MB)</option>
        ))}
      </select>
      <div class="checks">
        <button disabled={busy()} onClick={() => void chooseFolder()}>Choose folder…</button>
        <button disabled={busy() || !selected()} onClick={() => void start()}>Start engine</button>
        <button disabled={busy()} onClick={() => void stop()}>Stop</button>
        <button disabled={busy()} onClick={() => void refresh()}>Refresh</button>
      </div>
      <label>
        mmproj (vision, optional):
        <input value={mmproj()} onInput={(e) => setMmproj(e.target.value)} placeholder="path to mmproj gguf" style={{ width: "100%" }} />
      </label>
      <p>{note()}</p>
    </div>
  );
}
