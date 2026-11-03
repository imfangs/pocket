# Pocket

[简体中文](README.md) · English

Pocket brings your Mac's Codex conversations to your phone. Read, continue a conversation, send attachments, and manage supported conversation actions through a lightweight web app that can be added to the home screen.

The interface supports **English and Simplified Chinese**. It follows your system language by default; choose **Settings → Language** to override it. Conversation content keeps its original language.

This repository currently powers a personal deployment. It is not a general multi-user hosted service or a finished public installation package. Runtime configuration, desktop compatibility, and verified deployment status are recorded in [CURRENT.md](CURRENT.md); these details may change.

## Development

Use the repository's configured Node.js and Python environment and Mac desktop bridge. Review [AGENTS.md](AGENTS.md), [README.md](README.md), and [the mobile connection documentation](docs/MOBILE.md) before changing a running installation. Keep credentials and conversation data outside public build output and Git.

```sh
npm ci
npm run dev
npm test
npm run build
npm run test:browser
```

Browser tests use synthetic data and require the configured Playwright browsers. They do not send messages to a real Codex conversation. Frontend deployment uses this project's Pages configuration; desktop services have a separate lifecycle.

## Localization

Pocket uses [i18next](https://www.i18next.com/) under the MIT license. UI messages live in `src/locales/en/`, with Chinese source strings as keys. Keep interpolation parameters intact, use plural forms for counts, and translate only product-owned labels. User messages, model responses, titles, code, paths and model names remain unchanged.

See the [localization design and maintenance contract](docs/design/2026-11-04-internationalization.md) for language negotiation, preferences, source-preserving state, and public-shell behavior.
