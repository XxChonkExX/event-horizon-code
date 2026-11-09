---
name: python-debugging
description: Debug Python code, tracebacks, and failing tests. Use when the user reports a Python error, failing pytest, or asks to fix Python.
license: MIT
---

# Python Debugging

Use this skill when debugging Python in a worktree.

## Process

1. Reproduce with the exact command the user ran. Capture exit code and stderr to a file.
2. Use engram_search for the Python version / stdlib module involved. If absent, say so with typed absence — do not invent API.
3. Check pyright diagnostics via LSP before editing.
4. Make minimal change, run the failing test again, then the broader suite.
5. Commit only after tests pass. Snapshot is automatic per session.

## Rules

- Prefer stdlib. No new pip dependency without asking.
- Never eval() untrusted input. Use ast whitelist where needed.
- All arithmetic claims in explanations must pass calc_verify.

## References

- references/traceback.md — reading CPython tracebacks quickly
- references/pytest.md — pytest flags for this repo
