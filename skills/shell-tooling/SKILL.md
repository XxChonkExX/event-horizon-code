---
name: shell-tooling
description: Shell / Bash / Zsh development help. Use when the user asks about Shell / Bash / Zsh code, builds, or errors.
license: MIT
---

# Shell / Bash / Zsh

Use this skill for Shell / Bash / Zsh work in Event Horizon Code.

## Process

1. Resolve language pack via languages/shell/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: bash --version
- LSP: bash-language-server
- Build/Test/Run: shellcheck . / bats test/ / bash {file}

## References

- engramPack: shell
- Tier: 1
