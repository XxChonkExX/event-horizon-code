---
name: java-maven-gradle
description: Java development help. Use when the user asks about Java code, builds, or errors.
license: MIT
---

# Java

Use this skill for Java work in Event Horizon Code.

## Process

1. Resolve language pack via languages/java/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: java -version, javac -version, mvn -version, gradle --version
- LSP: jdtls
- Build/Test/Run: mvn -q -DskipTests package / mvn -q test / java -jar target/app.jar

## References

- engramPack: java
- Tier: 1
