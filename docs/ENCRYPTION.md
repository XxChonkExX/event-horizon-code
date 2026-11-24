# Encryption — research, recommendation, and plan

Scope: "add encryption to harden security; E2E if an open-source option exists;
possibly an in-house E2E for premium features." Researched 2026-11-24.

## Non-negotiables

- Never hand-roll a cipher, hash, or key exchange. "In-house" means **our
  protocol design on audited primitives**.
- Core stays MIT, telemetry-free, and dependency-light. Anything that adds a
  native build or a reporting channel is out.
- Security telemetry must never claim more than the mechanism establishes
  (same rule the detonation lane follows).

## What is available (open source)

| Option | License / audit | Fit |
|---|---|---|
| **`@noble/ciphers` + `@noble/curves` + `@noble/hashes`** (paulmillr) | MIT; audited 7 times (Cure53, Trail of Bits); zero dependencies, pure JS, tiny | **Best fit.** XChaCha20-Poly1305 AEAD, X25519 / ed25519. Used by MetaMask, ProtonMail, Tutanota. 2.5-5x slower than libsodium-wasm but ample (≈1-2.6k ops/s at 100 KB). |
| **Electron `safeStorage`** | Built into Electron | **Best fit for secrets at rest**: OS-backed string encryption (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). Zero new dependencies. |
| **Node `crypto`** (built-in) | Bundled | chacha20-poly1305 (IETF), AES-GCM, ECDH. No dependency at all; fine for at-rest file encryption keyed by safeStorage. |
| libsodium | ISC | Reference implementation, but `sodium-native` adds a native build (packaging + zero-dependency cost); `libsodium.js` is wasm. Not needed given noble. |
| SQLCipher | BSD-style | Transparent SQLite encryption, but needs a different driver than `better-sqlite3`. Deferred. |

## Threat model, stated plainly

| Surface | Current state | What encryption would and would not fix |
|---|---|---|
| BYOK keys in `.harness/secrets.json` | Plaintext, gitignored, denylisted from agent tools | **Real gap.** Any process running as the user can read them. OS-keychain-backed encryption (safeStorage) raises the bar meaningfully. |
| Loopback traffic (runtime <-> window) | `127.0.0.1` only, per-launch random password, owner-only descriptor, Basic auth | Network peers are already blocked. The residual threat is a **same-user local process** — which could read a key just as easily. This is a transport-ACL problem (named pipe / unix socket), not a crypto problem. |
| Session database at rest | Plaintext SQLite in `~/.eventhorizon` | Same class as secrets; heavier to solve (driver change or app-level field encryption). Optional, later. |
| Multi-agent channels (Mission Control, premium) | Not built yet | **Where E2E earns its place**: orchestrator <-> worker payloads, especially a remote worker (e.g. the Strix Halo box). Design it in from day one. |

## Recommendation

### Core (MIT) — Phase E1: secrets at rest via `safeStorage`

Encrypt each value in `.harness/secrets.json` with `safeStorage.encryptString`
in the main process; the runtime asks main to decrypt through a trusted IPC
call (same sender checks as `fs:op`). If OS encryption is unavailable (Linux
without a keyring), **say so in the UI and SECURITY.md** and keep the plaintext
path with a visible warning — never silently downgrade and never pretend.

This also closes the SECURITY.md keychain item from the external audit, with
an implementation rather than a qualification.

### Core (MIT) — Phase E2: loopback transport hardening (research)

Evaluate replacing the TCP loopback listener with a named pipe (Windows) /
unix-domain socket with `0600` (Linux/macOS), so the OS enforces access and
there is no port to scan. No cryptography involved; documented here so the
"encrypt the windows" instinct lands on the right mechanism.

### Premium — Phase E3: in-house E2E for agent channels

Built on `@noble`: ephemeral X25519 per worker session -> shared key ->
XChaCha20-Poly1305 for every message, giving forward secrecy and end-to-end
authentication between orchestrator and workers. Loopback-only workers may run
plaintext by policy; **encryption is mandatory the moment a worker is remote**.
Design doc first (key lifecycle, replay protection, session rotation), then a
reference implementation in the premium tree, with the MIT core exposing only
the interface it needs.

## Status

- E1: ready to implement (core). Depends only on Electron APIs already bundled.
- E2: research item; tracked with the runtime-supervision work.
- E3: blocked on the Mission Control lane; primitives chosen.
