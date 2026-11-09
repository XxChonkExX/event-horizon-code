# Languages — Event Horizon Code

No runtime is bundled. Each pack is a JSON manifest that probes PATH and spawns LSP/DAP on demand. If a tool is missing the Toolchain Doctor reports it; the app never auto-installs at startup.

## Tier 1 — shipped

| id | display | LSP | DAP | formatter | linter |
|---|---|---|---|---|---|
| python | Python | pyright | debugpy | ruff format | ruff check |
| rust | Rust | rust-analyzer | lldb-dap | cargo fmt | cargo clippy |
| go | Go | gopls | delve | gofmt | staticcheck |
| js-ts | JavaScript/TypeScript | typescript-language-server | js-debug | prettier | eslint |
| cpp | C/C++ | clangd | lldb | clang-format | clang-tidy |
| csharp | C# / .NET / F# | csharp-ls | netcoredbg | dotnet format | dotnet build |
| java | Java | jdtls | java-debug | google-java-format | checkstyle |
| ruby | Ruby | ruby-lsp | rdbg | rubocop -a | rubocop |
| php | PHP | intelephense | php-debug | php-cs-fixer | phpstan |
| dart | Dart/Flutter | dart language-server | dart debug | dart format | dart analyze |
| swift | Swift | sourcekit-lsp | lldb | swiftformat | swiftlint |
| kotlin | Kotlin/Scala | kotlin-ls | kotlin-debug | ktlint | detekt |
| lua | Lua | lua-language-server | local-lua-debugger | stylua | luacheck |
| shell | Shell | bash-language-server | - | shfmt | shellcheck |
| zig | Zig | zls | - | zig fmt | zig build check |
| r | R/Julia/Nim | R language server | - | styler | lintr |
| perl | Perl | perl-language-server | - | perltidy | perlcritic |

## Tier 2 — planned

| id | LSP |
|---|---|
| elixir | elixir-ls (covers Elixir, Erlang) |
| haskell | haskell-language-server |
| ocaml | ocamllsp |
| clojure | clojure-lsp |
| scala | metals |
| nim | nimlsp |
| assembly | asm-lsp (NASM/GAS/M68K) |
| terraform | terraform-ls |
| docker | docker-language-server |
| nix | nixd |
| graphql | graphql-lsp |
| protobuf | buf |
| sql | sqls |

## Per-worktree isolation

Each window (1 task = 1 window = 1 git worktree) gets its own environment so language servers never share `PATH`, virtualenvs, or target dirs. Closing a window does not kill the work; reconnect on relaunch. Max 6 LSP servers active at once; idle servers exit after 5 min.

## Toolchain Doctor

Checklist per pack:
- `python3 --version`, `rustc --version`, `go version`, `node --version`, `clang --version`, `dotnet --list-sdks`, `java -version`, `ruby -v`, `php -v`, `dart --version`, `swift --version`, `zig version`
- Honors rustup, pyenv, uv, nvm, mise, asdf, SDKMAN. Reports present/missing without installing.

## Engram + Skills

Each pack links to `engrams/packs/<id>/` (local pinned references indexed by AfterImage) and `skills/<skill>/SKILL.md` (progressive disclosure: metadata ~100 tokens at startup, full text on demand). Packs already seeded from `F:/llmtrainingpipeline/codetraining/`: C++ Standard Library, Python Standard Library by Example, HTML Standard, OWASP guides.

## Security

- No telemetry. No bundling of runtimes. No auto-update phone-home.
- LSP/DAP run as local subprocesses over stdio JSON-RPC with env allowlists.
- Tool output is treated as untrusted (injection risk). Human approval required for write/bash/network by default (see `.harness/config.json`).

## Source of truth

Packs live in `languages/<id>/language.json`. This table is generated from those manifests in CI. Change the manifest, not this file.
