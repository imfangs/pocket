# Upgrade, backup and rollback

Pocket is Alpha software. Keep a recoverable code version and a complete private snapshot before updating a running installation. Source preparation does not publish an update or change your current services. These steps describe recovery boundaries; they do not claim an automatic updater or a verified migration matrix.

## Existing checkouts: preserve files leaving Git

Some older checkouts track private configuration and maintenance notes that the current source no longer tracks. **Before applying their removal**, save the actual local files in a protected directory outside the checkout and verify the copy. Git can delete a clean tracked file while applying its removal even when the new version ignores that path.

Preserve the installation's real `config/` files (including bridge, analytics, local-service, tunnel, relay and Pages configuration), `wrangler.jsonc`, `CURRENT.md`, `HISTORY.md`, private maintenance documents, and any explicitly selected config outside those defaults. This is a preservation list, not a list of files a new public checkout needs.

After updating, restore needed local files to their **original ignored paths**. Keep environment overrides and service references pointing to the same files; do not add them back to the index or overwrite them with examples. The maintainer's local cleanup kept its own files on disk, but that procedure does not run automatically on another machine that pulls the removal commit.

## Make a complete stopped-service snapshot

A JSON metadata export is not a full backup. It omits credentials, queue/dispatch identities, attachments and notification state. Read the selected private Pocket config to identify the actual `dataDir`, `bridgeConfig`, port and machine identity.

1. Record the current source commit/build, dependency lockfile, selected config and foreground/background service registration. Resolve active submissions as far as possible; preserve any unconfirmed request, its original ID and its receipt.
2. Stop every Pocket writer belonging to this data directory. Use Ctrl+C for the foreground process. For the self-host LaunchAgent, run `node bin/pocket.mjs service uninstall --apply`, adding `--config /absolute/private/pocket/config.json` for a nondefault config, then check `node bin/pocket.mjs service status` with the same config. For a different service manager, use its existing owned stop procedure. Keep Codex and its source data intact.
3. Verify writers are gone. Copy the **whole** protected Pocket data directory plus actual config/bridge files to a new private backup outside source. Include SQLite and any remaining WAL/SHM, attachments, authentication, push state, queued text and receipts. Also retain optional integration configuration and the code/version needed to interpret them. Review file permissions and verify the copy locally without exposing its contents.
4. Retain the old source/build and locked dependencies as the matching rollback version. An old source commit alone does not reconstruct every private runtime file.

Do not copy while a writer is active, combine unrelated databases, or discard held/unconfirmed messages to simplify the snapshot. Browser reading state and feedback drafts live separately in site storage; changing origin or clearing site data can lose them. Original Codex data is a separate store and needs its own backup policy.

## Update and verify

Use a specific reviewed source revision or package you have obtained. No public release or updater is implied by these instructions. Keep the same source path where possible; moving it changes LaunchAgent/bridge references.

After preserving files and stopping writers, update source, retain private configuration and run:

```sh
npm ci --registry=https://registry.npmjs.org
npm run build
npm run doctor -- --config /absolute/private/pocket/config.json
npm start -- --config /absolute/private/pocket/config.json
```

Use your actual absolute config path, including the default `<checkout>/.local/pocket/config.json`. Do not rerun setup with new flags expecting it to update existing configuration; it preserves the existing config. Changed Node/Python/App paths need explicit review of the private bridge and service registration.

In the foreground, verify health, anonymous `/api/catalog` rejection, login, conversation/message reads, preserved machine identity, queued/held/unknown request IDs and attachment access. Check the same HTTPS origin from the phone when remote access is part of your installation. Reconcile unconfirmed operations against their original receipts; do not resend them as new requests.

If returning to a background service, stop the foreground process, run `node bin/pocket.mjs service install --apply` and `node bin/pocket.mjs service status` with the same config. Reinstalling records the current Node/source paths. Report local environment, actual desktop controls, remote access and device checks separately.

## Roll back if necessary

If build, startup or migration fails, stop the new version before restoration. Restore the matching old code/build/dependencies and **complete stopped-service snapshot together**, with its private config at the original paths. Preserve the failed version's data separately if it contains new submissions requiring reconciliation.

Verify authentication, queues, request identities and attachments before resuming. Restoring metadata alone is not queue or credential recovery. Additive schema initialization does not promise arbitrary downgrade safety; do not start old code against a newer database without a compatible matching snapshot.

There is no automatic signed updater or atomic cross-file online backup. A complete upgrade/rollback carrying held and unknown requests remains independently unverified for a new installation. This limits Alpha support claims; it is not a prohibition on distributing experimental source.

## Uninstall and residual locks

Owned service uninstall stops/removes its LaunchAgent registration while retaining Pocket configuration, data, attachments and all original Codex data. Decide explicitly which private files to archive or remove only after the service is stopped. There is no `service stop` subcommand.

Data locks are not reaped automatically. After an abnormal exit, stop every writer and prove the associated process is gone before removing `.pocket-service.lock` from the configured data directory. Never remove an active or unknown lock to force a second instance to start. A restored snapshot can also contain a residual lock; verify its ownership and stopped-process state before recovery.
