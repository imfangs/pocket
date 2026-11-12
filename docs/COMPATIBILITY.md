# Pocket compatibility (Alpha)

Pocket's current target is **macOS and one trusted owner using their own Mac and phone**. The web stack is portable, but live controls depend on the signed Codex desktop app and its original conversation owner. Linux/Windows desktop control, multi-tenant hosting and a fully containerized Codex desktop are not supported targets.

This is a support and evidence boundary for experimental source. An unverified installation can be tried and its results reported; publishing Alpha source does not require pretending every environment has passed native or physical-phone acceptance.

## Environment contract

| Layer | Declared contract | Evidence and limits |
| --- | --- | --- |
| Node.js | **26.x**, including built-in SQLite | Required by the Pocket startup CLI; other major versions are not supported |
| Python | **3.11+**, standard library | Uses `tomllib`; current development checks use Python 3.14; interpreter paths are machine-owned |
| Desktop | Signed Codex.app; nonstandard location via private `appPath` | App identity, executable bundled CLI and live protocol/owner checks remain required |
| Source | `state_5.sqlite` thread columns and compatible `.codex-global-state.json`/pinned fields | Read-only schema checks and synthetic fixtures; future database names/layouts are not guessed |
| Architecture | Apple Silicon is the current native evidence base | Intel needs independent native verification |
| Browser | Current Chromium and WebKit; responsive PWA | Synthetic interaction/layout evidence; actual mobile browser and PWA behavior require device checks |
| Remote access | Your trusted same-origin HTTPS proxy or private network entry | Host/Origin/CSRF/authentication must pass on the actual route; local doctor does not test that route |

Keep macOS logged in and the Mac online. Codex login and model access belong to your account; Pocket supplies neither. Source and bridge configuration details are in [SELF_HOSTING.md](SELF_HOSTING.md) and [中文指南](SELF_HOSTING.zh-CN.md).

## Desktop versions and capabilities

The bundled CLI behavior list in `bin/bundled_cli.py` currently records `0.153.4`, `0.162.0-alpha.17.2`, `0.163.0-alpha.10.2` and `0.164.0-alpha.11.1`. This records tested CLI contracts, not a guarantee that every RPC or phone workflow works on every desktop build.

A working but unverified CLI version produces a warning; version-list membership alone does not block it. Actual App identity, compatibility, owner, request identity and result checks still govern controls. Missing source or schema incompatibility yields diagnostics, not a database rewrite or a replacement agent taking over the conversation.

Bridge helper snapshots carry provenance and SHA-256 hashes under `vendor/codex-bridge/`. After a Codex upgrade, check the actual protocol and relevant installed-desktop suites in addition to fixtures. A green synthetic CI run cannot certify a new desktop build.

## Known product limits

- Pocket outbox and desktop queue are separate. An accepted submission is not proof that a model turn completed; unconfirmed results must be checked by the original request ID before replay.
- Pocket reading watermarks are browser/origin, machine and source scoped. Native read-state writeback is not stable; cross-phone read synchronization is unavailable. Clearing site data or reinstalling the PWA loses browser state.
- Rename, creation, approvals, questions, stop and model-setting controls depend on the original desktop's available capabilities. Pocket does not advertise cross-model switching.
- Archive/restore can wait for a writer held by the desktop. Restoring a linked root is rejected when the native operation would restore an associated subtree or the scope cannot be confirmed; independent/leaf restore remains conditional on native capability.
- History is local and bounded. Missing cloud-only history is not invented. Current pagination limits include a 512 MiB source file and 8 MiB record; exceeding a bound is reported rather than claiming the entire history was loaded.
- File access remains conversation-bound and subject to macOS folder permissions. Foreground Codex access does not prove background Node access; see the self-hosting guide's image troubleshooting.

## What has and has not been validated

Synthetic tests and Chromium/WebKit browser checks cover controlled fixtures. Installed-desktop suites exercise the configured App/CLI and IPC contracts on an isolated compatible Mac. Existing personal deployments provide installation-specific evidence; none of these establishes universal compatibility.

Independent first installation on a new Mac, Intel native acceptance, physical-phone keyboard/IME, home-screen PWA, lock-screen notification recovery, long-running weak-network behavior and a complete data-preserving upgrade/rollback still need separate verification. Report the source/build, OS, desktop, interpreter, browser/device and action tested when adding evidence. Use authorized test conversations and preserve unknown-result safety.
