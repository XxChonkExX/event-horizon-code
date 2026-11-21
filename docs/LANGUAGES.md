# Languages — Event Horizon Code

No runtime is bundled. Each pack is a JSON manifest that probes PATH and spawns LSP/DAP on demand. If a tool is missing the Toolchain Doctor reports it; the app never auto-installs at startup.

## Tier 1 — shipped (18 packs)

| id | display | LSP | DAP | formatter | linter |
|---|---|---|---|---|---|
| cpp | C / C++ | clangd | lldb-dap | clang-format -i | clang-tidy |
| csharp | C# / .NET / F# | csharp-ls | netcoredbg | dotnet format | dotnet build --no-incremental |
| dart | Dart / Flutter | dart language-server | dart debug | dart format | dart analyze |
| go | Go | gopls | dlv | gofmt | staticcheck |
| java | Java | jdtls | java-debug | google-java-format | checkstyle |
| js-ts | JavaScript / TypeScript | typescript-language-server --stdio | js-debug | prettier --write | eslint |
| julia | Julia | julia --project -e using LanguageServer; LanguageServer.run() | - | julia -e using JuliaFormatter; format(.) | julia -e using Lint |
| kotlin | Kotlin / Scala | kotlin-ls | kotlin-debug | ktlint --format | detekt |
| lua | Lua | lua-language-server | local-lua-debugger | stylua | luacheck |
| perl | Perl | perl-language-server | - | perltidy | perlcritic |
| php | PHP | intelephense --stdio | php-debug | php-cs-fixer | phpstan |
| python | Python | pyright | debugpy | ruff format | ruff check |
| r | R / Julia / Nim | Rscript -e languageserver::run() | - | styler | lintr |
| ruby | Ruby | ruby-lsp | rdbg | rubocop -a | rubocop |
| rust | Rust | rust-analyzer | lldb-dap | cargo fmt | cargo clippy |
| shell | Shell / Bash / Zsh | bash-language-server | - | shfmt -w | shellcheck |
| swift | Swift | sourcekit-lsp | lldb | swiftformat | swiftlint |
| zig | Zig | zls | - | zig fmt | zig build check |

## Tier 2 — shipped (13 packs)

| id | display | LSP | DAP | formatter | linter |
|---|---|---|---|---|---|
| assembly | Assembly (NASM/GAS/M68K) | asm-lsp | - | - | nasm -f |
| clojure | Clojure | clojure-lsp | - | clj-kondo --lint - | clj-kondo --lint |
| docker | Dockerfile / Compose | docker-language-server | - | - | hadolint |
| elixir | Elixir / Erlang / Haskell / OCaml | elixir-ls | - | mix format | mix credo |
| graphql | GraphQL | graphql-lsp | - | prettier --write | eslint |
| haskell | Haskell | haskell-language-server-wrapper | - | fourmolu --mode inplace | hlint |
| nim | Nim | nimlsp | - | nimpretty | nim check |
| nix | Nix | nixd | - | nixfmt | statix |
| ocaml | OCaml / Reason | ocamllsp | - | ocamlformat -i | dune build |
| protobuf | Protocol Buffers | buf beta lsp | - | buf format -w | buf lint |
| scala | Scala | metals | - | scalafmt | sbt scalafix |
| sql | SQL | sqls | - | sqlfluff format | sqlfluff lint |
| terraform | Terraform / HCL | terraform-ls serve | - | terraform fmt | tflint |

Total packs: 31

## Per-worktree isolation

Each window (1 task = 1 window = 1 git worktree) gets its own environment so language servers never share `PATH`, virtualenvs, or target dirs. Closing a window does not kill the work; reconnect on relaunch. Max 6 LSP servers active at once; idle servers exit after 5 min.

## Diagnostics behavior notes (verified live, 2026-11-21)

- EHC declares the `textDocument.publishDiagnostics` client capability at initialize and normalizes pushed URIs before keying (real servers send `file:///c%3A/...` while we compute `file:///C:/...`; keying by raw URI made Windows lookups miss silently - hover/definition worked while diagnostics stayed empty).
- `GET/POST /api/lsp/diagnostics` pulls first (LSP 3.17 `textDocument/diagnostic`), then falls back to waiting for a push, and states plainly when neither produced anything within the window.
- **Known upstream gap: typescript-language-server v6.1.0 publishes no diagnostics at all** - it implements neither push nor pull (`Unhandled method textDocument/diagnostic`), even with the capability declared and a real project loaded. Hover, definition, and completion are unaffected (tsserver semantics work). If TS diagnostics matter to you, pin `typescript-language-server@4.x` (last line with working push diagnostics) or watch upstream v6. The fake-server smoke test locks both the URI normalization and the pull path, so any server that does the right thing lights up without EHC changes.

## Toolchain Doctor

Checklist per pack comes from `languages/*/language.json` `toolchain.check`. Honors rustup, pyenv, uv, nvm, mise, asdf, SDKMAN. Reports present/missing without installing.

## Engram + Skills

Each pack links to `engrams/packs/<id>/` (local pinned references indexed by AfterImage) and `skills/<skill>/SKILL.md` (progressive disclosure: metadata ~100 tokens at startup, full text on demand).

## Security

- No telemetry. No bundling of runtimes. No auto-update phone-home.
- LSP/DAP run as local subprocesses over stdio JSON-RPC with env allowlists.
- Sandbox modes: host (default), docker, sbx microVM. See `docs/DOCKER.md`. Host Docker socket never shared.

## Source of truth

Packs live in `languages/<id>/language.json`. This file is generated by `node scripts/generate-languages.mjs`. Change the manifest, not this file.
