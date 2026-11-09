---
name: nim-tooling
description: Nim development help. Use when the user asks about Nim code, builds, or errors.
license: MIT
---

# Nim

Use this skill for Nim work in Event Horizon Code.

## Process

1. Resolve language pack via languages/nim/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: nim --version, nimlsp --version
- LSP: nimlsp
- Build/Test/Run: nimble build / nimble test / nim c -r {file}

## References

- engramPack: nim
- Tier: 2
