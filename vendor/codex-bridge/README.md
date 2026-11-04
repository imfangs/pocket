# Bundled desktop bridge helpers

These four Python standard-library modules are a byte-preserving snapshot of
Ogion's FBT desktop transport and metadata helpers. `provenance.json` records
their original source paths, source commit, and SHA-256 hashes. No binary,
credential, private configuration, retry watcher, or FBT runtime is included.

Pocket imports the transport and validation helpers from this directory when
no explicit bridge module path is configured. Metadata helper discovery is
independent from IPC discovery; it does not infer a sibling FBT checkout.

The modules themselves retain the original validation and RPC behavior.
Pocket's existing entry points enforce operation allowlists, original-owner
binding, receipt identity, and unknown-result protection. Importing a module
does not connect to Codex or start a model. The source files should first be
updated with provenance and focused protocol verification before changing them.

See the repository's [LICENSE](../../LICENSE) and this directory's provenance
record. The snapshot does not include or grant rights to Codex binaries or
unrelated third-party source.
