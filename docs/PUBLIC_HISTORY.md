# Source and history disclosure

On **2026-11-13**, the existing repository was renamed to [imfangs/pocket](https://github.com/imfangs/pocket) and made public with its development history. The current source is experimental Alpha; no GitHub release tag or binary release was created by this publication.

## Current source and local files

Current source excludes private maintenance documents and machine deployment configuration. Those files can remain on a maintainer's disk at their original ignored paths for existing services. A file existing locally does not mean it is tracked or exported. Public documentation is selected by `publicSourceDocumentationPaths` in `bin/source-privacy.mjs`; runtime data, credentials and `.local/` stay outside source packages.

`npm run package:source -- --out /absolute/new/pocket-source` exports an allowlisted snapshot with generic configuration and disabled analytics. It does not copy `.git`, push a remote or change repository visibility. The manifest identifies the source commit and whether the checkout had changes; it is not a history sanitization certificate.

Existing installations must preserve local files before pulling a revision that removes previously tracked paths. See [UPGRADING.md](UPGRADING.md).

## Historical material

Removing a file from the current tree does not remove it from older commits. Historical commits may retain contributor names/email addresses, local paths, deployment identifiers, real conversation IDs/links, development feedback, internal platform URLs and older registry references. These known historical disclosures were accepted during preparation; comprehensive historical anonymization or a full history rewrite is not a requirement for sharing experimental source.

That acceptance does not include live credentials, complete private conversations or unrelated company/customer material. New findings outside the accepted scope require their own review. Known-value/path checks do not detect every possible secret, and `.gitignore` cannot erase committed bytes.

Older documents and commit messages describe decisions at their original dates. References to personal deployments, internal systems, earlier release plans or stricter historical cleanup proposals do not promise that those services or procedures are available to readers now. Historical revisions are an account of development, not a supported installation matrix; use current installation and compatibility documentation.

## Earlier filtered-history experiments

Earlier local candidates generalized commit identities, filtered private paths and substituted selected values while retaining chronological events, including commits whose public trees became unchanged. Rewriting trees, metadata or parents changes commit hashes. Those experiments remain distinct artifacts; do not assume they are the eventual published history or claim all histories were fully anonymized.

The public repository preserves the existing development history under the owner's accepted disclosure scope. Source snapshots and earlier filtered-history candidates remain separate artifacts. The visibility change publishes source; personal deployments and runtime data remain maintained independently.
