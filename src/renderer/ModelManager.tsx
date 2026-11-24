// Event Horizon Code — Model Manager (bundled engine lane)
// Agnostic model dirs by default; "Choose folder" adds your own via native dialog.
// Start/stop the chonkllama sidecar with the selected GGUF. Optional mmproj path.
// Also home to BYOK secrets: keys are stored encrypted with the OS keychain
// where the desktop app provides it (docs/ENCRYPTION.md, phase E1).

import { createSignal, For, Show, onMount } from "solid-js";
import { apiFetch, apiJson, pickFolder } from "./api";

type Gguf = { name: string; path: string; sizeBytes: number; dir: string };

type SecretStatus = {
  path: string;
  encryptionAvailable: boolean;
  storage: "os-keychain" | "plaintext-only";
  headlessNote: string | null;
  providers: Array<{ provider: string; hasKey: boolean; encrypted: boolean; decryptable: boolean | null; hasBaseUrl: boolean }>;
};

export default function ModelManager() {
  const [models, setModels] = createSignal<Gguf[]>([]);
  const [selected, setSelected] = createSignal<string>("");
  const [mmproj, setMmproj] = createSignal<string>("");
  const [note, setNote] = createSignal("Agnostic defaults: ~/.eventhorizon/models + ./models. Add your own below.");
  const [busy, setBusy] = createSignal(false);

  // ---- BYOK secrets ----
  const [sec, setSec] = createSignal<SecretStatus | null>(null);
  const [sp, setSp] = createSignal("openai");
  const [sUrl, setSUrl] = createSignal("");
  const [sKey, setSKey] = createSignal("");
  const [secNote, setSecNote] = createSignal("Keys are never shown after saving and never leave this machine.");
  // Two-step removal: the first click arms, the second within a few seconds deletes.
  const [armRemove, setArmRemove] = createSignal("");

  const refreshSecrets = async () => {
    try { setSec(await apiJson<SecretStatus>("/api/secrets/status")); } catch { /* server not running */ }
  };
  onMount(() => void refreshSecrets());

  const saveSecret = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/secrets", { method: "POST", body: JSON.stringify({ provider: sp().trim(), baseUrl: sUrl().trim(), apiKey: sKey() || undefined }) });
      const d = (await r.json()) as { ok: boolean; encrypted?: boolean; error?: string };
      setSKey(""); // the key never lingers in the DOM
      if (!d.ok) { setSecNote(`save failed: ${d.error ?? "?"}`); return; }
      setSecNote(d.encrypted ? "saved - encrypted with the OS keychain" : "saved as PLAINTEXT - OS keychain encryption is unavailable in this runtime (use the desktop app)");
      setSUrl("");
      await refreshSecrets();
    } catch {
      setSecNote("save failed - server unreachable");
    } finally { setBusy(false); }
  };

  const encryptStored = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/secrets/encrypt", { method: "POST", body: "{}" });
      const d = (await r.json()) as { ok: boolean; encrypted?: number; already?: number; error?: string };
      setSecNote(d.ok ? `encrypted ${d.encrypted ?? 0} key(s); ${d.already ?? 0} already encrypted` : `encrypt failed: ${d.error ?? "?"}`);
      await refreshSecrets();
    } catch { setSecNote("encrypt failed - server unreachable"); } finally { setBusy(false); }
  };

  const removeSecret = async (provider: string) => {
    if (armRemove() !== provider) {
      setArmRemove(provider);
      setTimeout(() => setArmRemove((cur) => (cur === provider ? "" : cur)), 4000);
      return;
    }
    setArmRemove("");
    setBusy(true);
    try {
      const r = await apiFetch(`/api/secrets/${encodeURIComponent(provider)}`, { method: "DELETE" });
      const d = (await r.json()) as { ok: boolean; error?: string };
      setSecNote(d.ok ? `removed "${provider}"` : `remove failed: ${d.error ?? "?"}`);
      await refreshSecrets();
    } catch { setSecNote("remove failed - server unreachable"); } finally { setBusy(false); }
  };

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

      <h3>BYOK secrets</h3>
      <p class="session-meta" title={sec()?.path ?? "secrets file location"}>
        {sec() ? (sec()!.encryptionAvailable ? "Storage: OS keychain (keys encrypted at rest)" : "Storage: plaintext only") : "Secrets status unavailable - is the server running?"}
      </p>
      <Show when={sec()?.headlessNote}><p class="session-meta">{sec()!.headlessNote}</p></Show>
      <ul class="sensory-list">
        <For each={sec()?.providers ?? []}>{(p) => (
          <li class="session-meta secret-row">
            <span class="secret-provider">{p.provider}</span>
            <span
              class="status-badge"
              classList={{ "secret-enc": p.encrypted && p.decryptable !== false, "secret-bad": p.encrypted && p.decryptable === false }}
              title={p.encrypted ? "encrypted with the OS keychain" : "stored in plaintext"}
            >
              {p.encrypted ? (p.decryptable === false ? "encrypted - undecryptable here" : "encrypted") : "plaintext"}
            </span>
            <button disabled={busy() || (!p.hasKey && !p.hasBaseUrl)} onClick={() => void removeSecret(p.provider)}>
              {armRemove() === p.provider ? "confirm remove" : "remove"}
            </button>
          </li>
        )}</For>
      </ul>
      {/* Compact on purpose: the panel body is capped at 26vh (styles.css
          .panel-body), so a stacked form pushes the storage verdict off-screen. */}
      <div class="secret-form">
        <label>
          provider id:
          <input class="secret-input" value={sp()} onInput={(e) => setSp(e.target.value)} placeholder="openai" autocomplete="off" spellcheck={false} />
        </label>
        <label>
          base URL (optional):
          <input class="secret-input" value={sUrl()} onInput={(e) => setSUrl(e.target.value)} placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck={false} />
        </label>
        <label>
          API key:
          <input type="password" class="secret-input" value={sKey()} onInput={(e) => setSKey(e.target.value)} placeholder="paste the key - it is never shown again" autocomplete="off" spellcheck={false} />
        </label>
      </div>
      <div class="checks">
        <button disabled={busy() || (!sKey() && !sUrl().trim())} onClick={() => void saveSecret()}>Save key</button>
        <button disabled={busy() || !(sec()?.encryptionAvailable)} title="Encrypt every plaintext key already in the file" onClick={() => void encryptStored()}>Encrypt stored keys</button>
        <button disabled={busy()} onClick={() => void refreshSecrets()}>Refresh</button>
      </div>
      {/* The verdict sits directly under the buttons: "encrypted" versus
          "PLAINTEXT" has to be seen, not found. */}
      <p class="secret-note" classList={{ "secret-warn": /PLAINTEXT|failed/i.test(secNote()) }}>{secNote()}</p>
    </div>
  );
}
