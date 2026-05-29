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
  - `Input.dispatchMouseEvent` → synthetic `MouseEvent` in page MAIN world
  - `Input.dispatchKeyEvent` → synthetic `KeyboardEvent` (with special handling for Backspace/Delete on contentEditable)
  - `Input.insertText` → `insertText` command or direct value setter with change/input events
  - `Page.captureScreenshot` → `browser.tabs.captureVisibleTab()`
  - `Runtime.evaluate` → `executeScript(...eval(expr))`
  - `*.enable/disable`, `attach/detach/getTargets` → no-op
  
  **Limitation**: Synthetic events are untrusted (`isTrusted === false`). Elements gating on trusted input may not respond.

- **`chrome.offscreen`**: Reports `hasDocument: true` (Firefox background is a real DOM page, unlike Chrome's service worker). Bundle's offscreen messages are dispatched in-process; sidepanel offscreen requests route to background via `runtime.sendMessage()`.

- **`chrome.declarativeNetRequest` enums**: Firefox doesn't export `RuleActionType`, `HeaderOperation`, `ResourceType` enum objects. Defines them as string constants so the bundle's MODIFY_HEADERS rule can build without throwing. Wraps `updateSessionRules()` to silently ignore rejections (Firefox DNR modifyHeaders may not apply, but reliable fallbacks exist elsewhere).

- **`chrome.identity` (OAuth)**: Two paths:
  - Background context: tries `browser.identity.launchWebAuthFlow()` first, falls back to `manualTabAuth()` (webRequest redirect interception)
  - Page context (sidepanel): routes to background via `FF_IDENTITY_LAUNCH` message

- **`chrome.tabs.query` (sidebar workaround)**: In Firefox sidebar context, the native query `{active: true, currentWindow: true}` returns `[]` (sidebar window has no tabs). Fallback: query without window filter, pick the active tab in the most-recently-focused normal browser window.

- **Sidepanel deferred-module loader**: On `sidepanel.html`, the bundle's `<script type="module">` is renamed to `type="firefox-deferred-module"` (unknown type, ignored by browser). The shim resolves the active tab, injects `?tabId=N` into the URL via `history.replaceState()`, then creates a real `<script type="module">` with the same src. The bundle then runs with the `tabId` parameter, and the active-tab state is populated (otherwise throws "No active tab").

- **Fetch header injection**: Adds `anthropic-client-platform` and `anthropic-client-version` headers to requests to `api.anthropic.com` (redundant with webRequest injection, but ensures page-context requests are marked correctly). Also detects and logs 401/403 response bodies.

- **CDN script blocking**: Intercepts `Element.prototype.appendChild/insertBefore` to block Segment CDN scripts blocked by extension CSP.

- **Datadog SDK warnings**: Suppresses known Datadog double-bundle warnings from console.

- **Theme detection**: Replaces inline theme script (blocked by CSP) with `matchMedia('prefers-color-scheme')` listener.

### `firefox-bg-loader.js`

**Purpose**: Background-context specific logic: OAuth flows, webRequest handlers, DNR setup, and entry point for dynamic import of the service worker bundle.

**Key handlers**:

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
  - `SHOW_AGENT_INDICATORS` → agent started → block input
  - `HIDE_AGENT_INDICATORS` → agent finished → unblock input
- Registers capture-phase listeners on a set of input events (`click`, `keydown`, `mousedown`, etc.)
- **Gate**: only blocks if `event.isTrusted === true` (real user input)
  - Synthetic events (dispatched by the debugger CDP shim via `executeScript`) have `isTrusted === false` → allowed through
- **Exceptions**: events targeting `#claude-agent-stop-container` are always allowed (user can stop the agent)

**Why capture phase?** The automation uses `document.elementFromPoint(x, y)` to find targets. A real overlay (`pointer-events: auto`) would be returned by `elementFromPoint` and Claude would "click" the overlay instead of the page.

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
| `chrome.tabGroups.*` | FF 139+: overlay native (`get/query/update/move`) with registry; FF ≤138: full stub via registry | `firefox-page-shims.js` |
| `chrome.tabs.create({url:"chrome://newtab"})` / `chrome.windows.create(...)` | Strip the `chrome://newtab` URL (Firefox rejects it as illegal) → Firefox opens its native new tab | `firefox-page-shims.js` |
| `chrome.debugger.attach/detach/sendCommand` | `browser.scripting.executeScript()` for mutations; `tabs.captureVisibleTab()` for screenshots | `firefox-page-shims.js` |
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
- **Background handlers** (`runtime.onMessage`, `FF_*`): `FF_THREAD_MEMBERSHIP` (is this
  tab in a Claude group?), `FF_FOCUS_TAB` (`tabs.update`+`windows.update`), and
  `FF_JUMP_TO_THREAD` (resolve the tab's thread → broadcast `FF_SWITCH_THREAD` so the open
  sidebar repoints; uses `sidebarAction.isOpen()` to tell the page whether it landed).
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
