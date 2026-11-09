---
name: elixir-tooling
description: Elixir / Erlang / Haskell / OCaml development help. Use when the user asks about Elixir / Erlang / Haskell / OCaml code, builds, or errors.
license: MIT
---

# Elixir / Erlang / Haskell / OCaml

Use this skill for Elixir / Erlang / Haskell / OCaml work in Event Horizon Code.

## Process

1. Resolve language pack via languages/elixir/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: elixir --version, erl -version, ghc --version, ocaml -version
- LSP: elixir-ls
- Build/Test/Run: mix compile / mix test / mix run

## References

- engramPack: elixir
- Tier: 2
