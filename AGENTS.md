# Pocket development

Pocket is a mobile and browser continuation surface for the original Codex desktop owner. The public repository is `imfangs/pocket`. Existing local checkouts, service identifiers and on-device data retain `codex-navigator` / `CodexNavigator` compatibility names.

Read `README.md`, `SECURITY.md`, `PRIVACY.md`, `docs/DEVELOPMENT.md`, `docs/OPEN_SOURCE_READINESS.md` and `docs/SELF_HOSTING.md` before changing installation or data boundaries. On an existing maintainer checkout, also read `.local/maintenance/AGENTS.md` and `CURRENT.md` when present: they hold private continuation notes, the last verified deployment and unresolved operational work. Those local notes are not required for a fresh source checkout.

## Ownership and data

- Keep the original thread, desktop owner, model, working directory and permissions. Never edit Codex SQLite, global state or rollouts directly, bypass application identity checks, or start a replacement executor for an existing task.
- Preserve request IDs, fingerprints, revisions and turn identity. Unknown submission, stop or approval results must be checked before any replay. An accepted request is not a completed model turn.
- Preserve drafts, selection, IME, reading position and newer responses when requests race or the application updates. Reading projections and cached text do not authorize execution or settle submission receipts.
- Keep loopback binding, authentication, Host/Origin/CSRF checks and existing file capabilities. Markdown and structured messages are presentation only; they do not grant new file or execution access.
- User databases, uploads, feedback, credentials, screenshots and machine configuration belong outside Git. Local legacy `config/*.json` paths listed in `.gitignore` may remain for existing services; commit portable examples instead. Do not overwrite those local files with templates during updates.
- Keep private maintenance documents and `.local/` out of source packages. The public documentation allowlist is owned by `bin/source-privacy.mjs`; `.gitignore` and the exporter follow it. Local private deny values can be placed in `.local/privacy/deny.private.json`, never in a tracked rule file.

## Verification and maintenance

- Use synthetic fixtures by default. Run relevant tests for a change, `npm run build` for frontend changes, and `npm run test:browser` for interaction changes. The seven installed-desktop suites remain part of full `npm test`; synthetic CI does not replace their native checks.
- Run `npm run typecheck` when changing shared contracts or checked backend modules. The strict `.mjs` pilot uses JSDoc and `@ts-check`; scope and compile-time samples are documented in `docs/DEVELOPMENT.md`. Types do not replace runtime validation or receipt reconciliation.
- Run `npm run privacy:check` and `npm run privacy:check -- --staged` before publishing or committing source. These checks cover tracked/index bytes and known local private values; Git history and unknown secrets require separate review.
- Use `node .github/scripts/test-synthetic.mjs` for a checkout without an installed supported desktop. Read `docs/COMPATIBILITY.md` before claiming native or real-phone acceptance.
- Preserve existing local services and configuration while working. Use temporary fixtures for experiments; do not restart Codex or production services merely to make tests pass.
- Inspect the exact diff, keep unrelated changes out, and create a local completion commit after necessary verification. Publishing the website, pushing Git or changing repository visibility are separate actions.
- Review Git history separately from the working tree. Apply the owner's accepted disclosure boundary to previously reviewed identifiers and development notes; sanitize credentials or material outside that boundary. Historical anonymization is not an unconditional publication requirement.
