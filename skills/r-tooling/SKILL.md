---
name: r-tooling
description: R / Julia / Nim development help. Use when the user asks about R / Julia / Nim code, builds, or errors.
license: MIT
---

# R / Julia / Nim

Use this skill for R / Julia / Nim work in Event Horizon Code.

## Process

1. Resolve language pack via languages/r/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: R --version, julia --version, nim --version
- LSP: Rscript -e languageserver::run()
- Build/Test/Run: R CMD INSTALL . / R CMD check . / Rscript {file}

## References

- engramPack: r
- Tier: 1
