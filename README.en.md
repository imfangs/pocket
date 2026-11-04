# Pocket

[简体中文](README.md) · English

Pocket is an unofficial macOS-first companion that brings your own Codex desktop conversations to your phone. Read, continue a conversation, send attachments, and manage supported actions through a lightweight web app that can be added to the home screen. It is not affiliated with or endorsed by OpenAI.

The interface supports **English and Simplified Chinese**. It follows your system language by default; choose **Settings → Language** to override it. Conversation content keeps its original language.

The source is being prepared as **0.1.0-alpha.1**, under the [MIT license](LICENSE). The scope is one owner operating their own Mac and phone; it is not a multi-tenant hosted service. Public publication and clean-machine acceptance are separate release steps. Existing personal deployment records do not certify your installation.

## Self-hosting

Start with [the self-hosting guide](docs/SELF_HOSTING.md). It covers your local configuration, desktop bridge, private data, access credentials and phone connection. [Compatibility](docs/COMPATIBILITY.md) defines the supported environment and capability checks; [upgrading](docs/UPGRADING.md) covers backup, rollback and removal.

The currently checked development environment uses **Node.js 26.x** and **Python 3.14**. The Mac needs a supported Codex desktop app for original-owner controls. Pocket does not supply a model account, bypass the app's permissions or take over execution in a second agent.

```sh
npm ci --registry=https://registry.npmjs.org
npm run setup
npm run build
npm run doctor
npm start
```

Follow the guide for configuration and a private HTTPS route from your phone. A loopback address on the Mac is not a phone-accessible endpoint. Keep the service private until its authentication and origin checks pass. Optional relay, notifications, analytics and feedback integrations must use your own configuration.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for synthetic and native test separation, privacy rules and review expectations. Keep credentials and conversation data outside public build output and Git.

```sh
npm ci
npm run build
node .github/scripts/test-synthetic.mjs
./node_modules/.bin/playwright install chromium webkit
POCKET_BROWSER_DIST="$PWD/dist" npm run test:browser
```

Browser tests use synthetic data and require the configured Playwright browsers. They do not send messages to a real Codex conversation. `npm test` also includes installed Codex CLI contract files and must run on a supported, isolated test Mac. CI does not claim those native capabilities when the desktop app is absent.

`npm run dev` starts the local Vite frontend for editing. Run the configured API separately and keep its development origin rules explicit; use the compiled application for release acceptance.

To prepare a source package with the project's public-file selection:

```sh
npm run package:source
```

Review the package and its checksums before redistribution. Private runtime data and personal deployment material are not part of a source release. Preserve [third-party notices](THIRD_PARTY_NOTICES.md) along with the original code license.

## Localization

Pocket uses [i18next](https://www.i18next.com/) under the MIT license. UI messages live in `src/locales/en/`, with Chinese source strings as keys. Keep interpolation parameters intact, use plural forms for counts, and translate only product-owned labels. User messages, model responses, titles, code, paths and model names remain unchanged.

See the [localization design and maintenance contract](docs/design/2026-11-04-internationalization.md) for language negotiation, preferences, source-preserving state, and public-shell behavior.
