# Firefox port — architecture & status

This repo is the bundled Chrome extension (`assets/*` — minified, do not edit)
wrapped in a Firefox MV3 compatibility layer (the root `firefox-*.js` files +
`manifest.json`). The glue shims Chrome-only APIs so the unmodified Chrome bundle
runs on Firefox 128+.

## Glue files

| File | Context | Purpose |
|---|---|---|
| `firefox-page-shims.js` | background + every extension page (sidepanel/options/pairing) | The main shim layer. Loaded **first** in `background.scripts` and injected before the bundle on each HTML page. Must run before the bundle, which touches Chrome-only APIs at module-eval time. |
| `firefox-bg-loader.js` | background | webRequest header injection + Origin strip; OAuth/identity bridge; then `import()`s the SW bundle. |
| `firefox-oauth-bridge.js` / `-relay.js` | claude.ai page (MAIN / ISOLATED) | OAuth flow relay (chrome.identity has no Firefox equivalent). |
| `firefox-input-blocker.js` | content (ISOLATED, all frames) | Blocks user input while the agent drives a tab. Also shims `chrome.dom` in the content world. |
| `firefox-console-hook.js` / `-relay.js` | content (MAIN / ISOLATED) | Captures page console/errors → CDP `Runtime.*` events. Gated; off unless the agent enables it. |
| `firefox-threads.js` | background + sidepanel | Thread switcher: dropdown + jump-to-tab to repoint the single global sidebar between Claude sessions without reloading. |
| `firefox-thread-jump.js` | content (`<all_urls>`, top frame) | "◆ Open in Claude" button that repoints the open sidebar to that page's thread. |
| `offscreen.js` + `gif.js` | background | Loaded into the background page (which has a DOM in FF) instead of a Chrome offscreen document. |

## What was ported (chronological, all on `main`)

1. **CORS 401 on `/v1/messages`** — FF attaches an `Origin` header to extension-page
   fetches; Anthropic rejects OAuth requests bearing `Origin` as cross-site CORS.
   `firefox-bg-loader.js` strips `Origin`/`Referer` on `api.anthropic.com` via
   `webRequest.onBeforeSendHeaders`. (Chrome SW sends no Origin, so it never hit this.)
2. **Sidebar persistence / visibility** — Chrome's sidepanel is per-tab; FF has one
   global sidebar. `sidePanel.setOptions` → `sidebarAction.setPanel`. Per-tab panel
   swap: chat (`sidepanel.html?tabId=<chatTab>`) on Claude's working-group tabs, the
   idle placeholder elsewhere, driven by `tabs.onActivated`. Switching among working
   tabs keeps one URL (no reload); crossing the group boundary reloads (history persists,
   agent keeps running in background). FF can't reopen the sidebar programmatically
   (`open()` needs a user gesture), so we never close it — we swap content.
3. **`chrome.debugger` CDP commands** — FF has no debugger API. Translated to
   `scripting.executeScript` (Input.* → synthetic DOM events in MAIN world;
   Runtime.evaluate) + `tabs.captureVisibleTab` (Page.captureScreenshot). attach/
   detach/getTargets fire their callbacks so commands don't stall.
4. **`chrome.debugger` CDP events** — `onEvent` is a real fan-out. The background
   derives events from native APIs: `webRequest` → `Network.requestWillBeSent/
   responseReceived/loadingFailed` (gated by per-tab enable flags); `webNavigation.
   onCommitted` → `Page.frameNavigated`; console hook → `Runtime.consoleAPICalled/
   exceptionThrown`. Delivered to background listeners locally (`window.__ffEmitCdp`)
   and sidepanel listeners via a `__FF_CDP_EVENT` broadcast.
5. **Tab groups** — FF 128 has no `tabGroups`/`tabs.group`. Emulated with a
   `storage.session` registry (tabId→groupId + metadata): `tabs.group/ungroup`,
   `tabGroups.get/query/update/move`, `tab.groupId` annotation on `tabs.query/get`,
   `query({groupId})`. Logical only — no visual group in the FF tab strip.
6. **Input lock** — capture-phase listeners swallow `isTrusted` user events while the
   agent works; synthetic agent events (`isTrusted=false`) pass; Stop-Claude stays clickable.
7. **Offscreen document** — replaced by loading `offscreen.js`+`gif.js` into the FF
   background page; `offscreen.hasDocument→true`; a `runtime.sendMessage` wrapper
   dispatches background-origin offscreen messages to the handlers. Restores
   notification sounds + GIF `/share` export.
8. **`chrome.dom.openOrClosedShadowRoot`** — shimmed to the open shadow root.
9. **`chrome.action.getUserSettings`** — stubbed (`{isOnToolbar:true}`).

## Known limitations / not ported

- **Native messaging** (`chrome.runtime.connectNative` to
  `com.anthropic.claude_browser_extension`) — the MCP desktop/bridge integration needs
  an OS-level native host registered for Firefox. Code path degrades gracefully when
  the host is absent. Not a code-only port.
- **`Page.javascriptDialogOpening` (beforeunload)** — FF can't answer the native
  beforeunload dialog programmatically. Navigating away during automation may show a
  blocking prompt in rare cases.
- **Synthetic events are untrusted** (`isTrusted=false`) — elements gated on trusted
  input may ignore the agent's clicks/keys.
- **`tabs.captureVisibleTab`** captures only the active/visible tab, not an arbitrary
  background target (CDP could capture any).
- **Closed shadow roots** are inaccessible to FF extensions (open roots work).

## Notes

- `browser-polyfill.min.js` is present but NOT loaded; FF's native `chrome.*` alias
  returns promises for the APIs used, so the bundle's `await chrome.*` works. Alias
  APIs (`alarms`, `notifications`, `downloads`, `windows`, `commands`, `storage`,
  `scripting`, `webNavigation`) work natively — no shims, and none should be added
  speculatively (risk of regressing working behavior).
- `firefox-page-shims.js` MUST stay first in `background.scripts`.
- Validate edits with `node --check`. The `.har` session capture is gitignored.
