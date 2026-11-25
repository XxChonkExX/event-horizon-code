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
  in place), `DELETE /api/secrets/:provider`, `POST /api/secrets/backup` /
  `GET /api/secrets/backups` / `DELETE /api/secrets/backups/:name` (plaintext
  backups, below), `POST /api/secrets/:provider/test` (one 1-token completion
  through the same call the agent lane makes; goes to the operator's base URL
  only). Bodies are size-capped, provider ids validated, writes atomic,
  flushed and owner-only (`0600`) where the OS supports it - verified on
  Linux, where the backup folder is `0700`. The audit log records provider
  names and storage state only. Agent tools cannot read or write the file
  wherever `EH_SECRETS_FILE` puts it: `safePath` compares the resolved path
  and the shell rule refuses its name. The BYOK lane pins its connections to
  the configured endpoint's resolved addresses (shared `src/server/dnspin.ts`,
  the same pin webfetch uses): defense in depth - a same-user local process
  cannot relocate the key by poisoning DNS; the configured base URL remains
  the operator's authority (a first-resolution hijack is out of scope, by
  design; there is no "right" answer to pin to). Cross-host redirects fail to
  connect honestly. `netpin:test`.
- **In the workbench.** A stored provider (base URL + key + model) appears in
  the composer's picker as `byok:<provider>` and in profiles the same way;
  selecting it routes the turn through that endpoint, and a missing or
  unreadable key there is a stated failure, never a silent reroute to another
  lane. The panel shows each provider's endpoint and model, offers the
  1-token test, and gates "Encrypt stored keys" behind a plaintext backup
  (kept under `~/.eventhorizon/backups/<timestamp>/secrets.json`, listed in
  the panel, deletable there once moved somewhere safe). A **models** probe
  lists the endpoint's own catalog (`GET /models` on the provider, pinned
  connection): click a model to set it as that provider's model. The **test**
  button sends a 128-token-budget completion with a 120 s timeout: thinking
  models (GLM on NIM measured) take 24-84 s per request regardless of budget,
  and a 1-token probe is the slowest shape (the single token is spent on
  reasoning), so the test measures the KEY, not the model's speed.
- **Verified on Windows, against the built app on this machine.**
  - `secrets:test:electron`: the module inside real Electron, two launches
    sharing one profile - the key sealed in launch one decrypts in launch two.
  - Built app: seal -> normal close -> fresh launch decrypts -> the agent lane
    sends the decrypted key to the configured endpoint. The same file handed to
    a headless runtime: stated refusal, nothing sent, file untouched.
  - BYOK panel driven end to end in both states (39 checks): invalid input
    refused, save, verdict, key cleared from the DOM, picker wiring
    (`/api/models` gains `byok:<id>`), the backup-then-seal flow, two-step
    remove.
  - The BYOK secrets module (not the keychain path) also passes its node suite
    on Linux (WSL2, Ubuntu 26.04): 86 checks including the `0600` file and
    `0700` backup-folder modes.
- **Verified per platform.** Windows: DPAPI, this machine, end to end. Linux:
  **POSITIVE** on native GNOME/Wayland (Strix, commit c2fd5b9) - safeStorage
  available, backend `gnome_libsecret` v11, cross-process seal -> decrypt,
  crash-seal survives an abrupt exit; see the platform fact below. macOS
  (Keychain): still pending its own machine. A WSL2 attempt (Ubuntu 26.04,
  gnome-keyring 50, libsecret 0.21.7, service on the session bus, collection
  created/unlocked/aliased `default`) reported
  `isEncryptionAvailable() === false` on every `--password-store` backend -
  confirmed as an Electron/Chromium-in-WSLg result, NOT a Linux gap.
- **First-launch window: closed (settle-before-seal).** On a brand-new
  profile, Chromium writes the profile's wrapping key about 10 s after launch,
  or at once on a normal close - not when a value is sealed - and offers no
  API to force it. A value sealed before that lands used to be lost if the app
  died first. The fix: the first seal on a profile whose wrapping key is not
  yet on disk (Windows) waits for it before sealing (poll, max 30 s). The
  save returns only once the key is durable, so even an immediate kill cannot
  lose it - measured against the built app: the save waited 10.1 s, the app
  was force-killed right after, and the relaunch decrypted the key. Two
  honest notes: (1) an earlier proposal here - an envelope design with a data
  key wrapped by `safeStorage` - was REJECTED on closer analysis, because the
  wrapped data key would depend on the very key that failed to reach disk; it
  would not have closed this window. (2) If the wait cannot confirm the key
  within 30 s (an unexpected Chromium layout), the save proceeds and says the
  durability could not be confirmed - stated in the save response and in the
  panel's verdict, never silent.
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

- E1: **implemented** (2026-11-24). Verified on Windows (module in real
  Electron across launches, built app end to end, panel flows) and the module's
  POSIX behaviour on Linux (WSL2); macOS is pending its own machine.
  **Linux keyring proof: POSITIVE** (2026-11-24, Strix — native Ubuntu 26.04,
  GNOME on Wayland, real graphical session): `safeStorage.isEncryptionAvailable()`
  true, backend `gnome_libsecret` (v11 prefix). Cross-process seal → decrypt,
  crash-seal (key saved moments before an abrupt exit on a brand-new profile)
  decrypts in the next process, nothing plaintext on disk. The WSL2 negative
  above is confirmed as an Electron/Chromium-in-WSLg result, not a Linux
  result.
  **Platform fact (probed, cited in the test):** the v11 libsecret backend is
  DETERMINISTIC — `encryptString(x)` twice returns byte-identical ciphertext
  (both decrypt). DPAPI and Keychain randomize. Consequence: an attacker with
  the file can see *equality* of sealed plaintexts (the same key re-saved, or
  two providers sharing a key) but never the key material, and the ciphertext
  remains bound to the OS user account. The electron test asserts ciphertext
  difference only on randomizing platforms.
- E2: research item; tracked with the runtime-supervision work.
- E3: blocked on the Mission Control lane; primitives chosen.
