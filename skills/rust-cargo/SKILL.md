---
name: rust-cargo
description: Rust development help. Use when the user asks about Rust code, builds, or errors.
license: MIT
---

# Rust

Use this skill for Rust work in Event Horizon Code.

## Process

1. Resolve language pack via languages/rust/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: rustc --version, cargo --version, rustup --version
- LSP: rust-analyzer
- Build/Test/Run: cargo build / cargo test / cargo run

## References

- engramPack: rust
- Tier: 1
