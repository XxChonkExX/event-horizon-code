# languages/

Data-driven language packs. No runtimes bundled. No auto-install on startup.

## Schema

`language.json` fields:
- `id`, `displayName`, `tier` (1 = majors, 2 = working minors)
- `fileExtensions` — drives file type detection
- `toolchain.check` — PATH probes the Toolchain Doctor runs
- `toolchain.managers` — version managers to honor (rustup, pyenv, nvm, mise, asdf, SDKMAN)
- `lsp.command` / `dap.command` — spawned lazily, per-worktree, on first open
- `formatter` / `linter` / `commands.build|test|run` — exposed as agent tools
- `treeSitter.grammar` — bundled grammar name (fetched on first use, cached locally)
- `engramPack` — lookup pack under `engrams/packs/<name>/`
- `skill` — progressive-disclosure skill under `skills/<name>/SKILL.md`

## Rules

- Lazy: max 6 active LSP servers per worktree. Idle servers exit after 5 min.
- Per-worktree env: separate `PATH`, `VIRTUAL_ENV`, `CARGO_TARGET_DIR`, etc.
- Opt-in install: Toolchain Doctor reports missing tools. User installs. Nothing phones home.
- Zero new runtime deps for the pack reader. Stdlib JSON parsing only (Node `fs.readFileSync` + `JSON.parse`).

## Tier 1 shipped now

python, rust, go, js-ts, cpp, csharp, java, ruby, php, dart, swift, kotlin, lua, shell, zig, r, perl

## Tier 2 / 3 planned

elixir (Elixir/Erlang/Haskell/OCaml in one pack),clojure-lsp, scala (metals), nim, odin, gleam, assembly (asm-lsp), terraform, docker, nix, graphql, protobuf, sql.
