---
name: ocaml-tooling
description: OCaml / Reason development help. Use when the user asks about OCaml / Reason code, builds, or errors.
license: MIT
---

# OCaml / Reason

Use this skill for OCaml / Reason work in Event Horizon Code.

## Process

1. Resolve language pack via languages/ocaml/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: ocaml -version, ocamllsp --version, opam --version
- LSP: ocamllsp
- Build/Test/Run: dune build / dune runtest / dune exec ./app.exe

## References

- engramPack: ocaml
- Tier: 2
