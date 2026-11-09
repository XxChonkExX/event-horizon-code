---
name: nix-tooling
description: Nix development help. Use when the user asks about Nix code, builds, or errors.
license: MIT
---

# Nix

Use this skill for Nix work in Event Horizon Code.

## Process

1. Resolve language pack via languages/nix/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: nix --version
- LSP: nixd
- Build/Test/Run: nix build / nix flake check / nix run

## References

- engramPack: nix
- Tier: 2
