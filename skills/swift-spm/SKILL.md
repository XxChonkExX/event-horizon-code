---
name: swift-spm
description: Swift development help. Use when the user asks about Swift code, builds, or errors.
license: MIT
---

# Swift

Use this skill for Swift work in Event Horizon Code.

## Process

1. Resolve language pack via languages/swift/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: swift --version
- LSP: sourcekit-lsp
- Build/Test/Run: swift build / swift test / swift run

## References

- engramPack: swift
- Tier: 1
