# Compatibility contract

This Alpha targets macOS and one trusted owner controlling one Mac. The HTTP/UI stack is portable, but live conversation control requires the signed Codex desktop app and its original owner. Linux/Windows, multi-tenant hosting and a fully containerized Codex desktop are not advertised as supported.

| Layer | Declared contract | Evidence boundary |
| --- | --- | --- |
| Node.js | 26.x, built-in SQLite | Current targeted/full test environment; other versions require separate verification |
| Python | 3.11+ standard library | Uses tomllib; explicit interpreter paths remain operator-owned |
| Desktop | Codex.app; custom signed bundle via explicit appPath | Bundled CLI identity and live protocol probes remain required |
| Source | state_5.sqlite with required thread columns; compatible global-state/pinned fields | Read-only adapters and synthetic schema tests; future filenames are not guessed |
| Browser | Current Chromium and WebKit, responsive PWA | Synthetic behavior and layout tests; physical phone/IME acceptance is separate |
| Architectures | Apple Silicon current native environment; Intel needs its own native acceptance | Source portability is not proof of device parity |

Unverified but executable CLI versions warn rather than block solely by version. Real incompatibility, ownership, request identity and result checks still control mutations. Missing current source or a changed schema yields a readable/diagnostic failure; Pocket must not rewrite Codex SQLite/global state or start a second agent to take over an active conversation.

The four included desktop helper modules are a versioned snapshot with SHA-256 provenance. Protocol regression tests and controlled native acceptance must accompany desktop upgrades. A source fixture or all-green CI does not guarantee that a newly released desktop build supports every RPC.
