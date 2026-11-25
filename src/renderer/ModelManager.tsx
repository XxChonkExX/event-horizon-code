// Event Horizon Code — Model Manager (bundled engine lane)
// Agnostic model dirs by default; "Choose folder" adds your own via native dialog.
// Start/stop the chonkllama sidecar with the selected GGUF. Optional mmproj path.
// Also home to BYOK secrets: keys are stored encrypted with the OS keychain
// where the desktop app provides it (docs/ENCRYPTION.md, phase E1). A stored
// provider (baseUrl + key + model) appears in the composer's picker as
// "byok:<provider>" and routes turns through that endpoint.

import { createSignal, For, Show, onMount } from "solid-js";
import { apiFetch, apiJson, pickFolder } from "./api";

type Gguf = { name: string; path: string; sizeBytes: number; dir: string };

type SecretBackup = { name: string; createdAt: string; bytes: number; providers: string[] };
type SecretStatus = {
  path: string;
  encryptionAvailable: boolean;
  storage: "os-keychain" | "plaintext-only";
  headlessNote: string | null;
  providers: Array<{ provider: string; hasKey: boolean; encrypted: boolean; decryptable: boolean | null; hasBaseUrl: boolean; baseUrl: string | null; model: string | null }>;
  backups: SecretBackup[];
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
  const [sModel, setSModel] = createSignal("");
  const [sKey, setSKey] = createSignal("");
  const [secNote, setSecNote] = createSignal("Keys are never shown after saving and never leave this machine.");
  // Two-step removal: the first click arms, the second within a few seconds deletes.
  const [armRemove, setArmRemove] = createSignal("");
  // Sealing existing keys is gated behind a plaintext backup: the confirm block
  // opens from "Encrypt stored keys"; "Encrypt now" stays disabled until a
  // backup was saved in this flow (a deliberate two-click bypass exists).
  const [encOpen, setEncOpen] = createSignal(false);
  const [backupPath, setBackupPath] = createSignal<string | null>(null);
  const [encSkipArm, setEncSkipArm] = createSignal(false);
  // Per-provider model catalog: "models" probes the endpoint's /models and the
  // list offers click-to-set (writes the provider's model via /api/secrets).
  const [probeFor, setProbeFor] = createSignal("");
  const [probeModels, setProbeModels] = createSignal<string[]>([]);

  const plainCount = () => (sec()?.providers ?? []).filter((p) => p.hasKey && !p.encrypted).length;

  const refreshSecrets = async () => {
    try { setSec(await apiJson<SecretStatus>("/api/secrets/status")); } catch { /* server not running */ }
  };
  onMount(() => void refreshSecrets());

  const saveSecret = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/secrets", {
        method: "POST",
        body: JSON.stringify({ provider: sp().trim(), baseUrl: sUrl().trim(), apiKey: sKey() || undefined, model: sModel().trim() || undefined }),
      });
      const d = (await r.json()) as { ok: boolean; encrypted?: boolean; error?: string };
      setSKey(""); // the key never lingers in the DOM
      if (!d.ok) { setSecNote(`save failed: ${d.error ?? "?"}`); return; }
      setSecNote(d.encrypted
        ? "saved - encrypted with the OS keychain"
        : "saved as PLAINTEXT - OS keychain encryption is unavailable in this runtime (use the desktop app)");
      setSUrl(""); setSModel("");
      await refreshSecrets();
    } catch { setSecNote("save failed - server unreachable"); } finally { setBusy(false); }
  };

  // "Does this key work?" - one 1-token completion on the provider's own
  // endpoint, through the same call the agent lane makes.
  const testProvider = async (provider: string) => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/secrets/${encodeURIComponent(provider)}/test`, { method: "POST", body: "{}" });
      const d = (await r.json()) as { ok: boolean; model?: string; latencyMs?: number; error?: string };
      const secs = Math.round((d.latencyMs ?? 0) / 100) / 10;
      setSecNote(d.ok ? `${provider}: key works (${d.model}, ${secs}s round trip)` : `${provider}: ${d.error ?? "test failed"}`);
    } catch { setSecNote("test failed - server unreachable"); } finally { setBusy(false); }
  };

  // "What models does this endpoint offer?" - the provider's own /models.
  const probeProviderModels = async (provider: string) => {
    if (probeFor() === provider) { setProbeFor(""); setProbeModels([]); return; }
    setBusy(true);
    try {
      const r = await apiFetch(`/api/secrets/${encodeURIComponent(provider)}/models`);
      const d = (await r.json()) as { ok: boolean; models?: string[]; error?: string };
      if (!d.ok) { setSecNote(`${provider}: ${d.error ?? "model probe failed"}`); return; }
      setProbeFor(provider);
      setProbeModels(d.models ?? []);
      setSecNote(`${provider}: ${d.models?.length ?? 0} models on the endpoint - click one to set it as this provider's model`);
    } catch { setSecNote("model probe failed - server unreachable"); } finally { setBusy(false); }
  };

  const setProviderModel = async (provider: string, model: string) => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/secrets", { method: "POST", body: JSON.stringify({ provider, model }) });
      const d = (await r.json()) as { ok: boolean; error?: string };
      if (!d.ok) { setSecNote(`save failed: ${d.error ?? "?"}`); return; }
      setSecNote(`${provider}: model set to ${model}`);
      await refreshSecrets();
    } catch { setSecNote("save failed - server unreachable"); } finally { setBusy(false); }
  };

  const saveBackup = async () => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/secrets/backup", { method: "POST", body: "{}" });
      const d = (await r.json()) as { ok: boolean; path?: string; error?: string };
      if (!d.ok) { setSecNote(`backup failed: ${d.error ?? "?"}`); return; }
      setBackupPath(d.path ?? null);
      setSecNote(`plaintext backup saved: ${d.path} - move it somewhere safe (password manager), then delete it here`);
      await refreshSecrets();
    } catch { setSecNote("backup failed - server unreachable"); } finally { setBusy(false); }
  };

  const deleteBackup = async (name: string) => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/secrets/backups/${encodeURIComponent(name)}`, { method: "DELETE" });
      const d = (await r.json()) as { ok: boolean; error?: string };
      setSecNote(d.ok ? `deleted plaintext backup ${name}` : `delete failed: ${d.error ?? "?"}`);
      await refreshSecrets();
    } catch { setSecNote("delete failed - server unreachable"); } finally { setBusy(false); }
  };

  const encryptStored = async (withBackup: boolean) => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/secrets/encrypt", { method: "POST", body: "{}" });
      const d = (await r.json()) as { ok: boolean; encrypted?: number; already?: number; settled?: boolean; error?: string };
      if (!d.ok) { setSecNote(`encrypt failed: ${d.error ?? "?"}`); return; }
      setEncOpen(false); setEncSkipArm(false);
      setSecNote(
        `encrypted ${d.encrypted ?? 0} key(s); ${d.already ?? 0} already encrypted` +
        (d.settled === false ? " - NOTE: the OS keychain's key could not be confirmed on disk" : "") +
        (withBackup ? "" : " (NO backup was taken)") +
        (backupPath() ? ` - plaintext backup: ${backupPath()}` : ""),
      );
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
          <>
          <li class="session-meta secret-row">
            <span class="secret-provider">
              <span>{p.provider}{p.model ? ` - ${p.model}` : " (no model set)"}</span>
              <span class="secret-sub">{p.baseUrl ?? "no base URL"}</span>
            </span>
            <span
              class="status-badge"
              classList={{ "secret-enc": p.encrypted && p.decryptable !== false, "secret-bad": p.encrypted && p.decryptable === false }}
              title={p.encrypted ? "encrypted with the OS keychain" : "stored in plaintext"}
            >
              {p.encrypted ? (p.decryptable === false ? "encrypted - undecryptable here" : "encrypted") : "plaintext"}
            </span>
            <button
              disabled={busy() || !p.hasKey || !p.hasBaseUrl}
              title="List the models this endpoint offers (GET /models on the provider)"
              onClick={() => void probeProviderModels(p.provider)}
            >{probeFor() === p.provider ? "close" : "models"}</button>
            <button
              disabled={busy() || !p.hasKey || !p.hasBaseUrl || !p.model}
              title="One small completion (128 tokens max) through the same call the agent makes - thinking models can take a minute on some providers"
              onClick={() => void testProvider(p.provider)}
            >test</button>
            <button disabled={busy() || (!p.hasKey && !p.hasBaseUrl)} onClick={() => void removeSecret(p.provider)}>
              {armRemove() === p.provider ? "confirm remove" : "remove"}
            </button>
          </li>
          <Show when={probeFor() === p.provider}>
            <li class="session-meta">
              <select
                size={6}
                style={{ width: "100%" }}
                value={p.model ?? ""}
                onChange={(e) => void setProviderModel(p.provider, e.target.value)}
              >
                <For each={probeModels()}>{(m) => <option value={m}>{m}{m === p.model ? "   <- current" : ""}</option>}</For>
              </select>
              <span class="secret-sub">click a model to set it as this provider's model</span>
            </li>
          </Show>
          </>
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
          model (used by the agent):
          <input class="secret-input" value={sModel()} onInput={(e) => setSModel(e.target.value)} placeholder="gpt-4o-mini" autocomplete="off" spellcheck={false} />
        </label>
        <label class="span2">
          base URL (optional):
          <input class="secret-input" value={sUrl()} onInput={(e) => setSUrl(e.target.value)} placeholder="https://api.openai.com/v1" autocomplete="off" spellcheck={false} />
        </label>
        <label class="span2">
          API key:
          <input type="password" class="secret-input" value={sKey()} onInput={(e) => setSKey(e.target.value)} placeholder="paste the key - it is never shown again" autocomplete="off" spellcheck={false} />
        </label>
      </div>
      <div class="checks">
        <button disabled={busy() || (!sKey() && !sUrl().trim() && !sModel().trim())} onClick={() => void saveSecret()}>Save key</button>
        <button
          disabled={busy() || !sec()?.encryptionAvailable || plainCount() === 0}
          title="Seal every plaintext key already in the file (a backup is offered first)"
          onClick={() => { setEncOpen(true); setBackupPath(null); setEncSkipArm(false); }}
        >Encrypt stored keys</button>
        <button disabled={busy()} onClick={() => void refreshSecrets()}>Refresh</button>
      </div>
      <Show when={encOpen()}>
        <div class="secret-confirm">
          <p>Seal {plainCount()} stored key(s) with the OS keychain. A sealed key can only be read by this app, on this machine, as this OS user - a headless runtime cannot use it.</p>
          <p>
            1. Save a plaintext backup first (kept under ~/.eventhorizon/backups):{" "}
            <button disabled={busy()} onClick={() => void saveBackup()}>Save backup</button>
            {backupPath() ? " - saved" : ""}
          </p>
          <p>
            2.{" "}
            <button disabled={busy() || !backupPath()} onClick={() => void encryptStored(true)}>Encrypt now</button>
            {" "}or{" "}
            <button
              class="danger"
              disabled={busy()}
              onClick={() => { if (!encSkipArm()) { setEncSkipArm(true); return; } void encryptStored(false); }}
            >{encSkipArm() ? "Encrypt WITHOUT backup - confirm" : "Encrypt without backup"}</button>
          </p>
        </div>
      </Show>
      <Show when={(sec()?.backups ?? []).length > 0}>
        <p class="session-meta">Plaintext backups on this machine - move them somewhere safe, then delete here:</p>
        <ul class="sensory-list">
          <For each={sec()?.backups ?? []}>{(b) => (
            <li class="session-meta secret-row">
              <span class="secret-provider">
                <span>{b.name}</span>
                <span class="secret-sub">{new Date(b.createdAt).toLocaleString()} - {b.providers.join(", ") || "empty"}</span>
              </span>
              <button disabled={busy()} onClick={() => void deleteBackup(b.name)}>delete</button>
            </li>
          )}</For>
        </ul>
      </Show>
      {/* The verdict sits directly under the buttons: "encrypted" versus
          "PLAINTEXT" has to be seen, not found. */}
      <p class="secret-note" classList={{ "secret-warn": /PLAINTEXT|failed|NO backup|NOTE:/i.test(secNote()) }}>{secNote()}</p>
    </div>
  );
}
