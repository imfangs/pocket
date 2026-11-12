# Open-source preparation

Status: **2026-11-12**, experimental `0.1.0-alpha.1` source. This document records preparation and remaining evidence, not a published repository, release tag, hosted offering or verified new-user installation.

## What a reader can expect

Pocket is for one owner who already uses Codex on a Mac and wants to read and continue the original conversations from a phone/browser. It retains the original execution owner and permissions. English/Simplified Chinese UI, attachment/file previews, request recovery, independent Pocket preferences and a private local data store are already implemented. It is not a multi-user permission system, a model account, or a promise of compatibility with every desktop version.

## Preparation completed

| Area | Current preparation |
| --- | --- |
| Reader entry | Bilingual README leads with purpose, support limits, an actual interface preview with synthetic content, and the shortest local installation route |
| Installation and maintenance | Setup/doctor/start and owned service commands are documented; config identity, optional HTTPS, backup/rollback and local image permissions have explicit guidance |
| Contributor entry | [Code map and development loop](DEVELOPMENT.md), [contribution guide](../CONTRIBUTING.md), synthetic/browser checks and separate installed-desktop contracts |
| Source boundary | Machine configuration and private maintenance notes are ignored; generic defaults keep a fresh checkout buildable. The source exporter keeps an explicit document allowlist and verifies outgoing bytes |
| Historical disclosure | Known identifiers, development feedback and internal platform addresses were reviewed and accepted. A new anonymized history is an option rather than a blanket prerequisite; see [disclosure scope](PUBLIC_HISTORY.md) |
| Dependencies | Inventory refreshed to all 651 lockfile paths. `npm run licenses:check` detects graph/digest drift; `licenses:update` preserves original notice bytes. Build output carries whole-application notice text |
| CI preparation | Workflow checks notices, source privacy, synthetic contracts, build and browser flows. Synthetic CI is configured with a deliberately absent desktop and installs the browser engines before browser-dependent contracts |

## Remaining work, by actual scope

**Experimental source publication:** choose the actual repository/history or source snapshot being shared, inspect that artifact, and describe its tested scope. Publishing, pushing, enabling a reporting channel and creating a tag are explicit release actions; this preparation does none of them. The owner's acceptance of reviewed historical identifiers does not extend to new credentials or unrelated private/company content.

**Remote automation:** current workflow configuration and local checks are distinct from a successful GitHub run. All nine inspected runs failed at startup with no jobs. The latest run's annotation specifically reports a recent account-payment failure or spending-limit restriction; the other eight were not individually attributed. The four pinned Actions were verified against their tags. Two local CI defects were repaired: Chromium must be available before synthetic PDF/SVG tests, and a fresh source-bootstrap child must not inherit another checkout's bridge configuration. Record remote CI evidence after the account permits a run and an authorized push/run; do not claim a remote green result from local tests.

**Compiled dependency redistribution:** current inventory lists unresolved standalone notices for eight distinct package/version pairs, including `react-remove-scroll-bar@2.3.8` and recently added document-preview dependencies. `buffers@0.1.1` has no declared license in its metadata. These questions need scope-specific evidence before describing a compiled distribution as license-complete; see [third-party notices](../THIRD_PARTY_NOTICES.md). Source references, installed tools, optional native binaries and bundled browser code are different distribution scopes.

**New-user experience:** one independent Mac/phone installation is the most useful next experiment. With an authorized test conversation, check installation, HTTPS login, reading the same thread, one text/attachment submission, recovery by the same request ID, and a data-preserving upgrade/uninstall. Record where help was needed and whether the person returns to Pocket. Intel, physical-phone keyboard/PWA/notifications, weak-network behavior and native desktop version changes remain separately qualified.

## Keep the next round focused

Do not expand this Alpha into Windows/Linux desktop control, a native phone app, multi-tenant accounts or a large architectural rewrite merely to publish its source. Resolve actual installation or recovery friction revealed by a new user's trial. Prefer a specific compatibility receipt or reproducible synthetic case over adding unsupported feature claims.
