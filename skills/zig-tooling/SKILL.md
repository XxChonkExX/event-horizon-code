---
name: zig-tooling
description: Zig development help. Use when the user asks about Zig code, builds, or errors.
license: MIT
---

# Zig

Use this skill for Zig work in Event Horizon Code.

## Process

1. Resolve language pack via languages/zig/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: zig version
- LSP: zls
- Build/Test/Run: zig build / zig build test / zig run {file}

## References

- engramPack: zig
- Tier: 1
