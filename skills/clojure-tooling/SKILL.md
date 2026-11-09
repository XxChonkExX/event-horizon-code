---
name: clojure-tooling
description: Clojure development help. Use when the user asks about Clojure code, builds, or errors.
license: MIT
---

# Clojure

Use this skill for Clojure work in Event Horizon Code.

## Process

1. Resolve language pack via languages/clojure/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: clj --version, clojure -version, clojure-lsp --version
- LSP: clojure-lsp
- Build/Test/Run: clj -M:build / clj -M:test / clj -M:run

## References

- engramPack: clojure
- Tier: 2
