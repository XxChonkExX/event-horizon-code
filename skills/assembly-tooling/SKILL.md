---
name: assembly-tooling
description: Assembly (NASM/GAS/M68K) development help. Use when the user asks about Assembly (NASM/GAS/M68K) code, builds, or errors.
license: MIT
---

# Assembly (NASM/GAS/M68K)

Use this skill for Assembly (NASM/GAS/M68K) work in Event Horizon Code.

## Process

1. Resolve language pack via languages/assembly/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: nasm -v, as --version, asm-lsp --version
- LSP: asm-lsp
- Build/Test/Run: nasm -f elf64 {file} / make test / make run

## References

- engramPack: assembly
- Tier: 2
