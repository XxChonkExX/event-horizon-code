# Detonation — unclean interactions

Built for the agentic age: unknown actors, questionable alignment, dual-use payloads. Event Horizon separates two lanes at the worktree level.

## Two lanes

- Clean lane: `host` | `docker` | `sbx` — trusted local work. Fast, native, default while CodeRed-418 trains on the B70.
- Detonation lane: `detonate` — unclean interactions only. MicroVM, no network, no credentials, no host FS writes, time-boxed, killed on timeout.

A worktree is one lane. `.eventhorizon/worktree.json` holds `{"mode": "detonate"}` for detonation worktrees. Clean worktrees never receive untrusted code.

## What routes to detonation

- `isUnclean()` in `src/server/detonate.ts` matches exploit, payload, shellcode, reverse shell, malware, ransom, keylog, C2, UNC paths, `curl | sh`, `wget | sh`, `Invoke-Expression`, `FromBase64String`, and similar.
- Tiers:
  - `review` — static triage, engram lookup, human approval required before any execute.
  - `execute` — run in deterministic harness (pyvm, rv32, ti85, mathcheck — same family as BlackICE `engram_vm/machines`). No syscalls, capped steps/memory.
  - `redteam` — BlackICE-class workflow: class-targeted cybersecurity capability, engram injection + abacus ledger verification, all output treated as untrusted, human re-review before any host merge.

## BlackICE alignment

`ChonkE/Gemma-4-12b-RedTeam-BlackICE` is class-targeted fine-tuning: cyber (offense + defense) freed, other safety classes verified intact (23/24 harm prompts refusal-identical). Ships MIT `engram_vm/`:
- `afterimage_router.py` — engram injection + arithmetic verify-repair
- `machines/ti85.py` — injection-safe scientific calculator
- `machines/mathcheck.py` — claim sweep
- `machines/rv32.py`, `pyvm.py`, `m6502.py`, `thumb2.py`, `dataflow.py` — deterministic emulators

Event Horizon imports this pattern, not the model. The model is user-chosen at runtime (`modelChoice: user-at-runtime`). Detonation chamber runs the deterministic machines even when the model is small or local.

## Guarantees

- No network egress. `--network off`. Balanced/strict policies do not apply here; detonation is off.
- No credentials. Model API keys, GitHub tokens, SSH keys never enter the VM. Credential proxy would be on host side only for clean `sbx` clone mode.
- No host writes. Artifact arrives read-only. Outputs are capped and quarantined. `quarantineCheck()` compares `git status` before/after; only allow-listed paths may appear.
- Timeout + kill. `runDetonate()` enforces `timeoutMs` (default 30s), `maxOutputBytes` (200KB), SIGKILL on expiry. No orphaned processes — see `docs/GPU.md` process hygiene.
- Audit trail. Every detonation is logged to `~/.eventhorizon/audit.jsonl` with tier, artifact hash, duration, output size.

## UI

`SandboxControls.tsx` includes `detonate` in the mode select. Selecting it shows:
`sbx run --clone detonate-<worktree> <worktree> --network off`
Nothing executes until operator presses Run. The panel copy states: "Unclean lane. No network, no credentials, time-boxed."

## Why a separate function

Agent tool output, MCP tool output, web fetches, pasted code, and model-generated exploits are all untrusted until verified inside the chamber. Putting the check in `isUnclean()` + `buildDetonatePlan()` + `runDetonate()` as a standalone module (`src/server/detonate.ts`) keeps the clean path fast (host mode) and the unclean path honest. One function, one boundary, machine-checkable.
