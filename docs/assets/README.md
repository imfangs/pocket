# Pocket architecture assets

The overview follows the default self-hosted path: a phone/browser uses the owner's HTTPS entry to reach a loopback-only Pocket API on the Mac. Pocket reads the original Codex source, keeps its own private state, and uses bundled local IPC/CLI adapters to operate the original desktop conversation. Codex retains model access and execution permissions. Cloudflare relay is optional and is not a prerequisite in this diagram.

- [SVG](pocket-architecture.svg): self-contained vector for both project READMEs; light/dark styling follows the reader's system preference.
- [HTML](pocket-architecture.html): self-contained explorer; open locally for theme, zoom, search and export controls.
- [JSON](pocket-architecture.json): authored architecture specification.

## Source and reproducibility

Source contracts: `docs/SELF_HOSTING.md`, `PRIVACY.md`, `bin/pocket.mjs`, `server/index.mjs`, `server/bridge-config.mjs`, `server/store.mjs`, `server/desktop.mjs`, `server/source.mjs`, and the browser reading-cache modules. Source history and the private Pocket database are different stores; the diagram's read-only history edge does not authorize direct edits to Codex storage.

Generated with [Archify 2.17](https://github.com/tt-a1i/archify). Its viewer/runtime is covered by the included [MIT license](ARCHIFY-LICENSE.txt). HTML and SVG embed JetBrains Mono subsets with their complete [SIL OFL 1.1 license](JetBrainsMono-OFL.txt); they need no external font server. The diagram uses semantic icons rather than third-party brand marks.

With the matching Archify version installed, validate then deliver the JSON as an architecture diagram with `--quality showcase`. Export SVG through the delivered viewer's Export → SVG action, which cleans runtime interaction state and includes its styles/fonts. The checked-in SVG additionally normalizes CSS line-ending whitespace; its DOM and all non-whitespace CSS content remain identical to the canonical export. Recheck generated files before committing; do not publish screenshots of private user content, local paths, service receipts or unreviewed exports. Product previews may use the actual application with synthetic conversations and a generic single-Mac profile, without real user session or account data.

## Verification · 2026-11-04

Deterministic validation passed all 9 showcase checks with zero composition errors or warnings. Automated browser evidence passed containment, readability and viewer controls at 1440×900, 1600×1000, 1920×1080 and 2048×1320; light/dark captures were collected at the two endpoint sizes. The canonical SVG export reports clean interaction state; it has no scripts, external resource references or external font requests. These checks establish artifact/layout behavior, not a human visual-polish review or a real-phone installation test.

| Artifact | SHA-256 |
| --- | --- |
| JSON | `c6373066bd8b130b446b209ba7f9e3fc9fdd14a50108d243d41df5b78b979da9` |
| HTML | `512fe48b9d523000f02f1ad7e31c0c71095a223471f8b5dfd351ac779bff2f80` |
| SVG | `d6a811a7f7392618bd2a1b2a1c01cc1ebd36011b2edbb0cb852a4eca36e481f7` |

## Product preview · 2026-11-12

[pocket-preview.png](pocket-preview.png) shows the compiled Pocket UI on a generic single-Mac profile, with synthetic task IDs, questions and replies. No real conversation, account, feedback or model request is used. Reproduce with a built application by setting `POCKET_BROWSER_DIST` to its absolute directory and running `node bin/capture-preview.mjs`; the existing Playwright Chromium engine is required. The illustration is interface evidence, not proof of an independent phone installation or external adoption.
