---
name: cpp-build
description: C / C++ development help. Use when the user asks about C / C++ code, builds, or errors.
license: MIT
---

# C / C++

Use this skill for C / C++ work in Event Horizon Code.

## Process

1. Resolve language pack via languages/cpp/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: clang --version, gcc --version, cmake --version
- LSP: clangd
- Build/Test/Run: cmake --build build / ctest --test-dir build / ./build/app

## References

- engramPack: cpp
- Tier: 1
