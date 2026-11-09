---
name: scala-tooling
description: Scala development help. Use when the user asks about Scala code, builds, or errors.
license: MIT
---

# Scala

Use this skill for Scala work in Event Horizon Code.

## Process

1. Resolve language pack via languages/scala/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: scala -version, sbt --version
- LSP: metals
- Build/Test/Run: sbt compile / sbt test / sbt run

## References

- engramPack: scala
- Tier: 2
