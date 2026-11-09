---
name: go-modules
description: Go development help. Use when the user asks about Go code, builds, or errors.
license: MIT
---

# Go

Use this skill for Go work in Event Horizon Code.

## Process

1. Resolve language pack via languages/go/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: go version
- LSP: gopls
- Build/Test/Run: go build ./... / go test ./... / go run .

## References

- engramPack: go
- Tier: 1
