---
name: dotnet-nuget
description: C# / .NET / F# development help. Use when the user asks about C# / .NET / F# code, builds, or errors.
license: MIT
---

# C# / .NET / F#

Use this skill for C# / .NET / F# work in Event Horizon Code.

## Process

1. Resolve language pack via languages/csharp/language.json.
2. Use engram_search for pinned reference records (typed absence is valid).
3. Run LSP diagnostics before test. Fix minimal change.
4. Verify arithmetic claims with calc_verify if present.

## Toolchain

- Check: dotnet --version, dotnet --list-sdks
- LSP: csharp-ls
- Build/Test/Run: dotnet build / dotnet test / dotnet run

## References

- engramPack: csharp
- Tier: 1
