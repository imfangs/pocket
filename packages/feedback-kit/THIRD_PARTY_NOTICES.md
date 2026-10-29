# Feedback Kit third-party notices

Verified against the installed packages and the repository lockfile on 2026-10-29. These notices cover the libraries introduced or reused by the feedback feature, not every dependency of the whole Pocket application. Preserve the relevant license texts when distributing source or compiled artifacts.

| Package | Resolved version | Use | License text |
| --- | --- | --- | --- |
| `@annotorious/react` | 3.9.5 | React image-annotation components | [BSD-3-Clause](licenses/annotorious-BSD-3-Clause.txt) |
| `@annotorious/annotorious` | 3.9.5 | Image annotation layer and public history API | [BSD-3-Clause](licenses/annotorious-BSD-3-Clause.txt) |
| `@annotorious/core` | 3.9.5 | Shared annotation state/history | [BSD-3-Clause](licenses/annotorious-BSD-3-Clause.txt) |
| `@annotorious/openseadragon` | 3.9.5 | Transitive Annotorious React dependency; not a separate Pocket viewer | [BSD-3-Clause](licenses/annotorious-BSD-3-Clause.txt) |
| `modern-screenshot` | 4.7.0 | DOM viewport capture | [MIT](licenses/modern-screenshot-MIT.txt) |
| `idb` | 8.0.4 | IndexedDB draft storage | [ISC](licenses/idb-ISC.txt) |
| `standardwebhooks` | 1.1.1 | Signature verification in the Pocket server adapter | [MIT](licenses/standardwebhooks-MIT.txt) |

Annotorious source: [annotorious/annotorious](https://github.com/annotorious/annotorious). Its npm metadata for 3.9.5 identifies Git commit `f780879410ff4f2d4fd0b2cb1ae1bd596a40fe65`; the retained copyright and BSD terms come from [that commit's LICENSE](https://github.com/annotorious/annotorious/blob/f780879410ff4f2d4fd0b2cb1ae1bd596a40fe65/LICENSE). The npm archives do not include a standalone license file. The feedback module uses an application-level public `initialHistory` adapter for the first-mutation merge-window issue; it does not modify Annotorious vendor source.

Modern Screenshot source: [qq15725/modern-screenshot](https://github.com/qq15725/modern-screenshot). The MIT text is copied verbatim from the installed 4.7.0 `LICENSE`, copyright 2021-present wxm. Pocket uses capture hooks in its own wrapper; no vendor source is patched.

IDB source: [jakearchibald/idb](https://github.com/jakearchibald/idb). The ISC text is copied verbatim from the installed 8.0.4 `LICENSE`, copyright 2016 Jake Archibald. This existing Pocket dependency is reused without modification.

Standard Webhooks source: [standard-webhooks/standard-webhooks](https://github.com/standard-webhooks/standard-webhooks). The npm metadata for 1.1.1 identifies commit `b4d2c14fc5b4ccff3ff271e3b087dff812254c59`. The JavaScript package is MIT as declared by its package metadata and governed by the containing [libraries/LICENSE](https://github.com/standard-webhooks/standard-webhooks/blob/b4d2c14fc5b4ccff3ff271e3b087dff812254c59/libraries/LICENSE), copyright 2023 Svix. The repository root's Apache-2.0 license applies to a different scope; it is not substituted for the library's MIT terms. The npm archive does not carry its own standalone license file.

Exact archive integrity values and transitive dependency versions remain in the root `package-lock.json`. Other existing host dependencies, including React, retain their own notices and licenses. These third-party licenses do not change the license or publication status of this repository's original code.
