---
name: docker-tooling
description: Dockerfile / Compose development help. Use when the user asks about Dockerfile / Compose code, builds, or errors.
license: MIT
---

# Dockerfile / Compose

Use this skill for Dockerfile / Compose work in Event Horizon Code.

## Process

1. Resolve language pack via languages/docker/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: docker --version, docker compose version, hadolint --version
- LSP: docker-language-server
- Build/Test/Run: docker build -t app . / docker run --rm app / docker compose up

## References

- engramPack: docker
- Tier: 2
