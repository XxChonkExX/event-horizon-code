---
name: graphql-tooling
description: GraphQL development help. Use when the user asks about GraphQL code, builds, or errors.
license: MIT
---

# GraphQL

Use this skill for GraphQL work in Event Horizon Code.

## Process

1. Resolve language pack via languages/graphql/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: graphql-lsp --version
- LSP: graphql-lsp
- Build/Test/Run: graphql-lsp server --method stream / graphql-lsp server / graphql-lsp server

## References

- engramPack: graphql
- Tier: 2
