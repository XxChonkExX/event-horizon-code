// Event Horizon Code — Package manager detection
// Inspects workspace files only. No network, no installs.

import fs from "node:fs";
import path from "node:path";

export type PmKind =
  | "cargo" | "uv" | "pip" | "npm" | "pnpm" | "bun" | "go"
  | "dotnet" | "maven" | "gradle" | "mix" | "swift" | "zig" | "unknown";

export type PmResult = {
  kind: PmKind;
  root: string;
  manifestFound: string[];
  build: string;
  test: string;
  run: string;
};

const RULES: Array<{ kind: PmKind; files: string[]; build: string; test: string; run: string }> = [
  { kind: "cargo", files: ["Cargo.toml"], build: "cargo build", test: "cargo test", run: "cargo run" },
  { kind: "uv", files: ["pyproject.toml"], build: "uv build", test: "uv run pytest -q", run: "uv run python" },
  { kind: "pip", files: ["setup.py", "requirements.txt"], build: "python -m compileall .", test: "pytest -q", run: "python" },
  { kind: "go", files: ["go.mod"], build: "go build ./...", test: "go test ./...", run: "go run ." },
  { kind: "npm", files: ["package.json"], build: "npm run build", test: "npm test", run: "npm start" },
  { kind: "pnpm", files: ["pnpm-workspace.yaml"], build: "pnpm build", test: "pnpm test", run: "pnpm start" },
  { kind: "bun", files: ["bun.lockb", "bunfig.toml"], build: "bun build", test: "bun test", run: "bun run" },
  { kind: "dotnet", files: ["*.sln", "*.csproj"], build: "dotnet build", test: "dotnet test", run: "dotnet run" },
  { kind: "maven", files: ["pom.xml"], build: "mvn -q -DskipTests package", test: "mvn -q test", run: "java -jar target/app.jar" },
  { kind: "gradle", files: ["build.gradle", "build.gradle.kts"], build: "gradle build", test: "gradle test", run: "gradle run" },
  { kind: "mix", files: ["mix.exs"], build: "mix compile", test: "mix test", run: "mix run" },
  { kind: "swift", files: ["Package.swift"], build: "swift build", test: "swift test", run: "swift run" },
  { kind: "zig", files: ["build.zig"], build: "zig build", test: "zig build test", run: "zig run" },
];

export function detectPackageManager(worktree: string): PmResult {
  const manifestFound: string[] = [];
  for (const rule of RULES) {
    const hits = rule.files.filter((f) => {
      if (f.includes("*")) {
        try {
          return fs.readdirSync(worktree).some((e) => e.endsWith(f.replace("*", "")));
        } catch { return false; }
      }
      return fs.existsSync(path.join(worktree, f));
    });
    if (hits.length) {
      manifestFound.push(...hits);
      return { kind: rule.kind, root: worktree, manifestFound, build: rule.build, test: rule.test, run: rule.run };
    }
  }
  return { kind: "unknown", root: worktree, manifestFound, build: "", test: "", run: "" };
}
