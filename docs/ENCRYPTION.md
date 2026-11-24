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
| BYOK keys in `.harness/secrets.json` | Sealed with the OS keychain when saved from the desktop app (E1, implemented); plaintext - and labelled as such - where no keychain is reachable; gitignored; denylisted from agent tools | Raised, not closed. A stolen file or copied workspace no longer reveals the key; a process running as the same user still can. |
| Loopback traffic (runtime <-> window) | `127.0.0.1` only, per-launch random password, owner-only descriptor, Basic auth | Network peers are already blocked. The residual threat is a **same-user local process** — which could read a key just as easily. This is a transport-ACL problem (named pipe / unix socket), not a crypto problem. |
| Session database at rest | Plaintext SQLite in `~/.eventhorizon` | Same class as secrets; heavier to solve (driver change or app-level field encryption). Optional, later. |
| Multi-agent channels (Mission Control, premium) | Not built yet | **Where E2E earns its place**: orchestrator <-> worker payloads, especially a remote worker (e.g. the Strix Halo box). Design it in from day one. |

## Recommendation

### Core (MIT) — Phase E1: secrets at rest via `safeStorage` — implemented

`src/server/secrets.ts` owns `.harness/secrets.json` (path overridable with
`EH_SECRETS_FILE`). A saved `apiKey` is sealed with Electron
`safeStorage.encryptString` and stored as `enc1:<base64>`; `baseUrl` stays
readable. The embedded runtime lives in the Electron main process, so the module
calls `safeStorage` directly - there is no IPC hop to secure.

- **Available or stated, never assumed.** Where the keychain is reachable the
  value is sealed. Where it is not - the headless runtime (`npm run serve` runs
  under `ELECTRON_RUN_AS_NODE`), or Linux without a keyring - a save stores
  plaintext and answers `encrypted: false`; the panel reads "Storage: plaintext
  only" and shows the verdict in warning colour. Using a sealed key on such a
  runtime fails the turn with the reason. Linux "basic text" encryption (a
  hard-coded key) is deliberately NOT enabled: obfuscation sold as security.
- **Surface.** `GET /api/secrets/status` (never carries a value),
  `POST /api/secrets`, `POST /api/secrets/encrypt` (seal every plaintext value
  in place), `DELETE /api/secrets/:provider`. Bodies are size-capped, provider
  ids validated, writes atomic and owner-only (`0600`) where the OS supports
  it. The audit log records provider names and storage state only. Agent tools
  cannot read or write the file wherever `EH_SECRETS_FILE` puts it: `safePath`
  compares the resolved path and the shell rule refuses its name.
- **Verified on Windows, against the built app on this machine.**
  - `secrets:test:electron`: the module inside real Electron, two launches
    sharing one profile - the key sealed in launch one decrypts in launch two.
  - Built app: seal -> normal close -> fresh launch decrypts -> the agent lane
    sends the decrypted key to the configured endpoint. The same file handed to
    a headless runtime: stated refusal, nothing sent, file untouched.
  - BYOK panel driven end to end in both states: invalid input refused, save,
    verdict, key cleared from the DOM, two-step remove.
- **Not verified.** Linux (libsecret/kwallet) and macOS (Keychain): the same
  Electron API, untested here. `npm run secrets:test:electron` inside a
  graphical session is the proof to run on each.
- **Known edge (measured).** On a brand-new profile, Chromium writes the
  profile's wrapping key about 10 s after launch, or at once on a normal close -
  not when a value is sealed - and offers no API to force it. A key saved
  within those first ~10 s of the very first launch is therefore lost if the
  app is killed before the write: the next launch reports it `undecryptable`
  and says why. It is a refusal, never a leak, and cannot recur once the key is
  on disk. Closing it completely needs an envelope design - a random data key
  sealed with `safeStorage` and written atomically beside the ciphertext in the
  same save (Node's built-in AEAD for the data, the OS keychain for the key).
  That is the recommended next step if the first-launch window matters.
- **Limits.** Bound to the OS user account: protects stolen files and copied
  workspaces, not a compromised account (a process running as the same user can
  use the same keychain). Not transport, database, or end-to-end encryption.

This closes the SECURITY.md keychain item from the external audit with an
implementation rather than a qualification.

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

- E1: **implemented** (2026-11-24) and verified on Windows; Linux and macOS
  proofs pending on their own machines. The first-launch edge above is
  documented, not closed - envelope design is the optional next step.
- E2: research item; tracked with the runtime-supervision work.
- E3: blocked on the Mission Control lane; primitives chosen.
