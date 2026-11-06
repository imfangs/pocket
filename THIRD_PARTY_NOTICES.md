# Third-party notices

Pocket's original source is licensed under [MIT](LICENSE). Dependencies, vendored code and data retain their own terms; the Pocket license does not replace them.

## Distribution inventory

[THIRD_PARTY_DEPENDENCIES.json](THIRD_PARTY_DEPENDENCIES.json) records all 437 dependency paths in the current lockfile, including exact versions, public archive locations, integrity values, declared licenses and available license-text evidence. Other-platform packages and development tools are identified separately. SPDX declarations are inventory information, rather than a claim that every source, data or binary obligation has been professionally audited.

[THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) preserves the original license and copyright texts collected from an isolated installation of the exact published archives, the repository's retained license files, and immutable upstream license references. Identical texts are shared by hash while all associated package names and versions remain listed.

The published archive of `react-remove-scroll-bar@2.3.8` declares MIT but does not carry standalone license text. Its recorded GitHead and exact version-tag candidates did not yield a retrievable immutable upstream license in this preparation pass. It remains explicitly identified in the inventory. Review its applicable notice before redistributing a compiled frontend; do not erase an unresolved entry or substitute Pocket's own copyright notice.

`@posthog/browser-common@0.9.11` also omits a standalone license from its archive. Its exact package tag and the parent SDK tag `posthog-js@1.438.21` both resolve to commit `a0b18d417833b27f93397125833e8a0173f62977`; the package definition at that commit matches version `0.9.11` and MIT. The governing root license at that same commit is retained in the aggregate, with these provenance checks recorded in the inventory.

## Existing retained notices

| Component | Use and retained terms |
| --- | --- |
| Pele | Fixed upstream source and local renderer package; [source/provenance/rebuild](vendor/pele/README.md), [MIT and included Lucide ISC notice](vendor/pele/LICENSE), and [public license copy](public/pele-LICENSE.txt) |
| Radix Themes | Shared interface components; [MIT text](public/radix-themes-LICENSE.txt) |
| HTML preview parser | parse5 8.0.0 MIT and entities 6.0.1 BSD-2-Clause; [retained original texts](public/html-preview-notices.txt) |
| IDB | Browser reading/feedback storage; [ISC text](public/idb-LICENSE.txt) |
| i18next | Local interface translation; [MIT text](public/i18next-license.txt) |
| Feedback dependencies | Annotorious BSD, Modern Screenshot MIT, IDB ISC and Standard Webhooks MIT; [detailed notices and exact sources](packages/feedback-kit/THIRD_PARTY_NOTICES.md) |
| Architecture viewer | Archify 2.17 diagram/runtime, separate from the application bundle; [MIT text](docs/assets/ARCHIFY-LICENSE.txt) and [artifact provenance](docs/assets/README.md) |
| Architecture font | Embedded JetBrains Mono subsets used by the standalone HTML/SVG diagram; [SIL OFL 1.1 text](docs/assets/JetBrainsMono-OFL.txt) |

The feedback notice file is also emitted by the frontend build. Keep the corresponding license material beside redistributed source and compiled artifacts; the existing individual notices do not eliminate the whole-application inventory check.

## License choices and scope

- `web-push` is declared MPL-2.0. Its separate library source remains under MPL; Pocket's MIT license does not relicense it.
- `dompurify` declares a choice of MPL-2.0 or Apache-2.0. Retain the upstream texts and satisfy the selected terms for the actual distribution.
- `caniuse-lite` declares CC-BY-4.0 and is development compatibility data. Check whether a particular distribution contains that data rather than treating it as application code.
- Build tools and optional binaries retain their own notices when those tools or binaries are redistributed. An application's generated output and its build environment are different distribution scopes.

When updating dependencies, keep exact versions, source provenance, license evidence and integrity values together. Refresh this inventory from the resulting lockfile and verify the actual source package and compiled release. Do not replace a vendored archive under an unchanged version or integrity value.
