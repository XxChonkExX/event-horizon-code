# Project memory (written by the agent)

- Event Horizon Code ships MIT, no telemetry, local models first.
- Releases are hand-driven (`docs/RELEASE.md`): `npm test` green, then `npm run pack` on Windows and the Linux build in WSL from the same commit, SHA-256 sheets, an annotated `0.0.Nx` tag, and a GitHub release marked latest. There is no `npm publish` and no `make` target.
