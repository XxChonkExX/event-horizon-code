---
name: perl-tooling
description: Perl development help. Use when the user asks about Perl code, builds, or errors.
license: MIT
---

# Perl

Use this skill for Perl work in Event Horizon Code.

## Process

1. Resolve language pack via languages/perl/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: perl -v
- LSP: perl-language-server
- Build/Test/Run: perl -c {file} / prove -l t/ / perl {file}

## References

- engramPack: perl
- Tier: 1
