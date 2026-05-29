# Session Analysis — a009114b (Chrome → Firefox port of the Claude extension)

> Reverse-engineering & porting notes extracted from a Claude Code session transcript.
> Project: `D:\_dev\claude-zen` — a Firefox port of the official **Claude** browser
> extension, whose application code is a minified Vite bundle shipped for Chrome.
> All secrets in the source transcript have been redacted in this document.

---

## 1. What this session set out to do

The session was driven by two successive `/goal` directives (with a Stop-hook that
blocked the agent from stopping until the goal held):

1. **Round 1 goal** — "You are the orchestrator of porting the Claude extension from
   Chrome to Firefox. The extension contains a lot of minified code; read/edit it
   deliberately and only when it makes sense. Use sub-agents, conserve tokens, bring it
   to a working state preserving maximum functionality. You may stop if tokens run out
   or the task is intractable."
2. **Round 2+ goal** — "Login succeeded. Make maximum functionality work. You cannot
   stop for me to verify — test yourself. Right now **messages are sent into the void
   and nothing happens**. You may only stop when the session limit is exhausted."

So the work split into:
- **Inventory** the partially-done conversion (a shim layer already existed).
- **Diagnose** why the extension loaded but messages didn't send.
- **Fix** the Firefox-specific breakages, verifying offline where the live runtime
  wasn't reachable.

The session ended on a hard session-token limit while attempting a real `web-ext run`
headless launch to capture the background console. The root cause of the "messages go
nowhere / 401" problem was found and fixed, but the literal end-to-end round-trip
(real token → message → reply) was never confirmed in a live Firefox session.

---

## 2. How the extension is structured

The shipped artifact is the **Chrome** build: a minified Vite/Rollup bundle under
`assets/` (~171 files) plus HTML entry pages. The Firefox port keeps that bundle
**unmodified** and wraps it in a hand-written **shim layer** of classic (non-module)
scripts that polyfill or translate the Chrome-only APIs the bundle expects.

### 2.1 manifest.json (Firefox MV3)

Key fields (version `1.0.72`):

- `manifest_version: 3`, `browser_specific_settings.gecko.id = "claude-zen@firefox"`,
  `strict_min_version: "128.0"` (Firefox 128 is the baseline — it gives native
  `chrome.*` aliasing, default `world:"MAIN"` support, and MV3 `webRequestBlocking`).
- `background.scripts: ["firefox-page-shims.js", "gif.js", "offscreen.js", "firefox-bg-loader.js"]`
  — Firefox uses an **event-page** background (classic scripts), **not** a service
  worker. The shim loads first, then the bundle is dynamically `import()`-ed by
  `firefox-bg-loader.js`.
- `action` (toolbar button) + `sidebar_action` (the panel) + `commands.toggle-side-panel`
  (Ctrl+E / Cmd+E). The Chrome bundle expects `chrome.sidePanel`; Firefox provides
  `browser.sidebarAction` instead — bridged by the shim.
- `content_scripts` (8 entries, current on-disk state — some added after this session):
  - `firefox-oauth-bridge.js` — MAIN world, `document_start`, on `claude.ai`.
  - `firefox-oauth-relay.js` — isolated world, `document_start`, on `claude.ai`.
  - `assets/content-script.ts-loader-*.js` — the bundle's own content script, `document_end`.
  - `assets/accessibility-tree.js-*.js` — `<all_urls>`, all frames (page automation).
  - `assets/agent-visual-indicator.js-*.js` — `<all_urls>`, visual agent overlay.
  - `firefox-input-blocker.js`, `firefox-console-hook.js` (MAIN), `firefox-console-relay.js`
    — later additions for page automation / console capture (not touched in this session).
- `permissions`: `storage, activeTab, scripting, tabs, alarms, notifications,
  webNavigation, declarativeNetRequest, nativeMessaging, unlimitedStorage, downloads,
  identity, webRequest, webRequestBlocking`.
- `host_permissions: ["<all_urls>"]`.
- A strict `content_security_policy.extension_pages` allowing `connect-src` to
  `api.anthropic.com`, `claude.ai`, `platform.claude.com`, telemetry endpoints
  (segment, sentry, honeycomb, datadog) and the `bridge.claudeusercontent.com`
  websockets. The CSP blocks inline `<script>`, which is why theme handling had to
  move from an inline page script into the shim (see §4.7).

### 2.2 HTML entry pages

`sidepanel.html`, `options.html`, `pairing.html`, `gif_viewer.html`,
`oauth_callback.html`, `blocked.html`, `offscreen.html`. Each page that runs the bundle
injects `firefox-page-shims.js` **before** the minified module so all `chrome.*`
shims exist first. `browser-polyfill.min.js` is present in the repo but is **dead
code** — never referenced — because Firefox 128+ already aliases `chrome.*` natively.

### 2.3 Shim / glue files (the actual port)

| File | Context | Role |
|------|---------|------|
| `firefox-page-shims.js` | every bundle context (bg + pages) | Core polyfill: tabs.query, sidePanel→sidebarAction, debugger→CDP translation, tabGroups emulation, offscreen inline, DNR enums, identity, theme, fetch header injection. |
| `firefox-bg-loader.js` | background event page | Dynamic-imports the SW bundle; identity bridge; OAuth relay; cold-start handlers; webRequest header injection; startup diagnostics. |
| `firefox-oauth-bridge.js` | claude.ai MAIN world | Provides a fake `chrome.runtime.sendMessage` so claude.ai's OAuth page can talk to the extension. |
| `firefox-oauth-relay.js` | claude.ai isolated world | Forwards postMessages from the MAIN-world bridge to the extension background and returns the response. |
| `oauth_callback.js` | oauth_callback.html | Fallback redirect handler (sends `FF_OAUTH_CALLBACK`); normally bypassed by `identity.launchWebAuthFlow`. |
| `gif_viewer.js` | gif_viewer.html | Reads exported GIF from `storage.local` (native in FF, no shim needed). |
| `scripts/update-from-store.ps1` | tooling | Pulls fresh Chrome-Store builds; a `$Protected` list keeps the firefox-* files and patched HTML from being overwritten. |

### 2.4 Notable bundle files referenced during analysis

- `assets/sidepanel-hXBOAxVN.js` — the sidepanel React app (chat UI, tab-context logic,
  the "No active tab" throw site, the Anthropic SDK client init).
- `assets/PermissionManager-uCwrpbh7.js` — shared chunk: token storage, OAuth
  `launchWebAuthFlow`, permission gating.
- `assets/mcpPermissions-CUBzZeeG.js` — exports the custom `fetch` wrapper (idle-timeout
  on SSE streams) and the Anthropic SDK client class.
- `assets/service-worker.ts-B5az7Lf2.js` — the background bundle: `action.onClicked`,
  `commands.onCommand`, the DNR rule builder `B()`, OAuth token exchange `Se()`, tab
  orchestration.

---

## 3. Key reverse-engineering findings

### 3.1 Auth / OAuth

- The Chrome bundle's `onMessageExternal` handler only handles two message types:
  **`ping`** and **`oauth_redirect`**. The Firefox relay (`firefox-oauth-relay.js` +
  `firefox-bg-loader.js`) therefore covers 100% of the external protocol.
- claude.ai's OAuth page does `await chrome.runtime.sendMessage(extId, msg)` and reads
  `.success`. On a web page Firefox has no `chrome.runtime`, hence the MAIN-world bridge.
- OAuth flow path: **bridge (MAIN) → relay (isolated) → bg-loader → token exchange**.
  Firefox uses `browser.identity.launchWebAuthFlow` for the redirect interception;
  `oauth_callback.js` is only a fallback if the identity API fails.
- Tokens are stored under keys `accessToken` / `refreshToken`; the bundle reads them
  from the same keys the shim's OAuth logic writes. The SDK client is constructed as
  `new Ft({ baseURL: pe.apiBaseUrl, authToken, dangerouslyAllowBrowser:true, fetch: Vt() })`.
- The bg-loader's own token exchange was verified **byte-for-byte identical** to the
  bundle's internal exchange `Se()` (same endpoint, method, content-type, body params,
  `client_id`, `redirect_uri`) — proving the stored token is exactly what Chrome would
  produce, so the token was **ruled out** as the 401 cause.

### 3.2 Messaging

- Internal messaging uses the standard `runtime.sendMessage` / `onMessage` surface
  (native in Firefox). One observed Firefox warning: *"Promised response from onMessage
  listener went out of scope"* — a benign async-response lifetime warning.
- The external (web-page → extension) channel is the bridge/relay pair described above.

### 3.3 Tab management & the sidepanel tab context

- The chat needs an **active tab id** (`c` in the minified chat hook `wne({…tabId:c…})`,
  surfaced up through the main UI state `m`). The bundle initializes this **only from
  the URL param `?tabId=N`**. In Chrome that param is set via
  `chrome.sidePanel.setOptions({ tabId, path:'sidepanel.html?tabId=N' })` at click time.
- In Firefox the sidebar URL has no `?tabId=`, so `c` is `undefined`, and a `keydown`
  handler that calls `tabs.query({active:true, currentWindow:true})` throws
  **`Error: No active tab`** — the headline bug.
- Additionally, `tabs.query({active:true,currentWindow:true})` can return `[]` in the
  Firefox sidebar context because the sidebar's own window is "current".

### 3.4 Page automation / CDP

- The Chrome bundle drives pages via `chrome.debugger` (Chrome DevTools Protocol).
  Firefox has **no CDP** equivalent. The shim now contains a `chrome.debugger` →
  Firefox-API translation layer plus CDP **event sources** (`webRequest` → `Network.*`,
  `webNavigation` → `Page.*`). These large sections exist in the current
  `firefox-page-shims.js` but were largely outside this session's edits (the session
  focused on auth/tab/401). Page automation fidelity remains a known limitation.

### 3.5 MCP

- `chrome.mcp.*` / `chrome.bridge.*` / `chrome.chat.*` / `chrome.scheduled` are **not
  real Chrome APIs** — they are string namespaces used for analytics/telemetry events,
  so they need no shimming.
- MCP permission gating lives in `assets/mcpPermissions-*.js`, which also exports the
  fetch wrapper `La` (imported as `Vt`/`Q`): a plain `fetch` wrapper that applies an
  idle-timeout to `text/event-stream` (SSE) streaming responses. No FF-incompatible
  logic — confirmed safe.

### 3.6 Tab groups

- `chrome.tabGroups` and `chrome.tabs.group` / `tabs.ungroup` are Chrome-only and
  `undefined` in FF 128. The shim provides a tab-groups **emulation** plus
  `tabs.group`/`tabs.ungroup` **stubs** to keep the bundle's tab orchestration from
  throwing at uncaught call sites.

### 3.7 Offscreen documents

- `chrome.offscreen` has no Firefox equivalent. Originally no-op'd. In the current
  shim it's "handled inline in the Firefox background page" (the bg event page can run
  audio + the gif generator directly), with an offscreen-message loopback that
  dispatches background→background sends locally. Audio notifications and GIF export
  were a known-degraded area early in the session.

---

## 4. Problems hit and how they were solved

### 4.1 "Chrome extension API not available" on claude.ai (bridge sync return)

- **Cause:** `firefox-oauth-bridge.js`'s `chrome.runtime.sendMessage` returned `true`
  synchronously, but modern claude.ai does `await sendMessage(...)`.
- **Fix:** rewrote the bridge so `sendMessage` returns a **Promise** that resolves with
  the background's response when no callback is supplied (`firefox-oauth-bridge.js`).

### 4.2 "No active tab" (the core breakage) — multi-layer fix

Implemented defense in depth in `firefox-page-shims.js` + `sidepanel.html`:

1. **`tabs.query` wrapper** — native query → if empty, retry without `currentWindow` →
   filter to the `lastFocused` *normal* window → drop extension/about/chrome pages.
   Handles both callback and Promise forms of `windows.getLastFocused`. Verified with
   7 mocked unit scenarios (all pass). The patch must sit **before** the tabId injector
   because the injector calls `query` synchronously inside a `Promise` constructor.
2. **Deferred-module loader** — `sidepanel.html`'s bundle `<script type="module">` was
   renamed to `type="firefox-deferred-module"` so the browser ignores it; the shim
   injects `?tabId=N` into the URL via `history.replaceState`, then converts the
   deferred script to a real module-script and lets it run. Race-safe: waits for the
   async tab resolution **and** DOM parse, with a 2s safety net. Skips injection for the
   `mode=window` scenario (scheduled tasks resolve tabId from storage, not active tab).
   A `MutationObserver` approach was tried first and abandoned (module scripts get an
   "already started" flag at parse time).
3. **`sidePanel.setOptions` → `sidebarAction.setPanel({tabId,panel})`** — the cleanest
   path: the bundle itself calls `setOptions({tabId,path:'sidepanel.html?tabId=N'})`
   before `open()`, so translating it to a per-tab `setPanel` opens the sidebar with the
   correct URL using the bundle's native logic. This is the primary fix; the deferred
   loader is the backup for paths that bypass `setOptions` (Firefox's native sidebar
   button).
4. **`URLSearchParams.get` override** — returns a cached tabId if the URL is empty
   (secondary safety net).

> Note: despite (1)–(4), the user still reported `No active tab` mid-session. The agent
> traced the React data-flow (`c` ← hook `wne` ← UI state `m` ← URL `?tabId=`) and
> concluded the injector *should* feed it, attributing the persistence to the sidebar
> not being reloaded or a path bypassing the injector. Live confirmation was never
> obtained.

### 4.3 HTTP 401 from api.anthropic.com — root cause found via web-ext lint

This was the breakthrough of the session, reached after several hypotheses:

- **Early hypothesis:** Firefox doesn't reliably apply DNR `modifyHeaders`, so the
  bundle's `declarativeNetRequest.updateSessionRules` rule that adds
  `User-Agent`, `anthropic-client-platform: claude_browser_extension`, and
  `anthropic-client-version` to `api.anthropic.com/*` never applies → the API can't
  validate the OAuth client → 401. (The SDK itself sends `Authorization: Bearer`,
  `anthropic-version`, `anthropic-beta`, `anthropic-dangerous-direct-browser-access`;
  only those three client headers come from DNR — the sole Chrome/FF difference.)
- **CORS preflight test** (run against `api.anthropic.com/v1/messages`): the API echoes
  any requested header into `access-control-allow-headers` with `allow-origin: *`. This
  **proves** the client headers can be added at the **fetch layer** without a preflight
  failure — independent of DNR/webRequest reliability.
- **Dummy-token probe:** with an invalid bearer the API returns
  `{"type":"authentication_error","message":"Invalid bearer token"}` *regardless* of
  client headers → the API validates the token **before** any client-header logic.
- **web-ext lint — the smoking gun:**
  `declarativeNetRequest.RuleActionType` and `declarativeNetRequest.HeaderOperation`
  are **UNSUPPORTED_API** (not implemented) in Firefox. The bundle builds its rule as
  `type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS` and
  `operation: chrome.declarativeNetRequest.HeaderOperation.SET`. Those enum **objects
  are `undefined`** in Firefox, so the property access throws `TypeError`.
- **Blast radius:** the rule-builder `B()` is `await`ed at the **top** of both
  `onStartup` and `onInstalled` (`f(), await B(), await t.initialize(), …`). The throw
  **aborts all background init after it** (initialize, bridge setup, native messaging,
  alarms) on every Firefox start — far bigger than just the 401.

**Fixes for the 401:**
1. **DNR enum shim** in `firefox-page-shims.js` — provides `RuleActionType`,
   `HeaderOperation`, `ResourceType` constants so `B()` builds its rule without throwing,
   unblocking the entire startup sequence. Hardened: plain-assign → `defineProperty`
   fallback → full-namespace replacement, all wrapped so it can never halt the rest of
   the shim. Confirmed by simulation (throws without shim, builds with it).
2. **fetch-wrapper header injection** in `firefox-page-shims.js` — wraps `window.fetch`
   to inject `anthropic-client-platform` / `anthropic-client-version` into every
   `api.anthropic.com` request (runs before the SDK; preserves existing
   `Authorization`). Verified with 8 unit tests across string/Request/Headers input
   forms. CORS-verified to be accepted.
3. **webRequest fallback** in `firefox-bg-loader.js` — `onBeforeSendHeaders` also sets
   the same client headers (`['blocking','requestHeaders']`) as belt-and-suspenders.
   The filter was narrowed from `[api.anthropic.com, platform.claude.com]` to **just
   `api.anthropic.com`** to avoid interfering with the OAuth token exchange on
   `platform.claude.com`.
4. **401/403 response-body diagnostic logger** (read-only fetch wrapper) to surface the
   exact server reason in the console.

### 4.4 Cold-start click handling

- If the user clicks the toolbar button or hits Ctrl+E **before** the SW bundle finishes
  its dynamic import, the real `chrome.action.onClicked` / `chrome.commands.onCommand`
  handlers aren't registered yet and the gesture is lost.
- **Fix:** synchronous placeholder listeners in `firefox-bg-loader.js` that open the
  sidebar via `browser.sidebarAction.open()` in the user-gesture context regardless of
  bundle load state.

### 4.5 update-from-store.ps1 hardening

- Added `firefox-oauth-bridge.js` and `firefox-oauth-relay.js` to `$Protected`.
- Added a re-patch step so the `type="module"` → `type="firefox-deferred-module"`
  rename survives future Chrome-Store pulls. (Chrome builds never contain `firefox-*`
  files, so they aren't overwritten — this is edge-case insurance.)

### 4.6 Startup permission diagnostics

- bg-loader logs whether `<all_urls>` host permission is granted. In Firefox MV3
  host permissions are **optional and user-granted**; if not granted, DNR/webRequest/
  content-scripts silently no-op. (Ultimately the 401 was the DNR enum throw, not a
  missing permission — a 401, not a CORS error, proves the request reached the server.)

### 4.7 Theme handling (CSP)

- The inline theme `<script>` in the HTML pages is blocked by the extension CSP, so
  theme detection moved into `firefox-page-shims.js`.

---

## 5. Verification done (offline)

The agent could not reach the live Firefox session (token lived only in the running
profile's memory under a temporary add-on UUID; the on-disk store was empty / Snappy-
compressed). So it verified offline:

- `node --check` syntax on all four shim/glue JS files — all OK.
- `tabs.query` wrapper — 7 mocked scenarios pass (one initial failure `S6` turned out to
  be a bug in the test mock, not the wrapper).
- fetch-wrapper header injection — 8 unit tests pass.
- DNR rule-construction simulation — throws without the enum shim, builds with it.
- Real CORS preflight + dummy-token probe against `api.anthropic.com`.
- `web-ext lint` (Mozilla validator): **2 errors** (`ICON_NOT_SQUARE` for
  `icon-128.png` — non-blocking; and the DNR enum `UNSUPPORTED_API`), **116 warnings**.
  Other UNSUPPORTED_API hits: the whole `debugger.*` family (CDP — fundamentally
  unsupported), plus offscreen/sidePanel/tabGroups (already shimmed).
- `web-ext run --headless` actually **installed the extension as a temporary add-on in
  real Firefox** (manifest valid, background scripts load; the icon error doesn't block
  loading). A `--verbose` relaunch to capture the DNR self-test logs was in progress
  when the session token limit hit.

---

## 6. Important code locations (quick index)

- **Headline bug throw:** `assets/sidepanel-hXBOAxVN.js` — `throw new Error("No active tab")`.
- **Chat tab-id hook:** `wne({…tabId:c…})` in `sidepanel-hXBOAxVN.js`; UI state `m`.
- **DNR rule builder:** `B()` in `assets/service-worker.ts-B5az7Lf2.js`, `await`-ed atop
  `onStartup` / `onInstalled`.
- **OAuth token exchange:** `Se()` in `assets/PermissionManager-uCwrpbh7.js` (matched by
  bg-loader's exchange).
- **Fetch wrapper:** `La` (= `Vt`/`Q`) in `assets/mcpPermissions-CUBzZeeG.js`.
- **SDK client class:** `Ft` (constructed in sidepanel + mcpPermissions).
- **Shim sections (current):** see the `// ──` headers in `firefox-page-shims.js`
  (tabs.query, tabId injector, tabGroups emulation, debugger→CDP, sidePanel→sidebarAction,
  per-tab visibility, offscreen inline, DNR enums, identity, theme, fetch injection).
- **bg-loader sections:** identity bridge, OAuth probe, OAuth external relay, cold-start
  handler, startup diagnostics, webRequest header injection.

---

## 7. Decisions & open questions

**Decisions made:**
- Keep the Chrome bundle untouched; do everything via the shim layer.
- Prefer translating the bundle's native calls (e.g. `setOptions`→`setPanel`) over HTML
  hacks, but keep the deferred-module loader and `URLSearchParams` override as backups.
- Inject the `anthropic-client-*` headers at the fetch layer (CORS-verified) rather than
  relying on Firefox DNR `modifyHeaders`.
- Treat `browser-polyfill.min.js` as dead code (left in place — low priority, risky to
  remove without the user).

**Open questions / unverified at session end:**
- **End-to-end message round-trip never confirmed live.** The DNR-enum fix is the
  highest-confidence root cause for the 401, but the real token → message → reply path
  was not exercised in a running Firefox. The Stop-hook correctly kept flagging the goal
  as unmet for this reason.
- **`No active tab` persistence:** even after the multi-layer tab fix the user reported
  it once more; the agent's data-flow analysis says the injector should feed the chat,
  but a live reload was needed to confirm.
- **Page automation via `chrome.debugger`/CDP:** Firefox has no CDP; the shim attempts a
  translation layer (webRequest→Network, webNavigation→Page) but full fidelity is a
  known limitation and was not the session's focus.
- **Offscreen-dependent features** (audio notifications, GIF export): reworked to run
  inline in the background page; not verified live.
- **`ICON_NOT_SQUARE`** lint error on `icon-128.png` — cosmetic, non-blocking, unfixed.

**Cross-session memory written** (in the agent's project memory dir, not the repo):
`project_firefox_port.md`, `feedback_autonomous_work.md`, `MEMORY.md` — recording the
project shape and the user's preference for fully autonomous, token-frugal work enforced
via the `/goal` Stop-hook.
