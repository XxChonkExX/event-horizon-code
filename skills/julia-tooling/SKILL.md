---
name: julia-tooling
description: Julia development help. Use when the user asks about Julia code, builds, or errors.
license: MIT
---

# Julia

Use this skill for Julia work in Event Horizon Code.

## Process

1. Resolve language pack via languages/julia/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: julia --version
- LSP: julia --project -e using LanguageServer; LanguageServer.run()
- Build/Test/Run: julia --project=. -e "using Pkg; Pkg.instantiate()" / julia --project=. -e "using Pkg; Pkg.test()" / julia {file}

## References

- engramPack: julia
- Tier: 1
