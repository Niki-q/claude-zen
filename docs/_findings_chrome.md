# Claude Browser Extension — Original (Chrome/Chromium) Feature & Architecture Map

> Scope: reconstructs the ORIGINAL Chrome/Chromium build of Anthropic's "Claude" extension
> (Plasmo-built, MV3), independent of the Firefox port present in this repo. Grounded in
> `manifest.json`, the repo file tree, `managed_schema.json`, and the prior reverse-engineering
> in `docs/context/01-analysis-a009114b.md` and `docs/context/02-analysis-fa25706e.md`.
>
> Note on provenance: the manifest currently in the repo is the FIREFOX manifest (gecko id,
> `background.scripts`, `sidebar_action`, `firefox-*` shims). The ORIGINAL Chrome manifest is
> reconstructed below by stripping the Firefox shims and mapping each shim back to the Chrome
> API it replaces (the shims exist precisely to emulate Chrome-only APIs). Permissions, CSP,
> host_permissions, web_accessible_resources, commands, and the `assets/*` bundle content
> scripts are shared between both builds and are taken verbatim from `manifest.json`.

---

## 1. What the extension is

A first-party Anthropic browser extension that puts **Claude in a browser side panel** and gives
Claude **agentic control of the user's browser**. Two intertwined products:

1. **Side-panel chat** — a Claude conversation UI docked in the browser side panel
   (`sidepanel.html`), talking to claude.ai / the Anthropic API.
2. **Agentic page automation** — Claude can drive arbitrary web pages on the user's behalf:
   read page structure (accessibility-tree snapshots), click, type, scroll, navigate, and
   observe results. It does this by attaching the Chrome DevTools Protocol (CDP) debugger to
   tabs and dispatching synthetic input + evaluating script, while showing a visual indicator
   on the page and locking out human input during a run. Claude's "working" tabs are corralled
   into a dedicated tab group.

Built with **Plasmo** (hashed `assets/*.js` bundles, `*-loader.js` shims, `service-worker-loader.js`).
MV3. Version 1.0.72.

---

## 2. Entry points

| Entry point | File(s) | Role |
|---|---|---|
| **Background service worker** | `service-worker-loader.js` → `assets/index-*.js` bundle | The brain. Orchestrates agent runs, owns the CDP/debugger session, tab/tab-group management, native-messaging bridge, OAuth, offscreen lifecycle, storage, telemetry, message routing. In Chrome this is `background.service_worker` (the Firefox build replaces it with `background.scripts: [firefox-bg-loader.js, ...]`). |
| **Content script: claude.ai loader** | `assets/content-script.ts-loader-*.js` (+ WAR `content-script.ts-*.js`, `onboarding-prompts-*.js`) | Injected into `https://claude.ai/*` at `document_end`. Bridges the claude.ai web app and the extension (auth/session handoff, onboarding prompts). |
| **Content script: accessibility tree** | `assets/accessibility-tree.js-*.js` | Injected into `<all_urls>`, `all_frames: true`, `document_start`. Walks the DOM/AX tree and produces a serialized page snapshot (roles, names, bounding boxes, ref ids) that the agent uses to "see" the page. Also web-accessible. |
| **Content script: agent visual indicator** | `assets/agent-visual-indicator.js-*.js` | Injected into `<all_urls>`, top frame only, `document_idle`. Renders the on-page overlay/border that signals "Claude is acting on this page." Also web-accessible. |
| **Side panel** | `sidepanel.html` → `assets/index-*.js` | The chat UI (React/Plasmo). Main user surface. Chrome: `side_panel.default_path`; Firefox: `sidebar_action`. |
| **Options page** | `options.html` → `assets/options-*.js` | Settings/preferences. |
| **Pairing page** | `pairing.html` → `assets/pairing-*.js` | UI for the native-messaging / MCP pairing flow (connecting the extension to the local `com.anthropic.claude_browser_extension` native host). |
| **Blocked page** | `blocked.html` | Shown when navigation/automation is blocked (e.g., by managed policy or a disallowed site). |
| **Offscreen document** | `offscreen.html` / `offscreen.js` (+ `gif.js`, `gif.worker.js`) | MV3 offscreen doc for DOM-requiring tasks the SW can't do: **playing notification sounds** (`sounds/notification.mp3`) and **encoding GIFs** (animated capture export). `gif_viewer.html`/`gif_viewer.js` view the result. |
| **OAuth callback** | `oauth_callback.html` / `oauth_callback.js` | Receives the OAuth redirect and hands the code/token back to the extension. Web-accessible. |
| **MCP permissions UI** | `assets/mcpPermissions-*.js` | Permission prompts for MCP/native-bridge capabilities. |
| **Telemetry** | `assets/auto-track-*.js` | Analytics/event tracking (Segment + Sentry + Honeycomb + Datadog per CSP). |

---

## 3. Full feature inventory

- **Agentic page automation.** Background attaches `chrome.debugger` (CDP) to a target tab and
  drives it: synthetic mouse/keyboard via `Input.*`, script execution via `Runtime.evaluate`,
  element resolution via `DOM.*`, navigation/lifecycle via `Page.*`, and reads network/console
  via `Network.*` + `Runtime`/`Log`. The agent loop: snapshot page → decide action → dispatch
  CDP command → observe → repeat.
- **Accessibility-tree snapshotting.** `accessibility-tree.js` content script (all frames)
  serializes the page into a compact, ref-addressable structure the model consumes instead of
  raw HTML. Runs at `document_start` in every frame so iframes are covered.
- **Agent visual indicator.** `agent-visual-indicator.js` paints a border/overlay on the active
  page so the user can see when/where Claude is operating.
- **Side-panel chat UI.** Full Claude conversation surface in the side panel, including markdown,
  KaTeX math (`KaTeX_*` fonts), and Mermaid diagram rendering (`mermaid.core-*.js`,
  `*Diagram-*.js`, `flowDiagram`, `sequenceDiagram`, `classDiagram`, etc.).
- **Tab grouping of Claude's working tabs.** Tabs the agent opens/operates are put into a
  dedicated `chrome.tabGroups` group (named/colored) so the user can distinguish agent tabs
  from their own.
- **Input locking during agent runs.** While the agent acts, human pointer/keyboard input on
  the target page is suppressed (Chrome: typically via CDP input interception / overlay; the
  Firefox port emulates this with the `firefox-input-blocker.js` content script).
- **Console & network capture.** The agent captures page console output and network activity to
  feed back to the model (Chrome: CDP `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`,
  `Log.entryAdded`, `Network.*`; Firefox port reimplements console capture via
  `firefox-console-hook.js`/`-relay.js`).
- **Notification sounds.** Offscreen document plays `sounds/notification.mp3` (e.g., when a run
  finishes or needs attention), since the SW can't play audio.
- **GIF export.** Offscreen `gif.js`/`gif.worker.js` encode a sequence of captured frames into an
  animated GIF (record-the-agent / share-a-run); viewable via `gif_viewer.html`.
- **OAuth / identity login.** Sign-in via Claude/Anthropic OAuth using `chrome.identity` and an
  `oauth_callback.html` redirect target; session is shared with the claude.ai content script.
- **Native messaging / MCP bridge.** Connects to a local native host
  `com.anthropic.claude_browser_extension` via `chrome.runtime.connectNative` — an MCP bridge
  letting the extension expose browser capabilities to / receive instructions from a local
  Claude (e.g., Claude Desktop) over MCP.
- **Pairing flow.** `pairing.html` + `mcpPermissions` UI to establish and authorize the
  native/MCP connection.
- **Managed storage policy.** `managed_schema.json` defines enterprise policy
  (`storage.managed`) so admins can configure/restrict the extension via group policy.
- **i18n.** `i18n/*.json` (en-US, de-DE, es-ES, es-419, fr-FR, hi-IN, id-ID, it-IT, ja-JP,
  ko-KR, pt-BR) — localized UI strings.
- **Telemetry.** `auto-track` sends analytics to Segment, errors to Sentry, traces to Honeycomb,
  and metrics/RUM to Datadog (all whitelisted in CSP `connect-src`).
- **Keyboard command.** `toggle-side-panel` (Ctrl/Cmd+E) opens/closes the panel.

---

## 4. Browser APIs used by the ORIGINAL (Chrome)

| API | Where / why |
|---|---|
| `chrome.debugger` (CDP) | Background. Core of agentic automation — attach to tab, send CDP commands, receive CDP events. (Firefox lacks this → ported to scripting+tabs shims.) |
| `chrome.tabs` | Background. Create/query/update/activate tabs; track the agent's working tabs; resolve the side-panel's active tab context. |
| `chrome.tabGroups` | Background. Group Claude's working tabs into a labeled group. |
| `chrome.scripting` | `scripting` permission. Programmatic injection (snapshot helpers, indicator, input handling). Also the substrate the Firefox port uses to emulate CDP. |
| `chrome.storage` (local + session + managed) | Settings, session/agent state, auth/session tokens, pairing state; `managed` namespace bound to `managed_schema.json`. `unlimitedStorage` permission for large local data. |
| `chrome.sidePanel` | Open/configure the side panel; bound to the action and the `toggle-side-panel` command. (Firefox build uses `sidebar_action`.) |
| `chrome.runtime` | Messaging (`sendMessage`/`onMessage`, long-lived `connect` ports) AND `connectNative` for the native MCP host. |
| `chrome.runtime.connectNative` | Native messaging to `com.anthropic.claude_browser_extension`. |
| `chrome.webRequest` / `webRequestBlocking` | `webRequest`,`webRequestBlocking` permissions. Inspect/modify requests (notably stripping the `Origin` header to avoid Anthropic-org CORS 401s on `/v1/messages`; auth/session plumbing). |
| `chrome.declarativeNetRequest` | `declarativeNetRequest` permission. Static/dynamic rules for header rewriting / request shaping. |
| `chrome.dom.openOrClosedShadowRoot` | Content scripts. Pierce open AND closed shadow roots when building the accessibility-tree snapshot. (Chrome-only; Firefox port shims it.) |
| `chrome.identity` | OAuth login (launchWebAuthFlow / redirect handling) → `oauth_callback`. |
| `chrome.windows` | Window/focus management around the side panel and agent tabs. |
| `chrome.offscreen` | Create the offscreen document for audio playback + GIF encoding. (Chrome-only; Firefox emulates via a background page.) |
| `chrome.notifications` | `notifications` permission. Desktop notifications for run status. |
| `chrome.downloads` | `downloads` permission. Save exported GIFs / artifacts. |
| `chrome.alarms` | `alarms` permission. Periodic tasks / keep-alive / scheduled work in the SW. |
| `chrome.commands` | `toggle-side-panel` keyboard shortcut (Ctrl/Cmd+E). |
| `chrome.webNavigation` | `webNavigation` permission. Observe navigations (committed/completed) to track agent page state and re-inject/re-snapshot. |
| `chrome.action` | Toolbar button ("Open Claude") to toggle the panel. |
| `activeTab` | Permission for acting on the current tab. |
| host: `<all_urls>` | Operate on any site the agent visits. |

---

## 5. CDP usage detail (how pages are automated)

The agent attaches `chrome.debugger` to a tab (CDP target) and uses these domains:

- **Input** — synthetic interaction:
  `Input.dispatchKeyEvent` (typing, key presses), `Input.dispatchMouseEvent` (move/click),
  `Input.insertText`, `Input.dispatchTouchEvent` (where applicable). Primary "hands."
- **Runtime** — `Runtime.evaluate` / `Runtime.callFunctionOn` to run helper JS in the page
  (read state, resolve ref→element, scroll, focus). Consumes **events**:
  `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` (console capture).
- **DOM** — `DOM.getDocument`, `DOM.querySelector(All)`, `DOM.resolveNode`,
  `DOM.getBoxModel`/`DOM.getContentQuads` to map snapshot refs to live nodes and coordinates.
- **Page** — `Page.enable`, `Page.navigate`, `Page.reload`, `Page.captureScreenshot`
  (for screenshots / GIF frames), lifecycle/frame events (`Page.frameNavigated`,
  `Page.loadEventFired`, `Page.lifecycleEvent`).
- **Network** — `Network.enable` plus events `Network.requestWillBeSent`,
  `Network.responseReceived`, `Network.loadingFinished`/`Failed` (network capture for the model).
- **Target** — `Target.attachToTarget` / `Target.setAutoAttach` / target lifecycle to manage
  the attached tab and out-of-process iframes.
- **Log** (where used) — `Log.enable` + `Log.entryAdded` for browser log entries.

Loop: accessibility-tree snapshot (content script) → model picks action referencing a ref id →
background maps ref→node (DOM/Runtime) → dispatches `Input.*` or `Page.navigate` → observes
DOM/Network/Runtime/console events → re-snapshots.

---

## 6. Internal messaging architecture

- **Sidepanel ⇄ Background**: `chrome.runtime` messaging + long-lived `connect()` port. The
  panel sends user turns / commands ("start agent", "stop", "approve"); background streams agent
  status, snapshots, screenshots, run state back.
- **Content scripts ⇄ Background**:
  - `accessibility-tree.js` → background: serialized page snapshot (on request and on
    navigation). All-frames messages aggregated per tab.
  - `agent-visual-indicator.js` ⇄ background: show/hide/position the on-page indicator.
  - `content-script.ts-loader` (claude.ai) ⇄ background: auth/session handoff, onboarding.
- **Background ⇄ Offscreen**: `chrome.runtime` messages to trigger sound playback and GIF
  encoding; offscreen returns encoded blob / completion.
- **Background ⇄ Native host**: `chrome.runtime.connectNative` port to
  `com.anthropic.claude_browser_extension` (MCP request/response framing).
- **OAuth callback ⇄ Background**: `oauth_callback.js` posts the auth result to the extension.
- Message topics (by function): agent control (start/stop/step/approve), page snapshot request/
  response, action dispatch, indicator control, screenshot/GIF capture, notification, auth/
  session, pairing/MCP-permission, tab-group sync, input-lock toggle.

---

## 7. Storage keys & external endpoints

**Storage (chrome.storage):**
- `local` — settings/preferences, auth/session tokens, onboarding flags, pairing state,
  cached agent/run state, possibly captured artifacts (`unlimitedStorage`).
- `session` — ephemeral per-session agent state: active run id, working-tab ids, tab-group id,
  input-lock flag, attached-debuggee mapping (the Firefox port explicitly uses
  `storage.session` to emulate tab groups + input lock).
- `managed` — enterprise policy from `managed_schema.json`.

**External endpoints (from CSP `connect-src` + host_permissions):**
- `https://api.anthropic.com`, `wss://api.anthropic.com` — Anthropic API (model calls,
  streaming). `/v1/messages` is the call where the `Origin` header is stripped to dodge CORS 401.
- `https://claude.ai` — web app / session.
- `https://platform.claude.com` — platform/console services.
- `wss://bridge.claudeusercontent.com`, `wss://bridge-staging.claudeusercontent.com` —
  remote bridge (relay between extension and Claude services / remote MCP).
- `https://api.segment.io`, `https://*.segment.com` — Segment analytics.
- `https://*.ingest.us.sentry.io` — Sentry error reporting.
- `https://api.honeycomb.io` — Honeycomb tracing.
- `https://browser-intake-us5-datadoghq.com` — Datadog RUM/metrics.
- host_permissions `<all_urls>` — automation on any site.

---

## 8. External services (manifest CSP / host_permissions)

- **Anthropic API** (`api.anthropic.com` http+wss) — core inference.
- **claude.ai** + **platform.claude.com** — app/session/platform.
- **bridge.claudeusercontent.com** (wss, prod+staging) — websocket bridge.
- **Segment / Sentry / Honeycomb / Datadog** — analytics, errors, traces, RUM.
- **Native host** `com.anthropic.claude_browser_extension` — local MCP bridge (not a URL; via
  `nativeMessaging`).
- **Permissions surface:** `storage, activeTab, scripting, tabs, alarms, notifications,
  webNavigation, declarativeNetRequest, nativeMessaging, unlimitedStorage, downloads, identity,
  webRequest, webRequestBlocking` + `<all_urls>` host permissions. (Chrome original additionally
  uses `debugger`, `tabGroups`, `sidePanel`, `offscreen` — present in the Chrome manifest;
  replaced/shimmed in this Firefox build.)

---

## Entity edges

background --> CDP.Input : dispatch synthetic key/mouse/text events
background --> CDP.Runtime : evaluate JS / resolve refs in page
background --> CDP.DOM : query nodes, box model, ref-to-node mapping
background --> CDP.Page : navigate, reload, captureScreenshot, lifecycle
background --> CDP.Network : enable + observe request/response events
background --> CDP.Target : attach/auto-attach tab + OOPIF targets
background --> CDP.Log : enable + consume entryAdded
CDP.Runtime --> background : consoleAPICalled / exceptionThrown (console capture)
CDP.Network --> background : requestWillBeSent / responseReceived (network capture)
CDP.Page --> background : frameNavigated / loadEventFired (page state)
background --> chrome.debugger : attach CDP session to tab
background --> chrome.tabs : create/query/activate working tabs
background --> chrome.tabGroups : group Claude working tabs
background --> chrome.scripting : inject helpers / snapshot / input handling
background --> chrome.webRequest : strip Origin header (CORS 401 fix)
background --> chrome.declarativeNetRequest : header-rewrite / request rules
background --> chrome.webNavigation : track navigations, re-snapshot
background --> chrome.alarms : SW keep-alive / scheduled tasks
background --> chrome.notifications : run-status desktop notifications
background --> chrome.offscreen : create offscreen doc
background --> chrome.identity : OAuth login flow
background --> chrome.windows : window/focus management
background --> chrome.storage.session : run id, working-tab ids, input-lock, tab-group id
background --> chrome.storage.local : settings, tokens, pairing, cached state
managed_schema.json --> chrome.storage.managed : enterprise policy
content/accessibility-tree --> background : serialized page snapshot
content/accessibility-tree --> chrome.dom.openOrClosedShadowRoot : pierce shadow DOM
background --> content/agent-visual-indicator : show/hide/position overlay
content/content-script.ts-loader --> background : claude.ai auth/session handoff
sidepanel --> background : user turns / agent control (start/stop/approve)
background --> sidepanel : stream status / snapshots / screenshots
sidepanel --> chrome.sidePanel : panel surface (Chrome) / sidebar_action (FF)
background --> offscreen : trigger sound playback
background --> offscreen : trigger GIF encoding
offscreen --> sounds/notification.mp3 : play notification sound
offscreen --> gif.worker.js : encode animated GIF
offscreen --> chrome.downloads : save exported GIF
background --> nativeHost.com.anthropic.claude_browser_extension : connectNative (MCP bridge)
pairing.html --> background : establish native/MCP pairing
assets/mcpPermissions --> background : authorize MCP capabilities
oauth_callback.js --> background : deliver OAuth code/token
chrome.commands --> background : toggle-side-panel (Ctrl/Cmd+E)
chrome.action --> sidepanel : toolbar button opens panel
background --> api.anthropic.com : model calls (http + wss)
background --> claude.ai : app/session
background --> bridge.claudeusercontent.com : websocket bridge (remote MCP/relay)
assets/auto-track --> api.segment.io : analytics events
assets/auto-track --> ingest.us.sentry.io : error reports
assets/auto-track --> api.honeycomb.io : traces
assets/auto-track --> browser-intake-us5-datadoghq.com : RUM/metrics
background --> blocked.html : show when navigation/automation blocked
sidepanel --> i18n : localized UI strings
