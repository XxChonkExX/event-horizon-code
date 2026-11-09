---
name: lua-tooling
description: Lua development help. Use when the user asks about Lua code, builds, or errors.
license: MIT
---

# Lua

Use this skill for Lua work in Event Horizon Code.

## Process

1. Resolve language pack via languages/lua/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: lua -v, luajit -v
- LSP: lua-language-server
- Build/Test/Run: luacheck . / busted / lua {file}

## References

- engramPack: lua
- Tier: 1
