---
name: protobuf-tooling
description: Protocol Buffers development help. Use when the user asks about Protocol Buffers code, builds, or errors.
license: MIT
---

# Protocol Buffers

Use this skill for Protocol Buffers work in Event Horizon Code.

## Process

1. Resolve language pack via languages/protobuf/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: buf --version, protoc --version
- LSP: buf beta lsp
- Build/Test/Run: buf build / buf test / buf generate

## References

- engramPack: protobuf
- Tier: 2
