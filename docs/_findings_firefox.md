# Firefox Port — Findings

Scope: exactly what the Chrome→Firefox port of the "Claude" extension covers, what it does not, and
the state of the divergent `origin/firefox-tab-groups` branch.

Sources: `PORTING.md`, `docs/context/03-firefox-port-session.md`, the root `firefox-*.js` shims (read
directly), `manifest.json`, and git history (`main` + `origin/firefox-tab-groups`).

Architecture: the repo IS the bundled, minified Chrome extension (`assets/*` — never hand-edited).
A Firefox MV3 compatibility layer (root `firefox-*.js` + `manifest.json`) shims Chrome-only APIs so
the **unmodified** Chrome bundle runs on Firefox 128+. `firefox-page-shims.js` (1050 lines) MUST load
first in `background.scripts`; `firefox-bg-loader.js` (385 lines) then `import()`s the original SW
bundle (`assets/service-worker.ts-B5az7Lf2.js`). `browser-polyfill.min.js` is present but NOT loaded —
FF's native `chrome.*` alias already returns promises for the APIs used.

---

## 1. Per-commit port log (`main`)

`git log main --oneline` (base `f0b3d62` = Chrome snapshot). The mechanism detail comes from the
`03-firefox-port-session.md` "Problems solved 1–9" log (authoritative ordering).

| Commit | Area | What was ported / mechanism |
|---|---|---|
| (base `f0b3d62`) | Chrome MV3 | Original: `background.service_worker`, `side_panel`, `chrome.debugger`/CDP agent. |
| (CORS) | CORS 401 on `/v1/messages` | `firefox-bg-loader.js` strips `Origin`/`Referer` for `api.anthropic.com` via blocking `webRequest.onBeforeSendHeaders`. FF adds `Origin: moz-extension://…` to extension-page fetches; Anthropic classifies the OAuth-token request as cross-site CORS and 401s. Chrome SW sends no Origin → never hit. Also injects `anthropic-client-platform`/`-version` headers. |
| (sidebar) | sidePanel → sidebarAction | Chrome sidepanel is per-tab; FF has one global sidebar. `sidePanel.setOptions`→`sidebarAction.setPanel`; `?tabId=N` injected into the sidepanel URL before the bundle's deferred `<script>` runs. FF can't reopen the sidebar programmatically (needs user gesture) → never close, swap content. |
| (CDP cmds) | `chrome.debugger` commands | Translated in the `sendCommand` switch: `Input.dispatchMouseEvent/dispatchKeyEvent/insertText`→synthetic DOM events via `scripting.executeScript({world:'MAIN'})` (`insertText` uses native value setter so React `onChange` fires; contentEditable uses `execCommand`); `Page.captureScreenshot`→`tabs.captureVisibleTab`; `Runtime.evaluate`→executeScript; `*.enable`→no-op flag. attach/detach/getTargets fire their **callbacks** (bundle calls them callback-style in a `Promise.race`; async-only stub would hang every command). |
| (CDP events) | `chrome.debugger` events | `onEvent` = real fan-out. Background derives events from native APIs: `webRequest`→`Network.requestWillBeSent/responseReceived/loadingFailed` (gated by per-tab enable flags in `storage.session`); `webNavigation.onCommitted`→`Page.frameNavigated`. Delivered locally via `window.__ffEmitCdp`, to sidepanel via a `__FF_CDP_EVENT` runtime broadcast. |
| (tab groups) | Tab groups (emulated) | FF 128 has no `tabGroups`/`tabs.group`. LOGICAL registry in `storage.session` (tabId→groupId+meta): `tabs.group/ungroup`, `tabGroups.get/query/update/move`, `tab.groupId` annotation, `query({groupId})` (strips FF-unsupported `groupId` filter before native call). No visual group in the FF tab strip. Pruned on `tabs.onRemoved`. |
| (input lock) | Input lock | `firefox-input-blocker.js` (ISOLATED, all_urls/all_frames): capture-phase listeners swallow `isTrusted` user events while agent works; synthetic agent events (`isTrusted=false`) pass; Stop-Claude stays clickable. Also shims `chrome.dom` in content world. |
| `31a165e` (offscreen) | Offscreen document | **MERGE-BASE with the branch.** FF has no offscreen API. `offscreen.js`+`gif.js` loaded into the FF background page (which has a DOM); `offscreen.hasDocument→true`; a `runtime.sendMessage` wrapper dispatches background-origin offscreen messages. Restores notification sounds + GIF `/share` export. |
| `e0bd34f` | Sidebar visibility | Chat panel (`sidepanel.html?tabId=…`) only on Claude's working-group tabs; idle placeholder elsewhere; driven by `tabs.onActivated`. Switching among working tabs keeps one URL (no reload); crossing the group boundary reloads. |
| `fd2d67a` | CDP events + stub | Synthesize `Network.*` + `Page.frameNavigated`; stub `chrome.action.getUserSettings`→`{isOnToolbar:true}` (bundle awaits it; FF has no such method). |
| `066e73d` | Console capture | CDP `Runtime.consoleAPICalled`/`exceptionThrown` via `firefox-console-hook.js` (MAIN: monkeypatch `console.*` + error/unhandledrejection) → `firefox-console-relay.js` (ISOLATED) → background emit. Gated: off unless agent calls `Runtime.enable` for the tab (avoids per-page overhead). |
| `6ef057b` | Shadow DOM | Shim `chrome.dom.openOrClosedShadowRoot` → call native `el.openOrClosedShadowRoot()` if present else `el.shadowRoot` (open root only). |
| `ee20c7e` | Docs | Add `PORTING.md`. |
| `cd06fdb` | Sidebar refine | While a working group is active, **hide** the sidebar entirely on non-group tabs (refines `e0bd34f`). |
| `00efd3b` | Docs | Archive scrubbed `docs/context/`. A live OAuth token in local transcripts was redacted before commit. |

OAuth (no single commit isolated here, lives in the bg-loader + content scripts): `chrome.identity.launchWebAuthFlow` has no FF equivalent. `firefox-oauth-bridge.js` (MAIN, claude.ai) intercepts claude.ai's `chrome.runtime.sendMessage("<chrome-id>", …)` external-message call → `firefox-oauth-relay.js` (ISOLATED) → background `bg-loader` `handleOAuthRedirect` does the token exchange against `platform.claude.com/v1/oauth/token`. Sidepanel `launchWebAuthFlow` calls route through background via `FF_IDENTITY_LAUNCH`.

---

## 2. API / CDP coverage

Legend: ✅ native alias · ✅ shimmed · 🟡 partial · ❌ not ported.

### chrome.* APIs

| API | Original use | FF status | Shim / note |
|---|---|---|---|
| `chrome.debugger` | Drive pages via CDP | ✅ shimmed | `firefox-page-shims.js` — `attach/detach/sendCommand/getTargets/onEvent`; callbacks fired so the bundle's `Promise.race` doesn't stall. |
| `chrome.sidePanel` | Side panel UI | ✅ shimmed | `setOptions`→`sidebarAction.setPanel`; `?tabId` URL injection; per-tab content swap + idle panel + hide-on-non-group-tab. |
| `chrome.identity.launchWebAuthFlow` | OAuth | ✅ shimmed | oauth-bridge (MAIN) + oauth-relay (ISOLATED) → bg-loader token exchange; not `chrome.identity`. |
| `chrome.dom.openOrClosedShadowRoot` | Pierce shadow roots | 🟡 shimmed | Native `openOrClosedShadowRoot()` if present, else `el.shadowRoot` (open only); closed roots inaccessible in many contexts. |
| `chrome.action.getUserSettings` | toolbar state | ✅ shimmed (stub) | Returns `{isOnToolbar:true}`. |
| offscreen API | sounds + GIF export | ✅ shimmed | offscreen.js+gif.js in FF background page; `hasDocument→true`; sendMessage dispatch wrapper. |
| `chrome.tabGroups`/`tabs.group` | native tab groups | 🟡 shimmed (logical only on main) | `storage.session` registry; no visible strip group on `main`. Native (visible) approach lives on the branch — see §5. |
| `chrome.scripting` | (used by shim) | ✅ native | FF native; the CDP shim is built on it. |
| `chrome.tabs` | nav/screenshot/lifecycle | ✅ native | Native; basis of `Page.navigate/reload/captureVisibleTab`, Target enumeration. |
| `chrome.webNavigation` | lifecycle | ✅ native | Native; drives `Page.frameNavigated`. |
| `chrome.webRequest`/`webRequestBlocking` | (FF-only need) | ✅ native | Native; Origin strip + Network.* event synthesis. |
| `chrome.storage` | state + group/event-gate registry | ✅ native | Native; `storage.session` shared across background + sidepanel. |
| `chrome.alarms`,`notifications`,`downloads`,`windows`,`commands` | misc | ✅ native | PORTING.md Notes — work natively, no shim (none added speculatively). |
| `chrome.runtime` (messaging) | messaging | ✅ native | Backbone of relays + `__FF_CDP_EVENT`. |
| `chrome.runtime.connectNative` (native messaging) | MCP desktop bridge | ❌ not ported | No FF native host registered for `com.anthropic.claude_browser_extension`; degrades gracefully when absent. Not a code-only port (needs OS-level host install). |

### CDP domains / methods (via the debugger shim)

| CDP | Original use | FF status | Mechanism |
|---|---|---|---|
| `Runtime.evaluate` | eval in page | ✅ shimmed | `scripting.executeScript` MAIN world. |
| `Runtime.enable` | enable | ✅ shimmed | Flag in `storage.session`; gates console + Network capture. |
| `Runtime.consoleAPICalled` / `exceptionThrown` | console/error capture | ✅ shimmed | console-hook (MAIN) → console-relay (ISOLATED) → background emit. Gated. |
| `Page.navigate` / `Page.reload` | navigate | ✅ shimmed | `tabs.update` / `tabs.reload`. |
| `Page.captureScreenshot` | screenshot | 🟡 partial | `tabs.captureVisibleTab` — visible tab only. |
| `Page.frameNavigated` | lifecycle | ✅ shimmed | `webNavigation.onCommitted` (main frame). |
| `Page.enable` / `DOM.enable` | enable | ✅ shimmed | No-op. |
| `Page.handleJavaScriptDialog` | dialogs | 🟡 stub | Switch case present but no-op; can't drive native dialogs. |
| `Network.enable` / `disable` | net gating | ✅ shimmed | Sets per-tab `net` flag in `storage.session`. |
| `Network.requestWillBeSent` / `responseReceived` / `loadingFailed` | net monitoring | ✅ shimmed | Derived from `webRequest`, gated by enable flag. |
| `Input.dispatchMouseEvent` (mouseMoved/Pressed/Released/Wheel) | mouse | 🟡 partial | Synthetic `mousemove/down/up/click/wheel` in MAIN world via `elementFromPoint` — `isTrusted=false`. |
| `Input.dispatchKeyEvent` / `insertText` | keyboard | 🟡 partial | Synthetic events; `insertText` native value setter → React `onChange`; contentEditable `execCommand`. `isTrusted=false`. |
| `Page.javascriptDialogOpening` (beforeunload) | dialog intercept | ❌ not ported | FF can't answer the native beforeunload dialog programmatically. |
| `Target.getTargets` / attach | targets | ✅ shimmed | callbacks fired; `tabs` based. |

---

## 3. Manifest diff notes (Chrome → Firefox)

Confirmed from `manifest.json` (version `1.0.72`):

| Chrome MV3 | Firefox (main) |
|---|---|
| `background.service_worker` | `background.scripts: ["firefox-page-shims.js","gif.js","offscreen.js","firefox-bg-loader.js"]` (classic event-page scripts, not a SW). Shim FIRST is mandatory — installs shims the bundle touches at module-eval time. |
| `side_panel` | `sidebar_action.default_panel:"sidepanel.html"` (+ `default_title`, `default_icon`) |
| (n/a) | `browser_specific_settings.gecko.id="claude-zen@firefox"`, `strict_min_version:"128.0"` |
| permissions | `storage, activeTab, scripting, tabs, alarms, notifications, webNavigation, declarativeNetRequest, nativeMessaging, unlimitedStorage, downloads, identity, webRequest, webRequestBlocking` |
| content_scripts | 8 entries: oauth-bridge (MAIN, claude.ai), oauth-relay (ISOLATED, claude.ai), bundle content-script (claude.ai), accessibility-tree (all_urls, all_frames), agent-visual-indicator, input-blocker (all_urls, all_frames, ISOLATED), console-hook (MAIN), console-relay (ISOLATED). |
| commands | `toggle-side-panel` Ctrl+E / Cmd+E |

Per-shim-file summary (line counts confirmed):
- `firefox-page-shims.js` (1050) — main shim. `chrome.debugger` CDP shim (sendCommand switch over Runtime/Page/Input/DOM/Network/Target), `chrome.sidePanel`→`sidebarAction` bridge + `?tabId` injection, `chrome.dom.openOrClosedShadowRoot`, `chrome.action.getUserSettings` stub, tab-group `storage.session` registry, fetch header injection (`anthropic-client-platform`/`-version`), `__ffEmitCdp`/`__FF_CDP_EVENT` event fan-out, identity launch routing. Loaded first in background AND injected before the bundle on every extension page.
- `firefox-bg-loader.js` (385) — strips `Origin`/`Referer` on `api.anthropic.com` (blocking `webRequest.onBeforeSendHeaders`); OAuth external-message relay handler + token exchange (`platform.claude.com/v1/oauth/token`); then `import('./assets/service-worker.ts-B5az7Lf2.js')`.
- `firefox-oauth-bridge.js` (62, MAIN, claude.ai) — intercept claude.ai's external `runtime.sendMessage("<chrome-id>")`, postMessage.
- `firefox-oauth-relay.js` (10, ISOLATED, claude.ai) — forward to background as `{_czOAuthType:'relay'}`.
- `firefox-input-blocker.js` (72, ISOLATED, all_urls/all_frames) — capture-phase input block while locked; `chrome.dom` shim in content world.
- `firefox-console-hook.js` (63, MAIN) — monkeypatch `console.*` + error/unhandledrejection.
- `firefox-console-relay.js` (25, ISOLATED) — forward console payloads → `Runtime.*` CDP events.
- `firefox-idle-panel.html/.js` (8) — placeholder sidebar for non-working tabs.
- `offscreen.js` + `gif.js` — run in FF background page (offscreen API replacement).

---

## 4. Known limitations (PORTING.md + 03-firefox-port-session.md + observed in code)

- **Native messaging** (`chrome.runtime.connectNative` to `com.anthropic.claude_browser_extension`) — the MCP desktop/bridge integration needs an OS-level native host registered for Firefox. Degrades gracefully when absent. Not a code-only port.
- **`Page.javascriptDialogOpening` (beforeunload)** — FF can't answer the native beforeunload dialog programmatically; navigating away during automation may rarely show a blocking prompt. (`handleJavaScriptDialog` switch case is a no-op stub.)
- **Synthetic events untrusted (`isTrusted=false`)** — all `Input.*` events are dispatched from content/MAIN world; elements gated on trusted input may ignore the agent's clicks/keys. No fix within WebExtensions.
- **`tabs.captureVisibleTab` visible-tab-only** — can't screenshot an arbitrary background target (CDP could capture any).
- **Closed shadow roots inaccessible** to FF extensions in many contexts (open roots work; native `openOrClosedShadowRoot` only where the browser exposes it).
- **Tab groups on main are logical-only** — `storage.session` emulation produces no visible tab-strip group (the native/visible approach is unmerged on the branch).
- **Console/Network capture gated** — off until the agent calls `Runtime.enable` for the tab (deliberate; events before enable are silently missed).
- **Sidebar can't be reopened programmatically** — FF `open()` needs a user gesture; the port never closes it, swaps content instead.

---

## 5. Branch divergence — `origin/firefox-tab-groups`

Confirmed data:
- **merge-base: `31a165e`** = the offscreen-document commit (2026-05-29 02:13). The branch forked right after offscreen, so it inherits all earlier port work (CORS, sidebar, CDP cmds/events, tab-group emulation, input lock, offscreen) but **none** of main's 7 later commits.
- `git rev-list --left-right --count main...origin/firefox-tab-groups` = **`7  4`** → main **7 ahead** of base, branch **4 ahead**. **True divergence** (both sides advanced).
- Branch-only commits (4): `a8cea19` (native tab groups + chat debug mirror + new-tab URL fix), `8888f77` (hybrid tab groups so privileged main tabs can be grouped), `d6659b1` (seed main tab into a group so new tabs can join it), `3d084db` (promote Claude's tabs into a visible native tab group).
- Main-only commits (7): `e0bd34f`, `fd2d67a`, `066e73d` (console capture), `6ef057b` (shadow DOM), `ee20c7e` (PORTING.md), `cd06fdb` (hide sidebar), `00efd3b` (docs archive).

`git diff --stat main origin/firefox-tab-groups` (confirmed):
```
.gitignore                              |   4 +    (branch modifies)
CLAUDE.md                               | 359 ++++ (branch ADDS)
PORTING.md                              |  79 ---- (branch DELETES — predates it)
docs/context/01-analysis-a009114b.md    | 374 ---- (branch DELETES)
docs/context/02-analysis-fa25706e.md    | 381 ---- (branch DELETES)
docs/context/03-firefox-port-session.md | 148 ---- (branch DELETES)
docs/context/README.md                  |  18 --- (branch DELETES)
firefox-console-hook.js                 |  63 ---- (branch DELETES)
firefox-console-relay.js                |  25 ---- (branch DELETES)
firefox-idle-panel.html                 |  80 ---- (branch DELETES)
firefox-idle-panel.js                   |   8 --- (branch DELETES)
firefox-input-blocker.js                |  13 +/- (branch modifies)
firefox-page-shims.js                   | 730 +/- (branch REWRITES)
manifest.json                           |  13 +/-
14 files changed, 803 insertions(+), 1492 deletions(-)
```
Manifest delta (branch): **adds `tabGroups` permission**, **removes** the console-hook + console-relay content-script entries. `strict_min_version` stays `128.0` (native groups are runtime-feature-detected at FF 139+; FF 128–138 fall back to emulation).

What the branch HAS that main lacks (its value):
- **Native (visible) tab groups**, implemented by **rewriting `firefox-page-shims.js`** (not a new file). Replaces the pure-`storage.session` logical registry with a HYBRID:
  - FF 139+ exposes `chrome.tabGroups` + `chrome.tabs.group` → groupable web tabs get a **REAL, visible** native group (titled "Claude", orange); mirrored in the registry (`native:true`).
  - Privileged tabs (`moz-extension://`, `about:*`, `chrome://`, etc. — `PRIVILEGED` regex) or FF ≤138 → emulated **negative-id** logical group (never collides with native +ve ids or `TAB_GROUP_ID_NONE`).
  - `tabs.get/query` and `tabGroups.get/query/update/move` overlaid so registry-managed, native, and user-made groups all report consistently. **The registry groupId remains the access-gate boundary**; the native group is purely cosmetic and never diverges the gate.
  - `__ffEnsureMainGroup` **seeds** the resolved sidepanel main tab into a Claude group before the bundle loads (fixes "open N tabs": bundle's `tabs_create` only groups new tabs if `mainTab.groupId !== NONE`).
  - `tabs.onUpdated` listener **promotes** a Claude-managed tab into the visible native group once it navigates to a groupable URL; promotions serialized so a `browser_batch` lands in one group.
  - Plus: **new-tab URL fix** (Chrome's `chrome://newtab` in `tabs.create`/`windows.create` is illegal in FF → drop the url, let FF open its native new tab) and an **opt-in chat debug mirror** (`czDebug()` tees the SSE stream non-destructively to the console; state in `storage.local.__czDebugMirror`).

What main HAS that the branch lacks (branch is BEHIND — predates them):
- `PORTING.md` + the entire `docs/context/` archive.
- `firefox-console-hook.js` / `firefox-console-relay.js` + their content-script entries (console + `exceptionThrown` capture) — branch **deletes** them.
- `firefox-idle-panel.html/.js` (idle sidebar) — branch **deletes** them; and the sidebar visibility refinements (`e0bd34f`, `cd06fdb`).
- The `Network.*`/`Page.frameNavigated` synthesis + `getUserSettings` stub (`fd2d67a`) and the shadow-DOM shim (`6ef057b`).
- (Branch also trims `firefox-input-blocker.js` by 13 lines — verify no input-lock regression.)

### Verdict
**Unmerged, partially-stale experiment — DO NOT merge directly; cherry-pick / re-implement the
native-tab-group work onto current main.** The branch forked at the offscreen commit and is 4 commits
of (valuable) native-tab-group work, but it is missing main's 7 later port commits and actively
**deletes** main's console capture, idle panel, docs, and part of the input blocker. A straight merge
would regress console/exception capture, the idle/hide sidebar logic, and drop all docs. Its sole
non-duplicated contribution — the **hybrid native/visible tab groups** (with the storage registry kept
as the access-gate source of truth and as the FF≤138/privileged-tab fallback), plus the new-tab URL fix
— should be ported on top of current main, adding the `tabGroups` permission. The chat debug mirror is
an optional dev aid. Then retire the branch.

---

## 6. Remaining / not-yet-ported work (prioritized)

**High**
- **Native (visible) tab groups**: port the branch's hybrid `firefox-page-shims.js` rewrite onto current main (native group for groupable tabs on FF 139+, `storage.session` negative-id fallback for privileged tabs / FF≤138; registry stays the access-gate boundary). Add `tabGroups` permission. Pull in the **new-tab URL fix** (`chrome://newtab`→FF native) — it unblocks `tabs_create`/`browser_batch`. Retire the branch after. This is the only real feature gap vs the branch.
- **JS dialog handling** (`Page.javascriptDialogOpening`/beforeunload): unhandled (`handleJavaScriptDialog` is a no-op stub); automation navigating away can hit a blocking native prompt. Investigate `tabs.onUpdated`/content heuristics or `beforeunload` suppression.

**Medium**
- **Trusted input events** (`isTrusted=false`): breaks sites gating on trusted events (some drag/drop, paste). Hard within WebExtensions — at minimum detect/log failures.
- **Background-tab screenshots**: `Page.captureScreenshot` only does the visible tab; add an activate-then-capture fallback.
- **Closed shadow roots**: route shadow/selector queries through the content (ISOLATED) world where `openOrClosedShadowRoot` is available, instead of MAIN-world eval.

**Low**
- **Native messaging**: only if a feature needs the native companion — ship a FF native host `.json` manifest + OS registration (not code-only).
- **Screenshot option fidelity**: map CDP clip/quality/fromSurface onto `captureVisibleTab` more faithfully.
- **Console/Network gating UX**: surface that capture is off until `Runtime.enable` (events before enable are silently missed).
- **Optional**: port the branch's opt-in chat debug mirror (`czDebug()`) as a dev aid.

---

## Entity edges

```
firefox-page-shims --> chrome.debugger : install CDP shim (attach/detach/sendCommand/onEvent, fire callbacks)
firefox-page-shims --> chrome.scripting : Runtime.evaluate + Input.* synthetic DOM events in MAIN world
firefox-page-shims --> chrome.tabs : Page.navigate/reload, captureVisibleTab (Page.captureScreenshot), Target enumeration
firefox-page-shims --> chrome.webNavigation : synthesize Page.frameNavigated from onCommitted
firefox-page-shims --> chrome.webRequest : synthesize Network.requestWillBeSent/responseReceived/loadingFailed
firefox-page-shims --> chrome.sidePanel : bridge setOptions to sidebarAction.setPanel (+ ?tabId injection)
firefox-page-shims --> chrome.dom : shim openOrClosedShadowRoot (open root only)
firefox-page-shims --> chrome.action : stub getUserSettings {isOnToolbar:true}
firefox-page-shims --> chrome.tabGroups : logical group registry in storage.session
firefox-page-shims --> storage.session : tab->group map + per-tab CDP enable flags
firefox-page-shims --> chrome.runtime : route launchWebAuthFlow via FF_IDENTITY_LAUNCH
firefox-page-shims --> __ffEmitCdp : deliver CDP events to background listeners
firefox-page-shims --> __FF_CDP_EVENT : broadcast CDP events to sidepanel
firefox-bg-loader --> webRequest : strip Origin/Referer header for api.anthropic.com (fix 401)
firefox-bg-loader --> platform.claude.com : OAuth token exchange (handleOAuthRedirect)
firefox-bg-loader --> chrome.runtime : receive _czOAuthType relay message
firefox-bg-loader --> service-worker bundle : dynamic import() of unmodified SW
firefox-oauth-bridge --> claude.ai page : intercept external runtime.sendMessage("<chrome-id>") (MAIN)
firefox-oauth-bridge --> firefox-oauth-relay : postMessage OAuth payload
firefox-oauth-relay --> chrome.runtime : sendMessage relay to background
firefox-input-blocker --> DOM input events : capture-phase preventDefault while locked
firefox-input-blocker --> chrome.dom : shim openOrClosedShadowRoot in content world
firefox-console-hook --> console.* : monkeypatch + error/unhandledrejection (MAIN)
firefox-console-hook --> firefox-console-relay : postMessage console payload
firefox-console-relay --> chrome.runtime : sendMessage console to background
firefox-console-relay --> Runtime.consoleAPICalled : background emits CDP console/exception events
offscreen.js --> background page : run gif.js + sounds in FF background DOM (offscreen replacement)
manifest --> background.scripts : page-shims + gif + offscreen + bg-loader (replaces service_worker)
manifest --> sidebar_action : sidepanel.html (replaces side_panel)
manifest --> browser_specific_settings.gecko : id + strict_min_version 128.0
firefox-page-shims(branch) --> chrome.tabs.group : promote groupable tabs into visible native group (FF139+)
firefox-page-shims(branch) --> chrome.tabGroups : tabGroups.update (visible strip group, titled Claude)
firefox-page-shims(branch) --> storage.session : hybrid fallback (negative-id) for privileged tabs / FF<=138
```
