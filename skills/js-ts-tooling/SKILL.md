---
name: js-ts-tooling
description: JavaScript / TypeScript development help. Use when the user asks about JavaScript / TypeScript code, builds, or errors.
license: MIT
---

# JavaScript / TypeScript

Use this skill for JavaScript / TypeScript work in Event Horizon Code.

## Process

1. Resolve language pack via languages/js-ts/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: node --version, npm --version, bun --version, deno --version
- LSP: typescript-language-server --stdio
- Build/Test/Run: npm run build / npm test / node {file}

## References

- engramPack: js-ts
- Tier: 1
