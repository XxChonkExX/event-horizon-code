// Event Horizon Code — Toolchain Doctor panel (SolidJS)
// Fetches /api/toolchain from local server. No filesystem via IPC.

import { createSignal, onMount } from "solid-js";
import { apiJson } from "./api";

type ToolCheck = {
  lang: string;
  displayName: string;
  cmd: string;
  ok: boolean;
  version: string;
  error?: string;
};

export default function ToolchainDoctor() {
  const [checks, setChecks] = createSignal<ToolCheck[]>([]);
  const [loading, setLoading] = createSignal(true);

  onMount(async () => {
    try {
      const data = await apiJson<ToolCheck[]>("/api/toolchain");
      setChecks(data);
    } catch {
      setChecks([]);
    } finally {
      setLoading(false);
    }
  });

  const byLang = () => {
    const map = new Map<string, ToolCheck[]>();
    for (const c of checks()) {
      if (!map.has(c.displayName)) map.set(c.displayName, []);
      map.get(c.displayName)!.push(c);
    }
    return Array.from(map.entries());
  };

  if (loading()) return <div>Checking toolchain…</div>;
  if (checks().length === 0) return <div>Toolchain check unavailable (server not running).</div>;

  return (
    <div class="toolchain-doctor">
      <h3>Toolchain Doctor</h3>
      {byLang().map(([name, items]) => {
        const allOk = items.every((i) => i.ok);
        return (
          <details open={allOk ? undefined : true}>
            <summary>{allOk ? "OK " : "Missing "} {name}</summary>
            <ul>
              {items.map((i) => (
                <li>
                  {i.ok ? "✓ " : "✗ "} {i.cmd} — {i.version || i.error}
                </li>
              ))}
            </ul>
          </details>
        );
      })}
    </div>
  );
}
