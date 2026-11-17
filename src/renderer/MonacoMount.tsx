// Event Horizon Code — Monaco mount (real editor, MIT, from microsoft/vscode)
// Language inferred from extension. Content loaded via server read tool (permission: allow).
// Save button = operator approval for the edit tool (explicit human action).
// The file is opened with the language server on load, changes stream to it
// (debounced), and publishDiagnostics events land as Monaco markers.
// Classes ehc-prefixed to avoid collisions with Monaco's internal stylesheet.

import { onMount, onCleanup } from "solid-js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import { apiFetch, runtimeInfo, eventStreamTicket } from "./api";

(self as unknown as { MonacoEnvironment: { getWorker: (workerId: string, label: string) => Worker } }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
  mjs: "javascript", cjs: "javascript", py: "python", rs: "rust", go: "go",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp",
  java: "java", rb: "ruby", php: "php", lua: "lua", sql: "sql", sh: "shell",
  bash: "shell", zsh: "shell", html: "html", css: "css", scss: "scss",
  json: "json", md: "markdown", yml: "yaml", yaml: "yaml", xml: "xml",
  swift: "swift", kt: "kotlin", scala: "scala", hs: "haskell", ml: "ocaml",
  ex: "elixir", exs: "elixir", dart: "dart", proto: "proto", graphql: "graphql",
};

// LSP severity (1 Error, 2 Warning, 3 Info, 4 Hint) -> Monaco severity.
const SEVERITY: Record<number, monaco.MarkerSeverity> = {
  1: monaco.MarkerSeverity.Error,
  2: monaco.MarkerSeverity.Warning,
  3: monaco.MarkerSeverity.Info,
  4: monaco.MarkerSeverity.Hint,
};

type LspDiagnostic = {
  range?: { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } };
  severity?: number;
  message?: string;
  source?: string;
  code?: unknown;
};

export default function MonacoMount(props: { file: string; worktree?: string }) {
  let ref: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;
  let currentModel: monaco.editor.ITextModel | null = null;
  let version = 0;
  let openedFile = "";
  let changeTimer: ReturnType<typeof setTimeout> | null = null;
  let diagSource: EventSource | null = null;

  function langFor(file: string): string {
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    return LANG_BY_EXT[ext] ?? "plaintext";
  }

  function worktree(): string { return props.worktree ?? "."; }

  function setMarkers(uri: string, diagnostics: LspDiagnostic[]): void {
    if (!currentModel) return;
    // Only apply diagnostics for the file on screen (payload carries an abs path;
    // compare loosely by suffix so worktree prefixes do not have to match exactly).
    const fileNorm = props.file.replace(/\\/g, "/").toLowerCase();
    const uriNorm = (uri || "").replace(/\\/g, "/").replace(/^file:\/\/\//, "").toLowerCase();
    if (fileNorm && !uriNorm.endsWith(fileNorm.split("/").pop() ?? "")) return;
    const markers: monaco.editor.IMarkerData[] = diagnostics.slice(0, 200).map((d) => ({
      startLineNumber: (d.range?.start?.line ?? 0) + 1,
      startColumn: (d.range?.start?.character ?? 0) + 1,
      endLineNumber: (d.range?.end?.line ?? d.range?.start?.line ?? 0) + 1,
      endColumn: (d.range?.end?.character ?? d.range?.start?.character ?? 0) + 1,
      severity: SEVERITY[d.severity ?? 1] ?? monaco.MarkerSeverity.Error,
      message: d.message ?? "",
      source: d.source,
      ...(d.code !== undefined ? { code: String(d.code) } : {}),
    }));
    monaco.editor.setModelMarkers(currentModel, "lsp", markers);
  }

  // One SSE stream per worktree, shared for the lifetime of the mount.
  async function openDiagnosticsStream(): Promise<void> {
    try {
      const rt = await runtimeInfo();
      if (!rt) return;
      const ticket = await eventStreamTicket();
      const q = `ticket=${encodeURIComponent(ticket)}&worktree=${encodeURIComponent(worktree())}`;
      diagSource?.close();
      diagSource = new EventSource(`${rt.baseUrl}/api/events?${q}`);
      diagSource.addEventListener("diagnostics", (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { payload?: { uri?: string; diagnostics?: LspDiagnostic[] } };
          if (data.payload?.uri) setMarkers(data.payload.uri, data.payload.diagnostics ?? []);
        } catch { /* malformed event - ignore */ }
      });
    } catch { /* SSE unavailable - editor still works without markers */ }
  }

  function toLspMarkersAware(absPath: string): string {
    // The server wants a workspace-relative path.
    const wt = (props.worktree ?? "").replace(/\\/g, "/");
    const p = absPath.replace(/\\/g, "/");
    return wt && p.toLowerCase().startsWith(wt.toLowerCase() + "/") ? p.slice(wt.length + 1) : p;
  }

  async function lspOpen(file: string, text: string): Promise<void> {
    const rel = toLspMarkersAware(file);
    try {
      const res = await apiFetch("/api/lsp/open", { method: "POST", body: JSON.stringify({ worktree: worktree(), path: rel, text, version: 1 }) });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!data.ok && data.error && ref) ref.dataset.lsp = `lsp: ${data.error}`;
      else if (ref) ref.dataset.lsp = "lsp: on";
    } catch { /* server unreachable - markers simply stay off */ }
  }

  async function lspChange(): Promise<void> {
    if (!editor || !openedFile) return;
    const rel = toLspMarkersAware(openedFile);
    try {
      await apiFetch("/api/lsp/change", { method: "POST", body: JSON.stringify({ worktree: worktree(), path: rel, text: editor.getValue(), version: ++version }) });
    } catch { /* transient - next change retries */ }
  }

  async function lspClose(file: string): Promise<void> {
    const rel = toLspMarkersAware(file);
    try { await apiFetch("/api/lsp/close", { method: "POST", body: JSON.stringify({ worktree: worktree(), path: rel }) }); } catch { /* ignore */ }
  }

  async function loadFile(file: string) {
    if (!editor) return;
    try {
      const res = await apiFetch("/api/tools/call", {
        method: "POST",
        body: JSON.stringify({ tool: "read", args: { path: file }, worktree: worktree() }),
      });
      const data = (await res.json()) as { ok: boolean; out?: string; error?: string };
      const text = data.ok ? (data.out ?? "") : `// ${data.error ?? "read failed"}`;
      if (openedFile && openedFile !== file) void lspClose(openedFile);
      currentModel?.dispose();
      currentModel = monaco.editor.createModel(text, langFor(file), monaco.Uri.file(file));
      editor.setModel(currentModel);
      monaco.editor.setModelMarkers(currentModel, "lsp", []);
      openedFile = file;
      version = 1;
      void lspOpen(file, text);
    } catch {
      currentModel?.dispose();
      currentModel = monaco.editor.createModel(`// server unreachable for ${file}`, "plaintext");
      editor.setModel(currentModel);
    }
  }

  async function saveFile() {
    if (!editor || !currentModel) return;
    const text = editor.getValue();
    const res = await apiFetch("/api/tools/call", {
      method: "POST",
      body: JSON.stringify({ tool: "edit", args: { path: props.file, newText: text, approved: true }, worktree: worktree() }),
    });
    const data = (await res.json()) as { ok: boolean; out?: string; error?: string };
    // Operator pressed Save = approval. Result shows in status line.
    if (ref) ref.dataset.status = data.ok ? `saved: ${data.out ?? ""}` : `save failed: ${data.error ?? ""}`;
    // The server now holds the saved content - re-sync the language server.
    void lspChange();
  }

  onMount(() => {
    if (!ref) return;
    editor = monaco.editor.create(ref, {
      value: "// loading…",
      language: "plaintext",
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: true },
      fontSize: 13,
      tabSize: 2,
    });
    // Debounced didChange: typing must not flood the language server.
    editor.onDidChangeModelContent(() => {
      if (changeTimer) clearTimeout(changeTimer);
      changeTimer = setTimeout(() => void lspChange(), 500);
    });
    void loadFile(props.file);
    void openDiagnosticsStream();
    onCleanup(() => {
      if (changeTimer) clearTimeout(changeTimer);
      diagSource?.close();
      if (openedFile) void lspClose(openedFile);
      editor?.dispose();
      currentModel?.dispose();
    });
  });

  // Reload when the file changes (FileTree selection)
  let lastFile = props.file;
  const timer = setInterval(() => {
    if (props.file !== lastFile) { lastFile = props.file; void loadFile(props.file); }
  }, 300);
  onCleanup(() => clearInterval(timer));

  return (
    <div class="ehc-editor-shell">
      <div class="ehc-toolbar">
        <span>{props.file}</span>
        <button onClick={() => void saveFile()}>Save (approves edit)</button>
      </div>
      <div class="ehc-monaco" ref={ref} />
    </div>
  );
}
