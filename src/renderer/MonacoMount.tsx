// Event Horizon Code — Monaco mount (real editor, MIT, from microsoft/vscode)
// Language inferred from extension. Content loaded via server read tool (permission: allow).
// Save button = operator approval for the edit tool (explicit human action).
// Classes ehc-prefixed to avoid collisions with Monaco's internal stylesheet.

import { onMount, onCleanup } from "solid-js";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import { apiFetch } from "./api";

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

export default function MonacoMount(props: { file: string; worktree?: string }) {
  let ref: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneCodeEditor | null = null;
  let currentModel: monaco.editor.ITextModel | null = null;

  function langFor(file: string): string {
    const ext = file.split(".").pop()?.toLowerCase() ?? "";
    return LANG_BY_EXT[ext] ?? "plaintext";
  }

  async function loadFile(file: string) {
    if (!editor) return;
    try {
      const res = await apiFetch("/api/tools/call", {
        method: "POST",
        body: JSON.stringify({ tool: "read", args: { path: file }, worktree: props.worktree ?? "." }),
      });
      const data = (await res.json()) as { ok: boolean; out?: string; error?: string };
      const text = data.ok ? (data.out ?? "") : `// ${data.error ?? "read failed"}`;
      currentModel?.dispose();
      currentModel = monaco.editor.createModel(text, langFor(file), monaco.Uri.file(file));
      editor.setModel(currentModel);
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
      body: JSON.stringify({ tool: "edit", args: { path: props.file, newText: text, approved: true }, worktree: props.worktree ?? "." }),
    });
    const data = (await res.json()) as { ok: boolean; out?: string; error?: string };
    // Operator pressed Save = approval. Result shows in status line.
    if (ref) ref.dataset.status = data.ok ? `saved: ${data.out ?? ""}` : `save failed: ${data.error ?? ""}`;
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
    void loadFile(props.file);
    onCleanup(() => {
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
