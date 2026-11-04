# About the sanitized history candidate

Pocket's public-history candidate preserves the project's code evolution while removing private deployment and operational material. It is a local preparation artifact, not evidence that a GitHub repository or release is already public. The original maintenance repository and its complete history remain private and intact.

The initial import keeps all 365 existing commits in their original chronological chain. Author and committer timestamps are retained. Identities are generalized to `Pocket contributors <contributors@example.invalid>`; commit hashes change because file trees, metadata and parent hashes change.

Of those initial commits, 178 have an unchanged public file tree after filtering. They preserve iteration events whose changes belonged to private documentation or operations; they are not 178 additional public code changes.

The history transformation:

- keeps historical source paths, including code that was later renamed or deleted;
- removes private configuration, operational notes, working data and evidence;
- substitutes known private domains, paths, infrastructure identifiers and internal registry references;
- disables historical telemetry configuration instead of directing it to the maintainer's project;
- preserves third-party license texts and checks retained archives and image metadata;
- retains commits that become empty after private material is removed, rather than silently deleting their place in the timeline.

A separate preparation commit aligns the current tree with the reviewed self-hosted source, including generic configuration, bundled bridges, installation documentation and this notice. That does not imply older commits were independently installable or had these capabilities. Use the current documented version to install; historical versions are an account of evolution, not a supported installation matrix.

The private old-to-new commit map and exact replacement rules are not distributed. Only the rewritten public history belongs in a public remote. Local filter receipts, old refs, reflogs and original objects must be excluded from that distribution; the original repository must never be pushed to the new public remote.

Verification covers known private markers, file boundaries, commit metadata and Git object retention. It is not a certification that every possible private fact or arbitrary secret can be detected automatically. Release acceptance, original desktop compatibility, real-phone installation and unresolved license checks remain separate requirements.
