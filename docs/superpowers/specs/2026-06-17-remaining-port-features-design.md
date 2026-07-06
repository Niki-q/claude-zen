# Design — Remaining Firefox-port features (4)

Date: 2026-06-17 · Branch base: `main`

Four features close the last meaningful gaps in the Chrome→Firefox port (per
`docs/EXTENSION_PORT_MAP.md` §7–8, which is itself stale on tab-groups + screenshots —
both already shipped to `main`):

1. **Continue past chat** — re-seed a saved transcript into the live agent.
2. **JS / `beforeunload` dialog taming** — stop native dialogs blocking automation.
3. **Untrusted-input failure detection** — surface synthetic-event no-ops to the model.
4. **MCP WebSocket-bridge port** — make the hosted MCP relay work on Firefox.

All shim files stay classic (non-module) scripts, `[claude-zen]`-prefixed, and any new
file is added to the `update-from-store.ps1` protected list. `assets/*` is never edited.

---

## 1. Continue past chat

### Problem
The upstream bundle keeps the conversation only in volatile React/Zustand state and never
persists it. We already **capture** transcripts to `storage.local.__czChats` and show a
read-only Recent viewer (`firefox-threads.js`). What's missing: re-injecting a saved chat
so the live agent regains context ("continue").

### Injection seam (verified in bundle)
`sidepanel-hXBOAxVN.js` runs on mount, ~100ms after first render:
```js
v(y.TEST_DATA_MESSAGES).then(e => { e && e.length>0 && x(e) })   // x = setMessages
```
`y.TEST_DATA_MESSAGES === "test_data_messages"` (storage key). It is **not** dev-gated:
writing a non-empty array to `storage.local.test_data_messages` makes the bundle hydrate
the live conversation (React state → Zustand store `ks` → render → next `/v1/messages`
request carries the history). Store messages are essentially wire format (`{role, content}`
where content is a string or block array). The bundle already tolerates seeded prior
history (it has a compaction path: `"This conversation has been summarized…"` /
`"Continue the conversation."`).

### Shape problem → flatten to text
`__czChats` capture dropped the data the API requires for structural replay:
`tool_use` has no `id`, `tool_result` no `tool_use_id`, `thinking` no `signature`, `image`
no source. Seeding those blocks verbatim → the next request is **rejected (400)**.
So the converter **flattens** non-text blocks to descriptive text, preserving turn order:

| Saved block | Converted to |
|---|---|
| `text` | `{type:'text', text}` (unchanged) |
| `thinking` | text: `💭 [thinking] …` |
| `tool_use` | text: `🔧 [tool: <name>] <input-json>` |
| `tool_result` | text: `✅ [tool result]…` (or `⚠️ [tool error]…`) |
| `image` | dropped (no data was captured) |

Each message keeps its `role`; an assistant turn that was only tool_use becomes an
assistant text turn, a user turn that was only tool_result becomes a user text turn — all
valid wire format. The captured `lastReply` (the streamed assistant reply not yet in
`messages`) is appended as a final `{role:'assistant', content:lastReply}` if present.
A per-message `id`/`uuid` is added if a live probe shows the renderer needs one.

### Flow
```
Recent viewer row → [Continue]
  → FF_CONTINUE_CHAT {chatId}  → background (firefox-threads.js)
       ├─ target tab: chat.tabId still maps to a live thread?  → that thread's mainTabId
       │                                                        else → current sidebar tab
       ├─ czChatToStoreMessages(__czChats[chatId]) → storage.local.test_data_messages
       └─ reply {targetTabId}
  → sidepanel: location.replace('sidepanel.html?tabId='+targetTabId)  // re-mount → hydrate
```
**One-shot:** the bundle's loader does not clear `test_data_messages`. The sidepanel shim,
on mount, if the key is present, schedules a clear ~1500ms later (after the 100ms loader
consumed it) so a manual reload won't re-hydrate.

### Components
| Where | Item |
|---|---|
| `firefox-page-shims.js` | `self.czChatToStoreMessages(chat)` converter; one-shot clear of `test_data_messages` on mount |
| `firefox-threads.js` (sidepanel) | "Continue" button in Recent rows → `FF_CONTINUE_CHAT`; on reply `location.replace(?tabId=)` |
| `firefox-threads.js` (background) | `FF_CONTINUE_CHAT` handler: resolve tab (reuse `__ffThreadForTab`/registry), write key, reply `{targetTabId}` |

### Edge cases
- Missing/empty chat → toast error, no-op.
- Old tab gone (post-restart) → seed into current sidebar tab; agent starts a fresh group.
- Continued chat re-captures under a new chatId on next turn (acceptable).

---

## 2. JS / `beforeunload` dialog taming

### Problem
`handleJavaScriptDialog` is a no-op stub; FF can't answer native `alert/confirm/prompt`
or `beforeunload` programmatically. An automated flow that triggers one **blocks**.

### Approach — suppress in-page, gated on agent-active
Native dialogs block the page JS thread synchronously and can't be intercepted from
outside, so override them in the page (MAIN world). Override **only while the agent is
driving** so the user's own dialogs on idle tabs are untouched.

Cross-world gate (MAIN ↔ ISOLATED share the DOM): the existing input-blocker (ISOLATED)
already tracks agent-active (session message + CDP `__FF_AGENT_ACTIVE` heartbeat). It sets
`document.documentElement.dataset.czAgent = '1'` while active and removes it when idle.

New MAIN-world content script `firefox-dialog-tamer.js` (`<all_urls>`, top frame,
`document_start`):
- saves originals, overrides `window.alert` (→ no-op), `confirm` (→ `true`),
  `prompt` (→ default value) — but only when `documentElement.dataset.czAgent === '1'`,
  else delegates to the saved original;
- capture-phase `beforeunload` listener: while agent-active, `e.preventDefault()` +
  clear `returnValue` so agent-triggered navigations don't pop "Leave site?".

CDP shim (`firefox-page-shims.js`): map `Page.javascriptDialogOpening` (no-op event) and
`Page.handleJavaScriptDialog` → resolve `{}` success (dialogs are already auto-handled
in-page), so the bundle's dialog plumbing doesn't stall.

### Caveat
Browser-UI-initiated `beforeunload` (user closing the tab) still shows — only
agent-triggered ones are suppressed. Acceptable.

---

## 3. Untrusted-input failure detection

### Problem
Synthetic events are `isTrusted=false`; some sites ignore them. The click shim already
rejects clicks that hit nothing / hit inert targets with zero mutations. Keystrokes,
`insertText`, and drag/drop have no such check — failures are silent ("typed but nothing
happened").

### Approach — post-dispatch verification + soft error
In `firefox-page-shims.js` CDP shim, after `Input.dispatchKeyEvent` / `Input.insertText`:
- for a text target (input/textarea/contentEditable), snapshot `value`/`textContent`
  before dispatch; after dispatch, if it didn't change **and** the key was a
  value-affecting key (printable / Backspace / Delete / Enter-in-field),
  `czLog('cdp', 'KEY-IGNORED …')` / `PASTE-IGNORED` and return a CDP-shaped soft error
  (`{exceptionDetails…}` or a rejection the bundle surfaces) noting possible
  `isTrusted=false` rejection;
- drag/drop: if no `dragstart`/`drop` effect observed, log `DRAG-IGNORED`.

Conservative, mirroring the click shim's lesson: read state **before** dispatch; never
false-fail an action that did take effect (DOM/value change = success). Detection +
logging is the floor; the soft error is only returned when evidence is unambiguous.

---

## 4. MCP WebSocket-bridge port

### Problem & transport reality (verified in bundle)
The extension has **two** MCP transports:
- **Native host** — `chrome.runtime.connectNative("com.anthropic.claude_browser_extension"
  | "...claude_code_browser_extension")`. Needs an OS-level native host binary we don't
  have. On FF the bundle's detector returns false gracefully. **Out of scope** (document
  the OS-host requirement; not code-only).
- **WebSocket bridge** — `mcpPermissions-CUBzZeeG.js` `nn()` opens
  `wss://bridge.claudeusercontent.com/chrome/<token>`, sends
  `{type:"connect", client_type:"chrome-extension", device_id, os_platform,
  extension_version, oauth_token?, display_name?}`. A hosted **relay** between the
  extension and a desktop Claude (Desktop / Claude Code) that connects to the same bridge;
  pairing via `pairing.html` (`pairing_request` → `show_pairing_prompt` →
  `pairing_confirmed`). **Code-only portable** — WebSocket is native in FF and we already
  have the OAuth token.

### Approach
- **WS handshake Origin:** FF sends `Origin: moz-extension://<uuid>`; the bridge may reject
  non-extension origins (same class as the `/v1/messages` CORS-401 we fixed). Add a
  `webRequest.onBeforeSendHeaders` rule in `firefox-bg-loader.js` scoped to
  `wss://bridge.claudeusercontent.com/*` (request type `websocket`) that strips/rewrites
  `Origin`. Defensive — keep even if the bridge turns out lenient.
- **Token-mint call** (`p(o)` that yields `<token>`): identify its host; if it's
  `api.anthropic.com` / `platform.claude.com`, ensure existing Origin handling covers it
  (extend the webRequest scope if needed).
- **Pairing UI:** confirm `pairing.html` gets the `firefox-page-shims.js` injection (the
  update script already patches it) and that `show_pairing_prompt` surfaces in FF
  (a window/tab). Fix injection/opening if broken.
- **Native host:** leave the `connectNative` path as graceful no-op; add a short note to
  `EXTENSION_PORT_MAP.md` that the native transport needs an OS host install.

### Verification limits (state honestly)
MCP servers only appear when a **desktop Claude companion** is paired through the same
bridge — the extension is one end of a relay. We can smoke-test the WS connect + pairing
handshake, but **end-to-end MCP tool use cannot be confirmed in this environment** without
that companion. Deliverable: the FF-side bridge path connects and pairs; tool relay is
assumed-working by parity with Chrome.

---

## Cross-cutting

- **Docs:** refresh `EXTENSION_PORT_MAP.md` §6–8 (native tab groups + background-tab
  screenshots already shipped; record dialogs / input-detection / MCP-bridge status).
- **Protected list:** add `firefox-dialog-tamer.js` to `update-from-store.ps1` and the
  `pairing.html`/content-script registration as needed.
- **Testing:** no framework exists — `node --check` on every edited `firefox-*.js`,
  console helpers, and manual Firefox runs (the project's established method). MCP gets a
  connection smoke test only.

## Build order
1 (continue chat, self-contained) → 2 (dialogs) → 3 (input detection) → 4 (MCP bridge,
most uncertain). Each is independently shippable.
