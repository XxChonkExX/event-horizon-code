---
name: kotlin-gradle
description: Kotlin / Scala development help. Use when the user asks about Kotlin / Scala code, builds, or errors.
license: MIT
---

# Kotlin / Scala

Use this skill for Kotlin / Scala work in Event Horizon Code.

## Process

1. Resolve language pack via languages/kotlin/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: kotlin -version, gradle --version
- LSP: kotlin-ls
- Build/Test/Run: gradle build / gradle test / gradle run

## References

- engramPack: kotlin
- Tier: 1
