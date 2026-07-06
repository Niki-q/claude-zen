# Claude Zen: Firefox Port of the Official Claude Chrome Extension

## Overview

**Claude Zen** is a Firefox MV3 port of the official Claude Chrome extension (Chrome ID: `fcoeoabgfenejglbffodgkkbkcdhcgfn`). It is designed as a **two-layer architecture** that keeps the upstream minified Chrome bundle untouched and layers Firefox-specific compatibility shims on top, allowing updates to be pulled directly from the Chrome Web Store via PowerShell script (`scripts/update-from-store.ps1`).

- **Current version**: 1.0.72 (matches upstream)
- **Git hash**: e0ca8688fee2e6db45244353a0e842c6c8e31d20
- **Firefox Gecko ID**: `claude-zen@firefox`
- **Minimum Firefox version**: 128.0

## Architecture: Two Layers

### Layer 1: Upstream Chrome Bundle (Untouched)

The `assets/` directory contains the **minified, versioned Chrome extension bundle** pulled directly from the Chrome Web Store:
- **Service worker**: `service-worker.ts-B5az7Lf2.js` (ES module, main bundle logic)
- **Content scripts**: minified loaders and page injection scripts (hashed filenames)
- **Page bundles**: sidepanel, options, pairing modules
- **Fonts & SVGs**: Anthropic brand assets (never edited locally)

These files are never edited. They are completely replaced during `update-from-store.ps1` runs (except protected files listed in the script).

### Layer 2: Firefox Shim Scripts

Hand-written classic (non-module) scripts that are loaded **before** the bundle and patch Chrome APIs to Firefox equivalents:

1. **Load order in `manifest.json` → `background.scripts`**:
   ```json
   "background": {
      "scripts": [
         "firefox-page-shims.js",     // 1. Core API shims (tabs, sidePanel, tabGroups, etc.)
         "gif.js",                     // 2. GIF generation (from offscreen doc)
         "offscreen.js",               // 3. Audio playback + Blob URL management (background context)
         "firefox-bg-loader.js"        // 4. OAuth, webRequest handlers, DNR enum shim
      ]
   }
   ```
   Then: dynamic ES-module import of the bundle at the end of `firefox-bg-loader.js`:
   ```javascript
   import('./assets/service-worker.ts-B5az7Lf2.js').catch((e) => { ... });
   ```

2. **Page contexts** (sidepanel, options, pairing): `firefox-page-shims.js` injected via `<script>` before the first `<script type="firefox-deferred-module">` (the bundle).

## File-by-File Reference

### `firefox-page-shims.js`

**Purpose**: Polyfill Chrome APIs in all contexts (background + page documents). Loaded first, before any bundle code runs.

**Key shims**:

- **`chrome.sidePanel` → `browser.sidebarAction`**: Firefox sidebar is shared globally; the shim accepts `setOptions({path: "sidepanel.html?tabId=N"})` and applies it globally via `browser.sidebarAction.setPanel()`. The global URL is fixed; the per-tab `tabId` is injected into the URL params by the deferred-module loader (see below) instead.
  
- **`chrome.tabGroups`** (tab grouping): **HYBRID** design. **Two distinct feature gates** (this matters — Firefox shipped them in different versions):
  - `canGroup` = `chrome.tabs.group` is a function → **FF 138+**. Gates the creation of *visible native groups* (`isGroupable`, the native branch of `groupFn`, and the visual-promotion listener). This is what makes a real Firefox group appear.
  - `nativeGroups` = the `chrome.tabGroups` *namespace* exists (numeric `TAB_GROUP_ID_NONE`) → **FF 139+**. Gates only the title/color overlay (`tabGroups.get/query/update/move`).
  - **Bug history:** originally *everything* native was gated on `nativeGroups`, so FF 138 users (who have `tabs.group()` but not the namespace) got **no visible group at all** — the promotion listener was never installed. Splitting the gates fixed it; FF 138 now gets a visible (untitled) group, FF 139+ gets the orange "Claude" title too. A `[claude-zen][groups] init ff=… tabs.group=… tabGroups.ns=…` line is logged at background startup to confirm which path is active.

  The crux: Firefox 139's *native* `chrome.tabs.group` **refuses to group privileged/extension pages** (`moz-extension://`, `about:*`, `chrome://`) — and Claude's "main tab" is frequently exactly that (a new-tab-page override), while freshly created scratch tabs open at `about:newtab`. Using native blindly meant `createGroup(mainTab)` threw, no group was ever created, and the agent couldn't control any new tab ("No group found for main tab", "not in the same group"). So the shim keeps a `storage.session` **registry as the unified membership source of truth**:
  - **Groupable web tab** → creates a **real, visible native group**, mirrored into the registry (`native: true`).
  - **Privileged tab / native rejection / FF ≤138** → emulates a logical group with a **negative id** (never collides with native positive ids or `NONE = -1`), `native: false`.
  - `chrome.tabs.get`/`query` are **overlaid** so a tab's `groupId` comes from the registry when Claude manages it, else from the native value — real groups, emulated groups, and user-made native groups all report consistently. `chrome.tabGroups.get/query/update/move` are likewise overlaid (registry first, forwarding to native for `native:true` groups).
  - Registry keys: `__ffGroupMeta` (groupId → `{id,title,color,collapsed,windowId,native}`), `__ffTabGroup` (tabId → groupId), `__ffGroupSeq` (next negative emulated id). The `tabGroups` permission is requested in the manifest.
  - **Main-tab seeding** (`__ffEnsureMainGroup`, called from the sidepanel tabId resolver before the bundle loads): the upstream bundle only groups the main tab via its MCP/session tools — for a plain "open a tab" flow it never calls `createGroup`, so the main tab's `groupId` stays `NONE`, `tabs_create`'s `if (mainTab.groupId !== NONE)` guard skips grouping new tabs, and the access gate rejects every new tab. Seeding the main tab into a group makes `get(mainTab).groupId` non-`NONE` → the bundle groups new tabs into it → the gate's `findGroupByTab` reconstructs the group from `chrome.tabs.query({groupId})` (our overlay, `isUnmanaged`) and grants access.
  - **Visual promotion** (background `tabs.onUpdated` listener): new tabs are privileged at creation (`about:newtab`) and can't be natively grouped, and the main tab is often a privileged extension page — so a session's registry group is frequently emulated/invisible. To still show a **real Firefox group**, when a Claude-managed tab finishes navigating to a groupable URL it is promoted into a native group (`meta[gid].visualGroupId`, titled "Claude", color orange). Promotions are serialized so a `browser_batch` of navigations lands in one group. The registry remains the membership truth (the access gate reads registry `groupId`, not the visual native id), so the visual group is purely cosmetic and never diverges the gate.

  **Access boundary**: the upstream bundle only acts on tabs whose group matches the session's group, bailing when `tab.groupId === TAB_GROUP_ID_NONE` (in `service-worker.ts-*.js` / `sidepanel-*.js`) and enumerating siblings via `tabs.query({groupId})` (in `mcpPermissions-*.js`). The group is the access boundary — Claude only touches tabs in the group it created. The hybrid honors this in both real and emulated modes.

- **`chrome.debugger` (page automation via Chrome DevTools Protocol)**: Firefox has no debugger API. Translates CDP commands to Firefox `scripting.executeScript()`:
  - `Input.dispatchMouseEvent` → synthetic `MouseEvent` + `PointerEvent` pair in page MAIN world. **Click-failure reporting**: a release that hits no element, or hits a target that was inert **at hit time** *and* produced **zero DOM mutations**, rejects so the model gets a real error instead of a false "Clicked". The inert check (`disabled`/`aria-disabled`/`pointer-events:none`) is read **before** dispatch — sites (e.g. Angular Material chips on NotebookLM) flip the target to `pe:none` *as a result* of the click, and reading it after dispatch falsely failed successful clicks; DOM-mutation evidence (`mut>0`) likewise counts as success.
  - `Input.dispatchKeyEvent` → synthetic `KeyboardEvent` (with special handling for Backspace/Delete on contentEditable)
  - `Input.insertText` → `insertText` command or direct value setter with change/input events
  - `Page.captureScreenshot` → `browser.tabs.captureTab(tabId, {scale:1})` (FF 59+, captures the **requested** tab even when inactive); falls back to `tabs.captureVisibleTab()` (active tab only — logs a loud MISMATCH warning if that's the wrong tab). `scale:1` pins the image to CSS pixels = the click shim's coordinate space.
  - `Runtime.evaluate` → `executeScript(...eval(expr))`; awaits thenables (CDP `awaitPromise` parity), degrades non-cloneable results to strings, and **never throws** — eval/injection errors return a CDP-shaped `{exceptionDetails}` (the bundle reads `m.exceptionDetails` unguarded; an undefined response crashed `javascript_tool` with "can't access property exceptionDetails").
  - `*.enable/disable`, `attach/detach/getTargets` → no-op
  
  **Limitation**: Synthetic events are untrusted (`isTrusted === false`). Elements gating on trusted input may not respond.

- **Pending-URL tracking (Chrome `pendingUrl` emulation)**: Firefox reports a freshly created / still-navigating tab's `url` as `about:blank`/`about:newtab` until the navigation **commits**, and `new URL("about:blank").host === ""`. The bundle's permission system keys every grant on that host (`findApplicablePermission` requires a *truthy* netloc), so a tool that ran before commit caused: prompt shows "this page" → every user click stores a dead `{netloc:""}` grant → post-grant retry re-checks the same empty host → **"Permission still required after granting" loop** (burned an entire session; Chrome is immune because `chrome://newtab` has host `"newtab"` and tabs expose `pendingUrl`). Fix: `tabs.create`/`tabs.update` wraps record the target URL (`__czRecordPendingUrl`), and the `tabs.get`/`query` overlay reports it as the tab's `url` (+`pendingUrl`) while the native url is still `about:*`-ish (`__czApplyPendingUrl`; 45s TTL, cleared on commit).

- **`chrome.offscreen`**: Reports `hasDocument: true` (Firefox background is a real DOM page, unlike Chrome's service worker). Bundle's offscreen messages are dispatched in-process; sidepanel offscreen requests route to background via `runtime.sendMessage()`.

- **`chrome.declarativeNetRequest` enums**: Firefox doesn't export `RuleActionType`, `HeaderOperation`, `ResourceType` enum objects. Defines them as string constants so the bundle's MODIFY_HEADERS rule can build without throwing. Wraps `updateSessionRules()` to silently ignore rejections (Firefox DNR modifyHeaders may not apply, but reliable fallbacks exist elsewhere).

- **`chrome.identity` (OAuth)**: Two paths:
  - Background context: tries `browser.identity.launchWebAuthFlow()` first, falls back to `manualTabAuth()` (webRequest redirect interception)
  - Page context (sidepanel): routes to background via `FF_IDENTITY_LAUNCH` message

- **`chrome.tabs.query` (sidebar workaround)**: In Firefox sidebar context, the native query `{active: true, currentWindow: true}` returns `[]` (sidebar window has no tabs). Fallback: query without window filter, pick the active tab in the most-recently-focused normal browser window.

- **Sidepanel deferred-module loader**: On `sidepanel.html`, the bundle's `<script type="module">` is renamed to `type="firefox-deferred-module"` (unknown type, ignored by browser). The shim resolves the active tab, injects `?tabId=N` into the URL via `history.replaceState()`, then creates a real `<script type="module">` with the same src. The bundle then runs with the `tabId` parameter, and the active-tab state is populated (otherwise throws "No active tab").

- **Fetch header injection**: Adds `anthropic-client-platform` and `anthropic-client-version` headers to requests to `api.anthropic.com` (redundant with webRequest injection, but ensures page-context requests are marked correctly). Also detects and logs 401/403 response bodies.

- **Gate-independent force-stop (`czForceStop`, sidepanel only)**: the upstream Stop no-ops in Firefox — the bundle's sidepanel `STOP_AGENT` handler gates its abort on `n` = `isAgentRunning` (this React instance's `isLoading`) and **ignores the SW-resolved `targetTabId`**. So whenever the single global sidebar isn't the actively-streaming instance, or it's in a between-requests **gap/backoff** (`isLoading` momentarily false while the agent loop is still alive), `n&&s()` short-circuits and `cancel()` never runs — yet `{success:true}` is still returned, so the failure is silent. The *abort itself* (`ne.current.abort()`) is correct and **definitively terminal**: the agent loop's catch first statement is `if("Request was aborted."===t)return;`, which runs **before** any retry/backoff branch (verified by tracing `sidepanel-*.js`; an abort is retry-proof because its message matches none of the 5xx/`network error`/`stream idle`/… retry prefixes). We bypass the broken gate: the shim **patches `AbortController`** (and `AbortSignal.any`, to decompose a request signal the SDK combined with its timeout) to track every controller the sidepanel page creates, then on STOP aborts the one whose signal the streaming SDK is **watching** — aborting the SDK's *own* signal makes it throw `APIUserAbortError` with message exactly `"Request was aborted."` → the terminal branch fires with zero retry risk. The fetch wrapper records each `/v1/messages` request's `signal` (`__czLastAgentSignal`) for a precise abort, and arms a ~2.5 s `__czStopUntil` window so the loop's *immediate next* request (the gap/backoff iteration) is aborted at its own fetch too. A sidepanel `runtime.onMessage` listener fires `czForceStop` on **both** `STOP_AGENT` (the bundle's main-tab button → SW re-broadcast `{targetTabId}`, *and* our injected content-script `#__cz_stop_btn`) and our own `FF_FORCE_STOP` — observe-only (never `sendResponse`/`return true`, so the bundle's handler keeps the reply channel). Scoped to `sidepanel.html` so the background / MCP-bridge controllers are never touched.

- **Input-block heartbeat on screenshot**: `__ffSignalActive(tabId)` is fired on `Page.captureScreenshot` too, not only on `Input.*` dispatch. During the agent's observe-loop (repeated screenshots, no input dispatch for >8 s) the input-blocker's heartbeat TTL would otherwise lapse and let real user clicks through ("запрет не работает" intermittently). A screenshot of the driven tab is proof the session is active on it; this strictly extends blocking during active operation and never affects synthetic clicks/typing.

- **CDN script blocking**: Intercepts `Element.prototype.appendChild/insertBefore` to block Segment CDN scripts blocked by extension CSP.

- **Datadog SDK warnings**: Suppresses known Datadog double-bundle warnings from console.

- **Theme detection**: Replaces inline theme script (blocked by CSP) with `matchMedia('prefers-color-scheme')` listener.

### `firefox-bg-loader.js`

**Purpose**: Background-context specific logic: OAuth flows, webRequest handlers, DNR setup, the MCP-bridge unblock, and entry point for dynamic import of the service worker bundle.

**Key handlers**:

- **MCP bridge unblock (`ServiceWorkerGlobalScope` shim)**: defines `globalThis.ServiceWorkerGlobalScope` (a dummy) **in the background only** — this file is never injected into pages. The MCP WebSocket relay (`wss://bridge.claudeusercontent.com`, the hosted bridge that pairs the extension with a desktop Claude / Claude Code) is driven by `mcpPermissions-*.js`, whose three background-only setups (`fn()` = the bridge-keepalive alarm → WS connect, `es()` = bridge-tab nav tracking, `PermissionManager.Ie()` = direct token read) are **all gated on `"ServiceWorkerGlobalScope" in globalThis`**. Chrome's background IS a SW so that's true; Firefox's background is a DOM page so it was **false → the bridge never connected** (the same "FF background is a DOM page, not a SW" gotcha as tab-groups). Defining it flips all three to the correct Chrome-SW behaviour; the sidepanel (never loads this file) keeps message-routing token refresh to the background, exactly like Chrome's sidepanel. Read only as a presence check, never as a constructor. **Native-host MCP (`connectNative`) stays an unported graceful no-op** (needs an OS-level host binary); the WS bridge is the code-only transport. **End-to-end MCP tool use needs a paired desktop companion** — can't be verified in-repo.

- **`FF_IDENTITY_LAUNCH` message listener**: Routes OAuth from sidepanel via `browser.identity.launchWebAuthFlow()` or falls back to `manualTabAuth()`.

- **`manualTabAuth()`**: Opens an auth tab, intercepts the redirect via `chrome.webNavigation` listeners and `chrome.webRequest.onBeforeRedirect()` / `onHeadersReceived()`. Returns the redirect URL when detected. Registered globally without tab filter to avoid race with tab creation.

- **OAuth probe function `ffOAuthProbe()`**: Debug utility for testing the full OAuth flow from about:debugging. Exposed as `window.ffOAuthProbe()`.

- **OAuth relay handler**: Listens for `{_czOAuthType: 'relay', message}` from `firefox-oauth-relay.js`, handles `oauth_redirect` messages by exchanging the auth code for tokens via `POST /v1/oauth/token`, and fetches the account UUID. Mirrors the Chrome bundle's `PermissionManager.storeTokens()` behavior.

- **Toolbar button + keyboard shortcut fallbacks**: Synchronous `chrome.action.onClicked` and `chrome.commands.onCommand` listeners that open the sidebar before the bundle fully loads (user gesture preservation).

- **Host permission diagnostics**: Logs whether `<all_urls>` permission is granted (required for webRequest/DNR/content-script injection; without it, requests silently 401).

- **DNR enum self-test**: Confirms the enum shim applied correctly and that MODIFY_HEADERS rules can build.

- **webRequest header injection**: `onBeforeSendHeaders` listener that:
  - Sets/overwrites `anthropic-client-platform`, `anthropic-client-version`, and `user-agent` headers
  - **Strips `Origin` and `Referer` headers** before requests to `api.anthropic.com` (Firefox sidepanel origin is `moz-extension://<uuid>`; the API classifies origin-bearing requests as CORS and rejects with 401 "CORS requests are not allowed"; stripping makes it look server-side)

- **MCP bridge WS Origin rewrite**: a second `onBeforeSendHeaders` listener scoped to `wss://bridge.claudeusercontent.com/*` (+ staging) that **rewrites the WebSocket-handshake `Origin`** from `moz-extension://<uuid>` to the Chrome-extension origin `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn` (and strips `Referer`). The bridge can reject an unknown origin (closes with code 1008 → the bundle then clears the access token), so we mimic the genuine Chrome client. Defensive — harmless if the bridge is lenient. The MCP token-mint call hits `api.anthropic.com` and is already covered by the Origin-strip above.

- **permissionStorage prune**: at startup, drops `duration:"once"` grant entries older than 24h from the bundle's `permissionStorage`. Once-grants are keyed to a single toolUseId and normally consumed on retry, but grants recorded against an `about:*` tab get `netloc:""` and can never match (plan approvals use `netloc:""` by design too) — they accumulated forever (observed: 51 dead entries). `always` entries are user choices and are never touched.

- **Dynamic import**: At the very end, loads the minified ES-module service worker via `import('./assets/service-worker.ts-B5az7Lf2.js')`.

### `firefox-oauth-bridge.js`

**Content script** injected into `claude.ai` pages (MAIN world, `document_start`).

**Purpose**: Provides `window.chrome.runtime` API so the OAuth page can call `chrome.runtime.sendMessage("fcoeoabgfenejglbffodgkkbkcdhcgfn", message)`.

**Implementation**:
- Defines `window.chrome.runtime.sendMessage()` that:
  - Normalizes the dual signature: `(msg)`, `(msg, cb)`, `(extId, msg)`, `(extId, msg, cb)`, `(extId, msg, opts, cb)`
  - If target is the Chrome extension ID or undefined, relays via `window.postMessage({_czOAuth: 'req', msgId, message}, '*')` to `firefox-oauth-relay.js`
  - Waits for a `{_czOAuth: 'res', msgId, response}` postMessage and resolves the Promise
  - Falls through to original `window.chrome.runtime.sendMessage()` if present

- Sets `window.chrome.runtime.id = "fcoeoabgfenejglbffodgkkbkcdhcgfn"` (pages check this to detect extension presence)
- Stubs `window.chrome.runtime.connect()` (pages call it but we ignore it)

### `firefox-oauth-relay.js`

**Content script** injected into `claude.ai` pages (isolated world, `document_start`).

**Purpose**: Relay station between MAIN world (`firefox-oauth-bridge.js`) and background context.

**Implementation**:
- Listens for `{_czOAuth: 'req', msgId, message}` postMessages from MAIN world
- Forwards to background via `chrome.runtime.sendMessage({_czOAuthType: 'relay', message}, callback)`
- Posts the response back to MAIN world as `{_czOAuth: 'res', msgId, response}`

**Why two scripts?**: MAIN world (bridge) can't call extension APIs; isolated world (relay) can. The relay acts as the bridge.

### `firefox-input-blocker.js`

**Content script** injected into all pages, runs at `document_start`.

**Purpose**: Block user input while Claude is driving the page (agent automation).

**Implementation**:
- Listens for broadcast messages:
  - `SHOW_AGENT_INDICATORS` / `SHOW_STATIC_INDICATOR` → agent active on this tab → block input
  - `HIDE_AGENT_INDICATORS` / `HIDE_STATIC_INDICATOR` → agent finished → unblock input
  - `__FF_AGENT_ACTIVE` → **CDP heartbeat** (see below)
- **Two blocking sources, OR'd** (`sessionOn || ttlOn`):
  - **session** — the bundle's `SHOW/HIDE_*_INDICATOR` messages (whole session). In Firefox these sometimes never reach the content script, so on their own the page stayed clickable ("запрет не работает").
  - **heartbeat (reliable)** — the CDP shim (`firefox-page-shims.js` `__ffSignalActive`) fires `__FF_AGENT_ACTIVE` at the tab on **every** synthetic mouse/key/text dispatch; the blocker then blocks for a refreshed ~8s TTL. This ties blocking to *actual* automation, independent of the indicator messages.
- Registers capture-phase listeners on a set of input events (`click`, `keydown`, `mousedown`, etc.)
- **Gate**: only blocks if `event.isTrusted === true` (real user input)
  - Synthetic events (dispatched by the debugger CDP shim via `executeScript`) have `isTrusted === false` → allowed through
- **Exceptions**: events whose target is inside `#claude-agent-stop-container`, `#claude-static-indicator-container`, or our injected `#__cz_stop_btn` are always allowed (user can stop the agent / use indicator controls)
- **Injected Stop button (`#__cz_stop_btn`)**: driven ("static") tabs get no native stop button, so the blocker injects one. On click it resolves the session's **main tab via our registry** (`FF_RESOLVE_MAIN_TAB` → `firefox-threads.js`) and sends `STOP_AGENT` with that **numeric** `fromTabId` — bypassing the bundle's own `getMainTabId`, which can miss the mapping and then never abort. Falls back to the `CURRENT_TAB` sentinel if resolution fails.
- **Agent-active DOM flag (`<html data-cz-agent="1">`)**: when blocking flips on/off, the blocker sets/removes `document.documentElement.dataset.czAgent`. This is a **cross-world channel** to the MAIN-world `firefox-dialog-tamer.js` (which can't receive `runtime` messages): ISOLATED and MAIN share the per-frame DOM, so the tamer reads this flag to know when the agent is driving. Set per-frame (the blocker runs in all frames).

**Why capture phase?** The automation uses `document.elementFromPoint(x, y)` to find targets. A real overlay (`pointer-events: auto`) would be returned by `elementFromPoint` and Claude would "click" the overlay instead of the page.

### `firefox-dialog-tamer.js`

**Content script** injected into all pages (**MAIN world**, all frames, `document_start`).

**Purpose**: Stop native JS dialogs (`alert`/`confirm`/`prompt`) and `beforeunload` from
**blocking** agent automation — Firefox has no CDP `Page.handleJavaScriptDialog`, and these
dialogs halt the page's JS thread synchronously, so a `confirm()` in a click handler or a
`beforeunload` on navigation would hang the agent indefinitely.

**Implementation**:
- Native dialogs can't be intercepted from outside the page, so it overrides
  `window.alert` (→ no-op), `confirm` (→ `true`), `prompt` (→ default/`''`) **in the page**,
  matching the bundle's CDP default of accepting dialogs.
- A capture-phase `beforeunload` listener calls `stopImmediatePropagation()` +
  `preventDefault()` so the page's own handler (which would set `returnValue`) never runs.
- **Gated on the agent being active** — only suppresses when `document.documentElement`
  `.dataset.czAgent === '1'` (set by `firefox-input-blocker.js`); when the agent is idle it
  delegates to the originals, so the user's own dialogs behave normally.
- **Caveat**: browser-UI-initiated `beforeunload` (the user closing a tab) still prompts —
  only agent-active dialogs are auto-handled.

### `offscreen.js`

**Purpose**: Audio playback and GIF generation in the Firefox background context (which has full DOM).

**Responsibilities**:
- **SW keepalive**: Sends `SW_KEEPALIVE` message every 20 seconds to the service worker to reset its idle timer (Firefox MV3 background is a real page, not a SW, but this pattern was copied from Chrome's offscreen doc for compatibility)
- **`playAudioWithWebAudioAPI(audioUrl, volume)`**: Fetches audio, decodes via `AudioContext.decodeAudioData()`, creates a `BufferSource`, connects to a gain node, and plays
- **`generateGif(frames, options)`**: Canvas-based GIF encoding (helper functions for drawing click indicators, keystroke overlays, etc.)
- **`revoke Blob URLs**: Exposes URL cleanup for the bundle's blob URL messages

### `gif.js`

Imported (not shown in detail) — contains GIF encoding logic (canvas drawing, frame assembly, blob creation). Loaded in the background context.

### `service-worker-loader.js`

Simple ES-module file that imports the minified bundle:
```javascript
import './assets/service-worker.ts-B5az7Lf2.js';
```

This is loaded dynamically at the end of `firefox-bg-loader.js` when all shims are in place.

### HTML Pages: `sidepanel.html`, `options.html`, `pairing.html`

After `update-from-store.ps1` patches them:
- Inline theme script removed (CSP-blocked, replaced by shim)
- `<script src="firefox-page-shims.js"></script>` injected before the first module script
- `sidepanel.html` only: the bundle's `<script type="module">` is renamed to `<script type="firefox-deferred-module">` (so the shim controls when it loads, after `?tabId=N` injection)

## Chrome → Firefox API Translation Table

| Chrome API | Firefox Replacement | File |
|---|---|---|
| `chrome.sidePanel.setOptions({tabId, path})` | `browser.sidebarAction.setPanel({panel: path})` (global, not per-tab) | `firefox-page-shims.js` |
| `chrome.sidePanel.open()` | `browser.sidebarAction.open()` | `firefox-page-shims.js` |
| `chrome.sidePanel.close()` | `browser.sidebarAction.close()` | `firefox-page-shims.js` |
| `chrome.tabs.group({tabIds, groupId})` | Hybrid: native group for groupable web tabs, else emulated negative-id group in the `storage.session` registry (`__ffGroupMeta`/`__ffTabGroup`/`__ffGroupSeq`) | `firefox-page-shims.js` |
| `chrome.tabs.ungroup(tabIds)` | Remove from registry; also native-ungroup tabs in `native:true` groups | `firefox-page-shims.js` |
| `chrome.tabs.query({...})` | Overlaid: `groupId` from registry when Claude-managed, else native; `groupId` filter applied in-shim | `firefox-page-shims.js` |
| `chrome.tabs.get(tabId)` | Overlaid: registry `groupId` first, else native | `firefox-page-shims.js` |
| `tab.pendingUrl` (Chrome-only) | `tabs.create/update` wraps record the target URL; `tabs.get/query` overlay reports it as `url` while the native url is still `about:*` (kills the empty-host permission loop) | `firefox-page-shims.js` |
| `chrome.tabGroups.*` | FF 139+: overlay native (`get/query/update/move`) with registry; FF ≤138: full stub via registry | `firefox-page-shims.js` |
| `chrome.tabs.create({url:"chrome://newtab"})` / `chrome.windows.create(...)` | Strip the `chrome://newtab` URL (Firefox rejects it as illegal) → Firefox opens its native new tab | `firefox-page-shims.js` |
| `chrome.debugger.attach/detach/sendCommand` | `browser.scripting.executeScript()` for mutations; `tabs.captureTab(tabId)` (fallback `captureVisibleTab`) for screenshots | `firefox-page-shims.js` |
| `chrome.offscreen.createDocument()` | No-op (Firefox background is a real DOM page) | `firefox-page-shims.js` |
| `chrome.offscreen.hasDocument()` | Returns `true` | `firefox-page-shims.js` |
| `chrome.identity.launchWebAuthFlow()` | `browser.identity.launchWebAuthFlow()` (primary) or `manualTabAuth()` with webRequest interception (fallback) | `firefox-bg-loader.js` |
| `chrome.declarativeNetRequest` enums | Defined as string constants; `updateSessionRules()` wrapped to ignore rejections | `firefox-page-shims.js` |
| `chrome.webRequest.onBeforeSendHeaders` | Native API (fully supported in Firefox MV3); used to inject headers and strip Origin/Referer | `firefox-bg-loader.js` |
| `chrome.runtime.sendMessage("extension-id", ...)` from web page | `window.postMessage` relay via `firefox-oauth-bridge.js` → `firefox-oauth-relay.js` | `firefox-oauth-bridge.js`, `firefox-oauth-relay.js` |

## Build / Update Workflow

### `scripts/update-from-store.ps1`

**Purpose**: Pull the latest Chrome extension from the Chrome Web Store and patch it for Firefox.

**Workflow**:

1. **Check current version**: Read `chrome-version.txt` (e.g., "1.0.72")
2. **Query Chrome Web Store**: `POST` to `clients2.google.com/service/update2/crx?...` to fetch update manifest XML and parse the latest version
3. **Compare**: If already up to date, exit
4. **Download CRX**: Download the CRX file (Chrome's packaged extension format)
5. **Extract**: Strip CRX3 header (find PK/ZIP signature `0x50 0x4B 0x03 0x04`) and unzip
6. **Copy files**: Recursively copy all files from the extracted ZIP to the project, **skipping protected files**:
   - Protected: `manifest.json`, `firefox-*.js`, `browser-polyfill.min.js`, `chrome-version.txt`, `refactor-plan`, `scripts/`, `_metadata/`
   - Everything else (`assets/`, HTML pages, etc.) is overwritten
7. **Re-patch HTML pages** (`sidepanel.html`, `options.html`, `pairing.html`):
   - Remove inline theme script (blocked by CSP)
   - Inject `<script src="firefox-page-shims.js"></script>` before the first module script
   - `sidepanel.html` only: rename bundle's `<script type="module">` to `<script type="firefox-deferred-module">`
8. **Update version file**: Write the new version to `chrome-version.txt`
9. **Cleanup**: Delete temporary CRX/ZIP/extracted files

**Usage**:
```powershell
# Check if update available (no download)
.\scripts\update-from-store.ps1 -CheckOnly

# Download and apply update
.\scripts\update-from-store.ps1
```

### Manual Re-shimming After Update

If the HTML patches aren't applied (or need manual refresh):
1. Verify the `<script src="firefox-page-shims.js"></script>` tag is present before the bundle module script in `sidepanel.html`, `options.html`, `pairing.html`
2. For `sidepanel.html`, ensure the bundle's script has `type="firefox-deferred-module"` (not `type="module"`)
3. Verify no inline `<script>` blocks remain (CSP forbids them) — theme detection is now in the shim

## Token Savers (read_page-first + screenshot downscale)

Two Layer-2 knobs in `firefox-page-shims.js` to cut the agent's token spend. Both live
in the shim, so they survive `update-from-store.ps1`. **Background**: the upstream agent is
a vision-first computer-use loop and screenshots a lot; each screenshot is a base64 image
costing roughly `width*height/750` tokens — the bulk of a session. But the bundle *already*
ships cheap **text** observers, so the model rarely *needs* a screenshot:
- `read_page` → `assets/accessibility-tree.js-*.js` (`__generateAccessibilityTree`): a
  Playwright-style **accessibility tree** as text, with `ref_id` markers for clicking,
  `interactive`/`all` filter, `depth`, viewport-clipping, password/`autocomplete` redaction.
- `get_page_text` → page text. `find` → element finder (small-model helper).

**1. Text-first steering (`__czPreferText`, default ON).** The `window.fetch` wrapper
(`czSteerBody`) appends a short **system block** to each *agent* `/v1/messages` request
telling the model to observe with `read_page`/`get_page_text`/`find` and screenshot only
when it must see pixels (visual layout, canvas/video/images, or when text was insufficient).
- Only the real agent request is touched — gated on the body carrying the browser tools
  (`read_page`/`computer`/…), so the cosmetic title/status/find-helper `/messages` calls are
  left alone. Idempotent via a `cz-token-saver` marker.
- Appended **after** the bundle's own system blocks, so the cached prompt prefix still hits;
  the extra block (~90 tokens, uncached) is negligible against one image.
- Only the string-body-in-`init` path (the Anthropic SDK's path) is mutated; the
  Request-object path is left unchanged (not used by the SDK).
- Toggle: `czPreferText(false)` to disable, `czPreferText(true)` to re-enable.

**2. Screenshot downscale (`__czShotScale`, default 1 = OFF).** Image tokens scale with
**pixel count**, not file size — so lowering JPEG quality saves nothing; only fewer pixels
do. `Page.captureScreenshot` captures via `tabs.captureTab(tabId, {scale:s})`; at `s<1` the
image (and its token cost) shrinks ~`s²`. The model then picks click coords in that smaller
space, so the scale actually used is recorded per tab (`__czShotScaleByTab`) and
`Input.dispatchMouseEvent` **divides incoming coords by it** to map back to CSS pixels. The
`captureVisibleTab` fallback has no `scale` param → it records `1` (clicks unscaled).
- Coordinate remapping is the exact class of bug this port has fought (the "divide by DPR"
  saga), so this is **opt-in**; the default `1` changes nothing. Wheel/scroll coords are not
  remapped — a caveat at `s<1`.
- Toggle: `czShotScale(0.5)` (clamped 0.3–1), `czShotScale(1)` to turn off.

## Debug Mode (Chat Mirror)

An opt-in dev aid in `firefox-page-shims.js` that mirrors everything flowing through the chat to the console — to complement the bundle's own `[Computer Tool]` logs (which only cover tool *execution*).

**What it logs** (prefix `[claude-zen][chat]`, color-coded):
- 👤 outgoing **user turns** and ✅ **tool results** — parsed from the request body sent to `api.anthropic.com/.../messages`
- 💬 assistant **text**, 💭 **thinking** blocks, and 🔧 **tool_use** calls **with their JSON arguments** — parsed from the streaming SSE response
- ▶/■ message start/stop, stop_reason, and token usage

**How it works**: it hooks the existing `window.fetch` wrapper (which already injects `anthropic-client-*` headers). When enabled, it logs the request body, then reads the response via `resp.clone()` and parses the SSE events (`content_block_start/delta/stop`, etc.). It is **non-destructive** — the bundle receives the untouched original stream; the clone is consumed independently.

**Toggle** (from the sidepanel console — right-click the sidebar → Inspect, or `about:debugging` → This Firefox → Inspect):
```js
czDebug()        // enable
czDebug(false)   // disable
```
State persists in `storage.local.__czDebugMirror` and propagates across contexts via `storage.onChanged` (toggling in the background console also enables it in the sidepanel). Long text/args/results are truncated to ~4000 chars; images are shown as `[image]`.

### Persistent session log (save to computer for later debugging)

The chat mirror only prints to the live console. For **post-mortem** debugging of
"Claude thinks it clicked but nothing happened" / stop-not-working runs, there is a
ring-buffer log persisted to `storage.local.__czSessionLog` (capped ~4000 entries,
merged across the background + sidepanel contexts), defined in `firefox-page-shims.js`:

- **`self.czLog(category, text)`** — append an entry. Wired up so that **every** `[cdp]`
  click/key/insertText result (including `miss` / `disabled` / `domMutations` /
  `reachedDoc` / `defaultPrevented` and `CLICK-FAILED` lines) is recorded automatically,
  and — **when `czDebug()` is on** — the assistant's thinking, tool calls, and tool
  results too (the chat-mirror `log()` tees into it).
- **`czDumpLog()`** — flush + download the whole log as a timestamped `.log` file via the
  `downloads` API (this is the "save sessions on the computer" hook). Run it from the
  sidepanel or background console after reproducing a bug.
- **`czClearLog()`** — wipe the buffer.

The `[cdp]` action entries are kept **always** (cheap, decisive for click debugging);
thinking/chat content is only persisted while the mirror is enabled (privacy/size).

### Previous chats (conversation history that survives close/restart)

The upstream bundle keeps the agent conversation **only in volatile React state**
(`messages:[]`, `sessionId:null`) — it makes **zero** `storage.set` calls and has no
server-side resume for the extension agent, so closing the sidebar (or restarting)
destroys the chat. To give "access to previous chats", a **capture + persistence layer**
was added (layers 1–2; "continue a past chat" is a separate, pending decision):

- **Capture (`firefox-page-shims.js`, always-on)**: the existing `window.fetch` wrapper
  tees `/v1/messages` calls. Each **request body carries the full `messages` array**, so a
  sanitized snapshot (base64 images dropped, blocks truncated) is persisted to
  `storage.local.__czChats` keyed by a `chatId`. The chatId **rotates** when the first user
  message changes (a "new chat") — tracked via `storage.session.__czChatCur`
  (`tabId → chatId`). The signature **strips `<system-reminder>` blocks first**: the bundle
  re-injects a live `availableTabs` reminder into the first user message on every request,
  and tab titles inside it can change between turns (e.g. a quiz counting down
  "Time Left: 00:55:31" in its title) — comparing raw text rotated the chatId every turn
  and saved one conversation as ~30 growing duplicate snapshots. The `find` tool's internal
  small-model helper calls ("You are helping find elements…") are filtered out via
  `AUX_RE` alongside the status/title generators. `czCaptureResponse` also appends the
  streamed assistant reply (the one part the next request won't yet contain). Capture only
  runs in the sidepanel (it needs the `?tabId=N` to attribute the chat).
- **Recent list + read-only viewer (`firefox-threads.js`)**: the switcher menu now has a
  **"Recent chats"** section (read from `__czChats`, newest first) that is shown **even
  with no open threads** (the post-restart case). A row opens a full-screen **read-only
  transcript viewer** (rendered via `self.czRenderChatMd`); 🗑 deletes a saved chat.
- **Console helpers**: `czChats()` (list), `czChatExport(id)` (download `.md`),
  `czChatDelete(id)`.
- **Continue a past chat (DONE)**: re-seeds a saved transcript into the **live** bundle. The
  upstream sidepanel reads `storage.local.test_data_messages` on mount (~100ms) and hydrates
  it into its React/Zustand conversation store — a built-in, non-dev-gated seam. The
  **"▶ Continue"** button (Recent rows + the viewer bar, `firefox-threads.js`) sends
  `FF_CONTINUE_CHAT {chatId}`; the background converts `__czChats[chatId]` →
  `self.czChatToStoreMessages(chat)` and writes that key, then the sidepanel
  `location.replace(?tabId=…)` so the bundle re-runs and hydrates. **Conversion flattens
  non-text blocks to text** (capture dropped `tool_use.id`/`tool_result.tool_use_id`/thinking
  signatures/image sources — seeding them verbatim 400s the next request) and merges
  consecutive same-role turns (the Messages API requires strict alternation); `lastReply` is
  appended as the final assistant turn. **Target tab**: if the chat's original tab still maps
  to a live thread the background returns its `mainTabId` (agent keeps acting on the same
  tabs); else the current sidebar tab (post-restart → fresh group). The seed key is
  **one-shot** — `firefox-page-shims.js` clears `test_data_messages` ~1.5s after mount so a
  manual reload doesn't re-hydrate.

## Known Constraints / Gotchas

### Host Permissions (Optional in Firefox MV3)

Firefox MV3 treats `host_permissions` as optional. They must be explicitly granted by the user in `about:addons` → Claude → Permissions → "Access your data for all websites".

**Without them**: webRequest, DNR, and content-script injection silently no-op, manifesting as:
- 401 errors from `api.anthropic.com` (missing auth headers)
- Tabs without `.url` properties (content scripts don't inject into frames)
- Sidebar doesn't open or appears blank

**Diagnosis**: Open the Firefox console (in the background or sidepanel) and check for:
```
[claude-zen] host permission <all_urls> granted: false
```

### Synthetic Input Events are Untrusted

The debugger CDP shim's `scripting.executeScript()` creates synthetic `MouseEvent`, `KeyboardEvent`, etc. with `isTrusted === false`. Pages or elements that gate on `event.isTrusted === true` will ignore these.

Example: contentEditable fields may not respond to synthetic keystrokes. The shim works around this by calling `document.execCommand('insertText')` or direct value setter for text inputs.

### Background Context Detection (Firefox background is a DOM page!)

Because Firefox MV3's background is a **real DOM page** (not a service worker), `document` and `window` both exist there — so the naive `isBackground = (typeof document === 'undefined')` test (correct for Chrome's SW) is **always false on Firefox**. Any background-only listener gated on that test silently never installs. This bit the tab-groups visual-promotion listener for several iterations. The tab-groups IIFE now detects the FF background via `location.pathname` ending in `_generated_background_page.html` (with a `chrome.extension.getBackgroundPage() === window` fallback), keeping the `typeof document === 'undefined'` branch for Chrome's SW. **When adding any new background-only logic, reuse this detection — do not reintroduce the `typeof document` test.** (Note: a second, latent copy of the bad test still exists in the OAuth block but is dead code, since OAuth is driven from the sidepanel.)

### Service Worker Sleep (Background Throttling)

Firefox MV3 background scripts are real pages (not service workers) and don't sleep, but the original code may have assumed Chrome's 30-second idle kill. State is kept in `storage.session` (shared across background + sidepanel, survives SW unload, cleared on browser restart) rather than global variables.

### Tab Groups: hybrid native + emulated (privileged tabs can't be natively grouped)

Native Firefox `chrome.tabs.group` (FF 139+) **rejects privileged/extension pages** (`moz-extension://`, `about:*`, `chrome://`). Since Claude's main tab is often a new-tab-page override and scratch tabs open at `about:newtab`, a real group can't always be made. The shim therefore runs a **hybrid** (see the `chrome.tabGroups` entry above): a real visible group for groupable web tabs, a negative-id **emulated** group otherwise, with the `storage.session` registry as the unified membership truth and `tabs.get/query` + `tabGroups.*` overlaid so the access boundary always resolves. A given session is "real" or "emulated" depending on the main tab's URL; emulated sessions have no visual group but the agent can still control its tabs. Mode is chosen at runtime by `nativeGroups` in `firefox-page-shims.js` — use `czDebug()` to watch the chat if grouping misbehaves.

## Conventions

### Coding Style

- **All shim files are classic scripts** (not ES modules) — they load synchronously before the bundle
- **Console logs** are prefixed with `[claude-zen]` (or specific contexts like `[claude-zen sidepanel]`, `[Offscreen]`, `[PROBE]`)
- **Never edit files in `assets/`** — they are regenerated from upstream on every `update-from-store.ps1` run
- **Error handling**: most shims wrap try-catch blocks to prevent crashes if an API is unavailable

### Storage Keys

- `__ffGroupMeta`: object mapping groupId → `{id, title, color, collapsed, windowId}`
- `__ffTabGroup`: object mapping tabId → groupId
- `__ffGroupSeq`: number (auto-increment sequence)
- `codeVerifier`: PKCE code verifier for OAuth
- `accessToken`, `refreshToken`, `tokenExpiry`, `oauthState`: OAuth tokens
- `accountUuid`: user's account UUID
- `lastAuthFailureReason`: diagnostic
- `__czDebugMirror`: boolean — enables the chat→console debug mirror (see Debug Mode)
- `__czPreferText`: boolean (storage.local, default **true**) — text-first steering (see Token Savers); toggle `czPreferText(true/false)`
- `__czShotScale`: number 0.3–1 (storage.local, default **1**=off) — screenshot downscale factor (see Token Savers); toggle `czShotScale(0.5)`
- `__czSessionLog`: array — persistent ring-buffer debug log (see Debug Mode → Persistent session log); dump with `czDumpLog()`
- `__czPreferEmulatedGroups`: boolean — manual override for grouping mode (`true`=force registry-only/emulated, `false`=force native, unset=auto-detect Zen). Set via `czEmulateGroups(true/false)`. See `docs/ZEN_TABS_AND_FOLDERS.md`
- `__czChats`: object (storage.local) — saved chat transcripts keyed by chatId (see Previous chats); the bundle never persists conversations, so the capture layer does
- `__czChatCur`: object (storage.session) — `tabId → current chatId` map for the capture rotation
- `test_data_messages`: array (storage.local) — **bundle's own key**, repurposed by "Continue past chat": the upstream sidepanel hydrates the live conversation from it on mount. We write it (converted transcript) then clear it one-shot ~1.5s after mount
- `bridgeDeviceId` / `bridgeDisplayName`: **bundle's own keys** — the MCP bridge's per-install device id + optional display name sent on the WS `connect` frame
- `data-cz-agent` (not storage — a `<html>` dataset attribute): per-frame "agent is driving" flag set by `firefox-input-blocker.js`, read by the MAIN-world `firefox-dialog-tamer.js`

### Extension IDs

- **Chrome original**: `fcoeoabgfenejglbffodgkkbkcdhcgfn` (used as redirect URI, hard-coded in OAuth flows)
- **Firefox**: `claude-zen@firefox` (internal; OAuth relay still uses the Chrome ID for backend compatibility)

## Loading the Extension

### Firefox (about:debugging)

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from the project root
4. The extension loads and the Claude sidebar icon appears in the toolbar

### Chrome (for testing, if keeping dual compatibility)

If the manifest and shims are still compatible with Chrome MV3:
1. Open `chrome://extensions`
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the project root
5. The extension loads with the Chrome bundle logic (shims gracefully no-op when Chrome APIs are native)

## Related Files

- **`.gitignore`**: Excludes `*.har` (captured browser sessions with cookies/tokens) and OS junk
- **`git-hash.txt`**: Commit SHA of the original Chrome extension source (for provenance)
- **`refactor-plan` (Russian)**: Original planning document describing the Chrome→Firefox porting strategy

## Thread Switcher (sidebar) + Jump-to-Thread

Chrome's side panel is per-tab, so switching tab groups swaps the sidebar to that
session's conversation automatically. Firefox's sidebar is a **single global instance**
pinned to one `?tabId=N` (resolved once by the `firefox-page-shims.js` sidepanel loader),
so with multiple Claude sessions open there is no native way to switch which conversation
the sidebar shows. A **"thread" = one Claude group** in the registry
(`__ffGroupMeta`/`__ffTabGroup`), addressed by its **main tab**.

**`firefox-threads.js`** (new; loaded in `background.scripts` *and* via a `<script>` tag in
`sidepanel.html`) implements:
- **Thread model** — reads the group registry directly from `storage.session` and exposes
  `self.__ffGetThreads()` / `self.__ffThreadForTab(tabId)`, returning
  `{groupId, mainTabId, windowId, native, tabIds, memberCount, title, host, url}`. The
  `mainTabId` is persisted on group meta by `firefox-page-shims.js` at group-creation
  time (`emulatedGroup`, the native branch of `groupFn`, and `__ffEnsureMainGroup`).
- **Sidebar switcher (sidepanel only)** — a floating dropdown "pill" at the top of the
  sidebar (shown only when ≥2 threads). Selecting a thread **repoints the sidebar only**:
  it sets `?tabId=<mainTabId>` and `location.replace()`s, re-running the deferred-module
  loader for that thread (browser tabs are left untouched). Each row has a **⤴ "jump to
  tab"** button that focuses that thread's browser tab. Refreshes on `storage.onChanged`.
- **"+ New thread"** (`newThread()`) — branches on whether the sidebar is already on a live
  Claude thread (authoritative `FF_THREAD_MEMBERSHIP`, falling back to the in-memory
  `currentThread()`):
  - **On a thread** → a *fresh chat in the same thread*: it clears the Continue seed
    (`test_data_messages`) and `location.reload()`s the sidebar on the **same** `?tabId`.
    The bundle keeps the conversation only in volatile state, so a reload starts an empty
    chat **without opening a new browser tab or a second tab group** (the existing group is
    reused so the agent can still act). This replaced the old always-spawn behavior, which
    opened a `duckduckgo.com` tab + made a new group on every click.
  - **Not on a thread** (post-restart, or sidebar on a non-Claude tab) → `FF_NEW_THREAD`
    adopts the current page (or opens a fresh tab if it's already a thread / privileged),
    seeds it into a group, and the sidebar repoints to it.
- **Background handlers** (`runtime.onMessage`, `FF_*`): `FF_THREAD_MEMBERSHIP` (is this
  tab in a Claude group?), `FF_RESOLVE_MAIN_TAB` (registry → the session's main tab, used
  by the input-blocker's Stop button), `FF_FOCUS_TAB` (`tabs.update`+`windows.update`), and
  `FF_JUMP_TO_THREAD` (resolve the tab's thread → broadcast `FF_SWITCH_THREAD` so the open
  sidebar repoints; uses `sidebarAction.isOpen()` to tell the page whether it landed).
  `FF_FOCUS_TAB` / `FF_NEW_THREAD` act on a caller-supplied `tabId`, so they are **gated to
  extension-page senders** (sidepanel) — a content script / web page can't drive the
  user's tabs through them.
- **Main-tab close / Zen window-move: resurrect-or-stop** (background `tabs.onRemoved` +
  `onUpdated`): Chrome's per-tab side panel dies with its tab; Firefox's global sidebar
  stays pinned to the dead `?tabId`, the bundle keeps running, every tool errors
  ("Invalid tab ID: N", empty `availableTabs`), and the model spins retrying — each retry
  re-sends the whole conversation (observed: a session ended on 9 back-to-back
  `tabs_context` calls, pure token burn). Complication: **Zen recreates a tab with a NEW
  id when it's dragged to another window** (stock Firefox preserves the id), so
  `onRemoved` also fires for tabs the user merely moved. The handler stashes the removed
  registry tab's `{url, gid, wasMain}` for a 2.5s grace window (registry read from a
  **synchronous mirror** — page-shims' own `onRemoved` prunes `memb` concurrently): a tab
  committing that exact URL inside the window is the same logical tab → **rebind** the
  registry (`memb[newId]`, `meta.mainTabId`); driven tabs stay controllable seamlessly. A
  moved/closed **main** tab still kills the live conversation (the bundle's session is
  hard-bound to the old `?tabId`), so the handler sends `STOP_AGENT {fromTabId: oldId}`
  (the injected Stop button's message) to abort the zombie run, and on a move also
  broadcasts `FF_SWITCH_THREAD` so the sidebar repoints to the resurrected thread (fresh
  chat; the old one is in Recent chats).
- **Foreign-tab banner** (`broadcastForeign`/`isForeignTab`, on `tabs.onActivated` /
  `windows.onFocusChanged`): Firefox's sidebar is one **global** instance shown on every
  tab/window, and the platform gives **no way to auto-close it** — `sidebarAction.close()`
  *and* `open()` "may only be called from inside the handler for a user action" (MDN), so
  calling `close()` from a tab-switch event always throws. (An earlier
  `closeSidebarIfForeign` tried exactly that and silently failed every switch.) Instead the
  chat is left **fully usable everywhere** and the background just **broadcasts**
  `FF_ACTIVE_TAB {foreign}` whenever the active tab is neither the sidebar's **pinned tab**
  (`storage.session.__ffSidebarTab`) nor in the **same thread/group** as it. The sidepanel
  shows a slim non-blocking **banner** (`#cz-foreign-banner`: "Вы на другой вкладке… Claude
  работает в своей вкладке", with a ⤴ jump-to-Claude-tab button) — the user can keep
  replying and the agent keeps acting on its **own group's tabs** only, so other tabs are
  undisturbed. To actually *hide* the sidebar the user presses Ctrl+E (Firefox's native
  toggle). Auto-open on install/reload is disabled via `sidebar_action.open_at_install:false`.
- **Content-script registration** — registers `firefox-thread-jump.js` dynamically via
  `scripting.registerContentScripts` (id `cz-thread-jump`), so no manifest
  `content_scripts` edit is needed.

**`firefox-thread-jump.js`** (new content script, `<all_urls>`, top frame, `document_idle`):
on Claude-driven pages it shows a floating **"◆ Open in Claude"** button that repoints the
open sidebar to that page's thread. **Gesture limitation:** Firefox can't open a *closed*
sidebar without a live user gesture (lost across the message hop, and content scripts can't
call `sidebarAction`), so when the sidebar is closed the button only toasts a hint
("Open the Claude sidebar (Ctrl+E)…"). Membership lives in `storage.session` (unreadable
from content scripts), so the button asks the background via `FF_THREAD_MEMBERSHIP`.

Both new files are classic scripts, `[claude-zen][threads]`-prefixed, added to the
`update-from-store.ps1` **protected** list, and the sidepanel `<script>` injection is
replicated there so updates keep loading `firefox-threads.js`.

## Future Enhancements

- **Visual tab groups**: ✅ Done — real native groups appear on **FF 138+** (gated on `canGroup`/`tabs.group`), with the orange "Claude" title/color added on **FF 139+** (gated on `nativeGroups`/the `tabGroups` namespace). The registry emulation remains only as a true fallback for privileged-only sessions or FF ≤137.
- **Cleaner CDP emulation**: If Firefox adds a debugger API, remove the synthetic event layer
- **DNR reliability**: Monitor Firefox's `modifyHeaders` support as it matures; if it becomes reliable, remove the webRequest fallback
