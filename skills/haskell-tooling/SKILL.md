---
name: haskell-tooling
description: Haskell development help. Use when the user asks about Haskell code, builds, or errors.
license: MIT
---

# Haskell

Use this skill for Haskell work in Event Horizon Code.

## Process

1. Resolve language pack via languages/haskell/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: ghc --version, cabal --version, stack --version, haskell-language-server-wrapper --version
- LSP: haskell-language-server-wrapper
- Build/Test/Run: cabal build / cabal test / cabal run

## References

- engramPack: haskell
- Tier: 2
