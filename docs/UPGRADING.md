# Upgrade, backup and rollback

A JSON metadata export is not a complete service backup. It excludes authentication, queued/dispatch request identities, attachments and notification state. For a complete local recovery point, snapshot the whole protected Pocket data directory and its explicit config/bridge files after quiescing all Pocket writers.

1. Wait for active submissions to finish or become explicitly unconfirmed. Do not erase an unknown request or resubmit it with a different ID.
2. Stop every Pocket foreground process and the owned LaunchAgent. Keep the original Codex app/data intact.
3. Copy the entire Pocket data directory and ignored config to a new protected local backup. Include SQLite database, WAL/SHM if present, attachment files and authentication state. Do not publish this backup or place it inside the public source tree.
4. Record the current source/version and frontend manifest. Update to a specific reviewed release in the same source directory; keep the old code and backup.
5. Install locked dependencies, build, and run doctor. Start the service and verify authentication, list/message history, queued request IDs and attachments before returning to normal use.

If a migration/build/startup fails, stop the new version before restoring. Roll back code and the matching full local snapshot together. Never restore only metadata and claim that a queue/credential migration succeeded. Do not copy snapshots while a writer is active, combine unrelated databases, change the browser origin/machine IDs casually, or silently drop held/unconfirmed messages.

Current schema initialization and additive compatibility are not a promise of arbitrary downgrade safety. This Alpha documents the complete stopped-service snapshot procedure; it does not yet provide an automatic signed updater or an atomic cross-file online backup. A controlled upgrade/rollback test carrying queued and unknown requests is a release acceptance requirement.

Service uninstall removes only its owned LaunchAgent registration. Data, attachments, config and Codex originals remain until the owner explicitly decides how to archive or remove them.

Data locks are deliberately not reaped automatically. After an abnormal exit, stop every writer and verify its process is gone before removing `.pocket-service.lock` from the configured data directory. Do not remove an active or unknown lock to make a second instance start.
