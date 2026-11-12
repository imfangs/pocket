# Pocket and alternative workflows

Checked **2026-11-13**. This comparison uses current official documentation and pinned public source, not installations or a hands-on ranking. Repository HEAD, CLI version, native app version and latest release are not interchangeable.

## Pocket's reason to exist

Pocket adds a browser/PWA reading and action surface to an existing Mac Codex Desktop workflow. It reads the original conversation source and resolves the original desktop execution owner by thread ID, retaining model, working directory and permissions. It emphasizes finding ongoing work, reading long replies and artifacts, preserving drafts/reading intent, and recovering uncertain requests by their original receipts.

This focused combination can be useful when Codex is already a daily workbench and the owner wants to control the web entry and adapt the interface. It is not a claim that mobile continuation, self-hosting, original thread IDs, file previews or recovery are market-exclusive. It introduces its own Mac/API/HTTPS maintenance and compatibility responsibilities.

## Three different kinds of continuation

1. **See history:** find and display previously saved conversations.
2. **Resume a thread:** continue the same native thread ID through a supported execution route.
3. **Continue its current desktop owner:** deliver input and supported controls to the already running original desktop execution.

Seeing an import feature does not by itself establish all three. An import also does not necessarily create a brand-new native thread. HAPI, Happy and T3 Code have positive evidence for existing-history or thread-resume routes; the inspected execution paths use their wrapper/runtime/server. No competitor Desktop-owner attachment comparison was executed here, so this document does not exclude other supported paths.

## Official ChatGPT and Codex

The current [Codex mobile guide](https://learn.chatgpt.com/docs/mobile) says tasks run in Cloud or on a connected computer; the phone can continue existing conversations, send instructions, approve actions and review changed code. The [Remote connections guide](https://learn.chatgpt.com/docs/remote-connections) describes reusing the host's projects, chats, files, credentials, permissions, plugins and tools. It covers mobile, supported desktop-to-desktop access, SSH projects and Work continuation across devices, including web. Availability varies with rollout and workspace policy.

The ordinary ChatGPT conversation experience and a remote Codex/Work conversation using a connected host are distinct workflows within the official product. Calling the native app “only chat” or saying it cannot continue a local task would misdescribe the current offering. Prefer the official route when it already fits; Pocket offers a self-managed browser/PWA service and editable personal interface, with its additional operational cost.

## HAPI

Snapshot: [06d9e51](https://github.com/tiann/hapi/tree/06d9e51f5c6a3812ddf84bfdb4782596b392fbf1), CLI/release **0.35.0**.

- [README](https://github.com/tiann/hapi/blob/06d9e51f5c6a3812ddf84bfdb4782596b392fbf1/README.md): wrappers for multiple official agents, a Hub/Runner and native/mobile/Web/PWA clients.
- [Shared Codex sessions](https://github.com/tiann/hapi/blob/06d9e51f5c6a3812ddf84bfdb4782596b392fbf1/docs/guide/codex-shared-sessions.md): terminal and phone can share one app-server started through HAPI; live attachment and cold resume have explicit lifetime/owner rules.
- [Desktop-history routes](https://github.com/tiann/hapi/blob/06d9e51f5c6a3812ddf84bfdb4782596b392fbf1/hub/src/web/routes/codexDesktop.ts#L2242): discovery, import/merge and sync of native Codex conversations are present. HAPI's own session identity is not evidence that the original Codex thread is discarded.

Compare its terminal/multi-agent Hub workflow with Pocket's existing desktop-first entry. Do not claim HAPI cannot see old Desktop conversations. HAPI's relay documentation also declares device-to-machine WireGuard/TLS encryption; that scoped claim is not an audit of every deployment or identical to client-content E2EE.

## Happy

Main snapshot: [db7c6ea](https://github.com/slopus/happy/tree/db7c6ea857e9b4bb9c6c09d8204de0319d331087). Main CLI source **1.2.6**; the queried latest CLI release was **1.2.5**. Desktop, Agent and mobile are separately versioned.

- [README](https://github.com/slopus/happy/blob/db7c6ea857e9b4bb9c6c09d8204de0319d331087/README.md): original CLI/relay plus Desktop/Agent, native mobile/Web, multiple agent integrations, shared sessions and content-E2EE claims.
- [Existing Codex resume](https://github.com/slopus/happy/blob/db7c6ea857e9b4bb9c6c09d8204de0319d331087/packages/happy-cli/src/codex/cliArgs.ts): `happy codex --resume <thread-id>` is accepted. Its inspected CLI route starts an app-server and resumes a native thread; this is not an arbitrary running Desktop-owner attachment test.
- [Happy Agent](https://github.com/slopus/happy-agent/blob/11301459fef8579a00054f9c824081027f798dd5/README.md): a headless runtime owns agents, tools, permissions and durable state. Official full-agent integrations and its unified harness are different paths.
- [Encryption design](https://github.com/slopus/happy/blob/db7c6ea857e9b4bb9c6c09d8204de0319d331087/docs/encryption.md) and [self-hosted server](https://github.com/slopus/happy/blob/db7c6ea857e9b4bb9c6c09d8204de0319d331087/packages/happy-server-self-host/README.md).

Prefer comparing Happy for native mobile, broader agent or collaboration requirements. Pocket has no equivalent current multi-user or application-layer E2EE promise; HTTPS through a trusted proxy is its documented transmission boundary.

## T3 Code

Official identity is confirmed by reciprocal links between [t3.codes](https://t3.codes) and [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Snapshot: [abca547](https://github.com/pingdotgg/t3code/tree/abca54783c7292734175616bd4c08479b2ca838d), source **0.1.9**; release 0.1.9 points to a different commit.

- [README](https://github.com/pingdotgg/t3code/blob/abca54783c7292734175616bd4c08479b2ca838d/README.md): unified coding-agent workbench, official harnesses, server-owned workspace execution, Git/worktrees and desktop/Web/native mobile clients.
- [Welcome/import](https://github.com/pingdotgg/t3code/blob/abca54783c7292734175616bd4c08479b2ca838d/docs/user/welcome-page.md#L65): imports recent Claude/Codex/Pi conversations and can continue them; import is best effort with message/attachment/tool-activity limits.
- [Architecture](https://github.com/pingdotgg/t3code/blob/abca54783c7292734175616bd4c08479b2ca838d/docs/internals/overview.md) and [remote access](https://github.com/pingdotgg/t3code/blob/abca54783c7292734175616bd4c08479b2ca838d/docs/user/remote-access.md): clients connect to the same T3 execution environment; its provider layer manages processes.

Compare it when adopting a unified coding workbench is desirable. Pocket keeps the existing Mac Codex Desktop routine as its starting point. T3's import/resume support must not be omitted or described as always starting over. Its application-layer E2EE was not established by this review; absence of a statement is not evidence of absence.

## Other relevant choices

**[Codex Mobile Bridge](https://github.com/try2love/codex-mobile-bridge)** is directly overlapping. Snapshot [216ee1c](https://github.com/try2love/codex-mobile-bridge/blob/216ee1ceeb5cfa418a76cbbebe1ffeef9e48901b/README.md) describes v2.2.0 stable/v2.2.1-preview.1, a desktop gateway and native mobile/Web clients continuing original Codex and other client environments. The README declares retained sessions/auth/execution, attachments, model/settings controls and permissions. Pocket's narrower Mac Codex/browser scope is a choice, not proof of superior continuity or a unique bridge mechanism.

**[CodexMonitor](https://github.com/Dimillian/CodexMonitor)** is a desktop orchestration alternative. Snapshot [dd61b9a](https://github.com/Dimillian/CodexMonitor/blob/dd61b9abd37de5ded86e82b9fe8a83fd49d46fa5/README.md) describes Tauri, per-workspace app-servers, multi-agent/worktree/Git/file controls and an optional remote daemon. That is a broader workbench starting point than Pocket's phone/browser surface for the original desktop workflow.

**Remote desktop or SSH + tmux** can be the simpler choice when full desktop control or a terminal/headless environment is the actual need. Pocket reorganizes conversation work for touch and reading; it does not replace every desktop or terminal operation.

## What would establish a stronger advantage

Use the same original conversations on the same Mac/phone. Compare discovering a task, reading a long/artifact-rich answer, sending a correction, answering a request, switching away and recovering the same request. Observe setup/maintenance burden and whether the user returns voluntarily. No superiority, adoption, latency or reliability ranking has been measured in this documentation pass.
