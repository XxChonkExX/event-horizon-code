// Event Horizon Code - Profiles panel
// User-level defaults that survive across projects: default model, reasoning
// level, output budget, auto-approve. The active profile feeds every prompt
// (request param > active profile > project config > built-in default), so
// this is where "how my agent behaves" is set once and applies everywhere.

import { createSignal, onMount } from "solid-js";
import { apiFetch, apiJson } from "./api";

type Profile = { id: string; name: string; settings: Record<string, unknown>; created: string };
type ProfileSettings = { model?: string; think?: string; tokens?: number; autoApprove?: boolean };

const THINK_LEVELS = ["low", "medium", "high", "max"] as const;

export default function ProfilesPanel() {
  const [profiles, setProfiles] = createSignal<Profile[]>([]);
  const [active, setActive] = createSignal<string>("default");
  const [models, setModels] = createSignal<string[]>([]);
  // Form state for the profile being edited ("" id = new profile).
  const [editId, setEditId] = createSignal<string>("");
  const [name, setName] = createSignal<string>("");
  const [model, setModel] = createSignal<string>("");
  const [think, setThink] = createSignal<string>("medium");
  const [tokens, setTokens] = createSignal<number>(1024);
  const [autoApprove, setAutoApprove] = createSignal<boolean>(false);
  const [note, setNote] = createSignal("Profiles are user defaults. The active profile applies to every chat and SOP run.");
  const [busy, setBusy] = createSignal(false);

  const refresh = async () => {
    try {
      const [list, act, modelList] = await Promise.all([
        apiJson<Profile[]>("/api/profiles"),
        apiJson<{ id: string }>("/api/profiles/active"),
        apiJson<Array<{ id: string }>>("/api/models"),
      ]);
      setProfiles(list);
      setActive(act.id);
      setModels(modelList.map((m) => m.id));
    } catch { setNote("Server not running."); }
  };
  onMount(() => void refresh());

  const startEdit = (p: Profile | null): void => {
    if (p) {
      const s = (p.settings ?? {}) as ProfileSettings;
      setEditId(p.id);
      setName(p.name);
      setModel(s.model ?? "");
      setThink(s.think ?? "medium");
      setTokens(typeof s.tokens === "number" ? s.tokens : 1024);
      setAutoApprove(s.autoApprove === true);
    } else {
      setEditId("");
      setName("");
      setModel("");
      setThink("medium");
      setTokens(1024);
      setAutoApprove(false);
    }
  };

  const save = async (): Promise<void> => {
    const id = editId().trim() || `profile_${Date.now().toString(36)}`;
    setBusy(true);
    try {
      const settings: ProfileSettings = {
        model: model() || undefined,
        think: think(),
        tokens: tokens(),
        autoApprove: autoApprove(),
      };
      const r = await apiFetch("/api/profiles", { method: "POST", body: JSON.stringify({ id, name: name().trim() || id, settings }) });
      const d = (await r.json()) as { id?: string; error?: string };
      setNote(d.id ? `Saved profile "${d.id}".` : d.error ?? "save failed");
      setEditId(id);
      await refresh();
    } finally { setBusy(false); }
  };

  const setActiveProfile = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiFetch("/api/profiles/active", { method: "POST", body: JSON.stringify({ id }) });
      const d = (await r.json()) as { id?: string; error?: string };
      if (d.id) { setActive(d.id); setNote(`Active profile: ${d.id}.`); }
      else setNote(d.error ?? "failed");
    } finally { setBusy(false); }
  };

  const remove = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      const r = await apiFetch(`/api/profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
      const d = (await r.json()) as { ok: boolean; error?: string };
      setNote(d.ok ? `Deleted "${id}".` : d.error ?? "delete failed");
      if (editId() === id) startEdit(null);
      await refresh();
    } finally { setBusy(false); }
  };

  return (
    <div class="profiles-panel">
      <h3>Profiles</h3>
      <select size={4} style={{ width: "100%" }} onChange={(e) => {
        const p = profiles().find((x) => x.id === e.target.value);
        if (p) startEdit(p);
      }}>
        {profiles().map((p) => (
          <option value={p.id}>{p.id === active() ? "* " : ""}{p.id} - {p.name}{(p.settings as ProfileSettings)?.model ? ` - ${(p.settings as ProfileSettings).model}` : ""}</option>
        ))}
      </select>
      <div class="checks">
        <button disabled={busy()} onClick={() => void setActiveProfile(editId() || active())} title="Make the selected profile active">Set active</button>
        <button disabled={busy() || !editId()} onClick={() => void remove(editId())}>Delete</button>
        <button disabled={busy()} onClick={() => startEdit(null)}>New</button>
        <button disabled={busy()} onClick={() => void refresh()}>Refresh</button>
      </div>

      <label>
        id {editId() ? "" : "(new)"}
        <input value={editId()} onInput={(e) => setEditId(e.target.value)} placeholder="default" style={{ width: "100%" }} />
      </label>
      <label>
        name
        <input value={name()} onInput={(e) => setName(e.target.value)} placeholder="Everyday coding" style={{ width: "100%" }} />
      </label>
      <label>
        model
        <select style={{ width: "100%" }} value={model()} onChange={(e) => setModel(e.target.value)}>
          <option value="">(lane default - engine/Ollama pick)</option>
          {models().map((m) => <option value={m}>{m}</option>)}
        </select>
      </label>
      <label>
        reasoning (/think level)
        <select style={{ width: "100%" }} value={think()} onChange={(e) => setThink(e.target.value)}>
          {THINK_LEVELS.map((t) => <option value={t}>{t}</option>)}
        </select>
      </label>
      <label>
        output tokens
        <input type="number" min={64} max={8192} step={64} value={tokens()} onInput={(e) => setTokens(Number(e.target.value) || 1024)} style={{ width: "100%" }} />
      </label>
      <label class="check">
        <input type="checkbox" checked={autoApprove()} onChange={(e) => setAutoApprove(e.currentTarget.checked)} />
        auto-approve tools by default
      </label>
      <div class="checks">
        <button disabled={busy()} onClick={() => void save()}>Save profile</button>
      </div>
      <p>{note()}</p>
    </div>
  );
}
