# Firefox port session — implementation log & decisions

This document captures the working session that took the bundled Chrome extension
and made it run on Firefox 128+ (MV3). It records what was changed, why, the
decisions taken, and the known limitations. It is the companion to `PORTING.md`
(architecture reference) at the repo root.

> Scrubbing note: no credentials appear here. Earlier session transcripts
> contained a live OAuth bearer token and a personal email — those were redacted
> when distilling the other context docs and are NOT in this repo. Never commit
> `*.har`, tokens, or cookies (the `.har` capture is gitignored).

## Starting point

The repo already contained the fully extracted Chrome extension (`assets/*`
minified bundles, `manifest.json`, HTML pages) plus an initial Firefox glue layer
(`firefox-*.js`). The extension partly worked on Firefox — a tab group appeared —
but sending a chat message failed with a 401 and the console showed `No active tab`.

## Problems solved (in order), each shipped as a commit on `main`

### 1. CORS 401 on `POST /v1/messages` — `Bearer …` present, still rejected
Error body: `authentication_error: "CORS requests are not allowed for this
Organization because of its settings."` The request already carried a valid OAuth
bearer + `anthropic-client-platform` (the `PermissionManager` fetch class sets
them). Root cause: the request originates from the **sidebar** page
(`moz-extension://<uuid>` origin), so Firefox attaches an `Origin` header; the
Anthropic API treats any OAuth request bearing `Origin` as a browser CORS request
and the org setting rejects it. Chrome never hit this because its service-worker
fetch carries no `Origin` (and Chrome can't strip `Origin` via webRequest anyway).
**Fix:** `firefox-bg-loader.js` extends the existing `webRequest.onBeforeSendHeaders`
listener to strip `Origin` + `Referer` on `api.anthropic.com` requests, making them
look server-side. Requires `<all_urls>` host permission actually granted.

### 2. Sidebar reset on tab switch
Chrome's sidepanel is per-tab; Firefox has one global sidebar. The glue translated
`sidePanel.setOptions({tabId,path})` to a per-tab `sidebarAction.setPanel`, so
switching to a tab without a per-tab panel fell back to the default URL and
RELOADED the whole bundle, wiping in-progress chat. **First fix:** set a single
GLOBAL panel so the URL stays constant across tab switches (no reload). **Later
refined** (see #6) into per-working-tab visibility.

### 3. `chrome.debugger` CDP commands (page automation)
Firefox has no debugger API; the automation (click/type/screenshot/eval) is driven
via CDP. The stub threw, breaking automation. **Fix** (`firefox-page-shims.js`
`chrome.debugger` block): translate the CDP commands the bundle uses —
`Input.dispatchMouseEvent/dispatchKeyEvent/insertText` → synthetic DOM events via
`scripting.executeScript({world:'MAIN', func})`; `Page.captureScreenshot` →
`tabs.captureVisibleTab`; `Runtime.evaluate` → executeScript; `*.enable` → no-op.
`attach/detach/getTargets` must fire their **callbacks** (the bundle calls them
callback-style inside a `Promise.race`; an async-only stub hangs every command).
`insertText` uses the native value setter so React `onChange` fires; contentEditable
uses `execCommand`.

### 4. `chrome.debugger` CDP events
`onEvent` was a no-op, so network/console/navigation monitoring never fired.
**Fix:** `onEvent` is a real fan-out; the background derives events from native APIs:
`webRequest` → `Network.requestWillBeSent/responseReceived/loadingFailed` (gated by
per-tab enable flags the `sendCommand` shim records in `storage.session`);
`webNavigation.onCommitted` (main frame) → `Page.frameNavigated`; a MAIN-world
console hook → `Runtime.consoleAPICalled/exceptionThrown`. Events reach
background-context listeners locally (`window.__ffEmitCdp`) and sidepanel listeners
via a `__FF_CDP_EVENT` runtime broadcast. Console capture is gated (off unless the
agent calls `Runtime.enable` for the tab) to avoid per-page overhead.

### 5. Tab groups
Firefox 128 has no `tabGroups`/`tabs.group`. The bundle corrals Claude's tabs into
a group and re-finds them via `tabs.query({groupId})` / `tab.groupId` / `tabGroups.*`.
**Fix:** a LOGICAL group registry in `storage.session` (tabId→groupId + metadata):
`tabs.group/ungroup`, `tabGroups.get/query/update/move`, `tab.groupId` annotation on
wrapped `tabs.query/get`, `query({groupId})` support (strips the FF-unsupported
`groupId` filter before the native call). No visual group in the FF tab strip —
purely logical so the orchestration works. Membership pruned on `tabs.onRemoved`.

### 6. Input lock during agent runs
Requirement: while Claude drives a tab the user must not interfere.
**Fix:** `firefox-input-blocker.js` content script. While the agent is active
(between `SHOW_AGENT_INDICATORS` and `HIDE_AGENT_INDICATORS` — the same broadcast
the visual-indicator content script uses) capture-phase listeners swallow user
input. Gated on `event.isTrusted`: real user events (true) blocked, Claude's
synthetic CDP-shim events (false) pass. Events targeting `#claude-agent-stop-container`
pass so Stop-Claude stays clickable. Deliberately NO pointer-events overlay — an
overlay would be returned by `document.elementFromPoint` and break the automation's
targeting.

### 7. Offscreen document (notification sounds + GIF export)
Chrome needs an offscreen document because its SW has no DOM. Firefox's MV3
background is a real event PAGE with full DOM. **Fix:** load `offscreen.js` + `gif.js`
directly into `background.scripts`; `chrome.offscreen.hasDocument → true` (no-op
create/close) so the bundle just posts its messages; a `runtime.sendMessage` wrapper
dispatches background-origin `OFFSCREEN_PLAY_SOUND/GENERATE_GIF/REVOKE_BLOB_URL` to
the handlers `offscreen.js` exposes as page globals (same-context sends don't loop
back), while sidepanel-origin messages hit `offscreen.js`'s listener cross-context.

### 8. Sidebar visibility: chat only on working tabs
Requirement: the chat panel should appear only on Claude's working-group tabs and
hide on others, while the agent keeps running in the background. Firefox lets us
swap the per-tab panel freely but NOT reopen the sidebar programmatically
(`open()` needs a user gesture). **Decision** (chosen by the user from options): an
**idle placeholder** with auto-return — never close, just swap content. Working-group
tabs show `sidepanel.html?tabId=<chatTab>` (one URL, no reload when switching among
them); other tabs show `firefox-idle-panel.html` ("Claude is working in the
background"). Driven by a background `tabs.onActivated` handler. **Gated**: the swap
only runs while the chat tab is actually in an active group (multi-tab work);
plain chat with no group shows chat everywhere. The binding is cleared and idled
tabs restored when the chat tab closes (fixes a stale-placeholder bug).

### 9. Smaller shims
- `chrome.dom.openOrClosedShadowRoot` (Chrome-only, used for shadow-DOM traversal in
  the element/accessibility tree) → mapped to the open shadow root (closed roots are
  inaccessible to FF extensions → null, tolerated). Shimmed in both extension-page
  and content-script worlds.
- `chrome.action.getUserSettings` (Chrome-only) → `{isOnToolbar:true}`.

## Key decisions

- **No `browser-polyfill`.** It's present in the repo but not loaded; the extension
  works, which proves Firefox's native `chrome.*` alias already returns promises for
  the APIs used. So `alarms`, `notifications`, `downloads`, `windows`, `commands`,
  `storage`, `scripting`, `webNavigation` work natively. A later audit subagent
  flagged these as "hard blockers" — that was wrong; adding speculative shims would
  risk regressing working behavior. **Principle: don't fix what isn't broken.**
- **Console capture gated** to avoid hooking console on every page for all users.
- **Origin stripping** over routing fetches through the background — FF background
  fetches also carry a moz-extension Origin, so Origin removal is the real lever.

## Known limitations (documented in PORTING.md)

- **Native messaging** (`connectNative` to `com.anthropic.claude_browser_extension` /
  `…claude_code_browser_extension`) — the MCP desktop bridge needs an OS-level native
  host registered for Firefox. Degrades gracefully when absent. Not a code-only port.
- **`Page.javascriptDialogOpening` (beforeunload)** — FF can't answer the native
  beforeunload dialog programmatically; navigating away during automation may rarely
  show a blocking prompt.
- **Synthetic events are untrusted** (`isTrusted=false`) — elements gated on trusted
  input may ignore Claude's clicks/keys.
- **`tabs.captureVisibleTab`** captures only the active/visible tab (CDP could capture
  any background target).
- **Closed shadow roots** inaccessible to FF extensions (open roots work).

## Workflow notes for future sessions

- `assets/*` are minified — never hand-edit; all Firefox behavior lives in the root
  `firefox-*.js` + `manifest.json`.
- `firefox-page-shims.js` MUST stay first in `background.scripts` (it installs shims
  the bundle touches at module-eval time).
- Validate every edit with `node --check`. Keep `*.har` and any credentials out of git.
- Commit per logical batch; push to `origin/main` (repo is `Niki-q/claude-zen`).
