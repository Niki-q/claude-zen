// Firefox shim layer (classic script).
// Loaded in every context that runs the minified Chrome assets:
//   - background  (first entry in background.scripts)
//   - sidepanel.html / options.html / pairing.html  (injected <script> before the module)
// Must run BEFORE the minified bundles, which touch Chrome-only APIs at
// module-evaluation time (chrome.tabGroups, chrome.debugger, etc).

// ── Block CDN script injection blocked by extension CSP (runs in page contexts) ─
if (typeof document !== 'undefined') {
  (function () {
    const blocked        = /^https?:\/\/cdn\.segment\.com\//;
    const _appendChild   = Element.prototype.appendChild;
    const _insertBefore  = Element.prototype.insertBefore;
    const isCdnScript    = (node) =>
      node && node.nodeName === 'SCRIPT' &&
      blocked.test(node.getAttribute ? (node.getAttribute('src') || '') : (node.src || ''));
    Element.prototype.appendChild = function (node) {
      if (isCdnScript(node)) return node;
      return _appendChild.call(this, node);
    };
    Element.prototype.insertBefore = function (node, ref) {
      if (isCdnScript(node)) return node;
      return _insertBefore.call(this, node, ref);
    };
  })();
}

// ── Suppress known Datadog double-bundle warnings (SDK split across chunks) ───
(function () {
  const _warn = console.warn.bind(console);
  console.warn = (...args) => {
    const msg = typeof args[0] === 'string' ? args[0] : '';
    if (msg.startsWith('Datadog Browser SDK:')) return;
    _warn(...args);
  };
})();

// ── Inject anthropic-client-* headers into api.anthropic.com fetches ──────────
// The Chrome bundle adds these via declarativeNetRequest; Firefox's DNR
// modifyHeaders is unreliable (modifyHeaders support / resourceType matching),
// so requests to api.anthropic.com arrive WITHOUT the client headers the API
// uses to validate the OAuth client → HTTP 401 on /v1/messages.
//
// We add them at the fetch layer here. Verified safe: api.anthropic.com's CORS
// reflects requested headers (access-control-allow-headers echoes them, origin *),
// so the preflight accepts anthropic-client-platform/version. User-Agent is a
// forbidden fetch header and is instead set via webRequest in firefox-bg-loader.js.
// Also logs 401/403 response bodies to surface any remaining auth failure cause.
// ── Gate-independent "force stop" (sidepanel only) ───────────────────────────
// The upstream STOP button no-ops in Firefox: the bundle's sidepanel STOP_AGENT
// handler gates its abort on `isAgentRunning` (this React instance's isLoading) and
// ignores the SW-resolved `targetTabId` — so whenever the single global sidebar
// isn't the actively-streaming instance, or it's in a between-requests gap/backoff,
// `cancel()` never runs and Stop silently fails (verified by tracing
// sidepanel-*.js: `n&&s()` where n=isLoading). The *abort itself* (ne.current.abort())
// is correct and definitively terminal: the agent loop's catch first statement is
// `if("Request was aborted."===t)return;` — before any retry branch (verified).
//
// So we bypass the gate entirely: track every AbortController the page creates and,
// on STOP, abort the one whose signal the streaming SDK is watching. Aborting the
// SDK's OWN signal makes it throw APIUserAbortError with message exactly
// "Request was aborted." → the loop hits that terminal branch with zero retry risk.
// To survive the SDK combining the request signal with a timeout via AbortSignal.any,
// we also record `.any()` source signals and walk them. Scoped to the sidepanel
// context (where the agent SDK runs) so the background / MCP-bridge controllers are
// never touched.
if (typeof location !== 'undefined' && /sidepanel\.html$/.test(location.pathname)) {
  try {
    const W = window;
    const AC = W.AbortController, AS = W.AbortSignal;
    if (AC && !AC.__czTracked) {
      const ctrlOf = new WeakMap();     // signal  -> its controller
      const sourcesOf = new WeakMap();  // combined signal -> [source signals]
      const liveOrder = [];             // recent controllers (WeakRef), newest last
      function TrackedAC() {
        const c = new AC();
        try { ctrlOf.set(c.signal, c); liveOrder.push(new WeakRef(c)); if (liveOrder.length > 32) liveOrder.shift(); } catch {}
        return c;
      }
      TrackedAC.prototype = AC.prototype;
      TrackedAC.__czTracked = true;
      try { W.AbortController = TrackedAC; } catch {}
      if (AS && typeof AS.any === 'function' && !AS.any.__czTracked) {
        const origAny = AS.any.bind(AS);
        const patchedAny = (signals) => { const s = origAny(signals); try { sourcesOf.set(s, Array.from(signals || [])); } catch {} return s; };
        patchedAny.__czTracked = true;
        try { AS.any = patchedAny; } catch {}
      }
      // Abort the controller behind `sig` (decomposing any AbortSignal.any combination)
      // so the SDK sees its OWN signal aborted → clean "Request was aborted.".
      const abortSignalCtrl = (sig) => {
        if (!sig) return false;
        let did = false; const seen = new Set();
        const visit = (s) => {
          if (!s || seen.has(s)) return; seen.add(s);
          const c = ctrlOf.get(s);
          if (c && !s.aborted) { try { c.abort(); did = true; } catch {} }
          const src = sourcesOf.get(s);
          if (src) for (const x of src) visit(x);
        };
        visit(sig);
        return did;
      };
      const abortLatest = () => {
        for (let i = liveOrder.length - 1; i >= 0; i--) {
          const c = liveOrder[i] && liveOrder[i].deref();
          if (c && c.signal && !c.signal.aborted) { try { c.abort(); return true; } catch {} }
        }
        return false;
      };
      self.__czAbortSignalCtrl = abortSignalCtrl;
      // Force-stop: abort the live /v1/messages request (precise via its captured signal,
      // plus the freshest controller as a fallback), and arm a short window so the loop's
      // immediate next iteration (gap / backoff retry) is killed at its fetch too.
      self.czForceStop = (reason) => {
        let did = false;
        try { if (self.__czLastAgentSignal) did = abortSignalCtrl(self.__czLastAgentSignal) || did; } catch {}
        try { did = abortLatest() || did; } catch {}
        self.__czStopUntil = Date.now() + 2500;
        try { if (self.czLog) self.czLog('stop', 'czForceStop reason=' + (reason || '?') + ' aborted=' + did); } catch {}
        console.log('[claude-zen] czForceStop reason=' + (reason || '?') + ' aborted=' + did);
        return did;
      };
    }
  } catch (e) { console.warn('[claude-zen] force-stop init failed:', e && e.message); }

  // Catch BOTH the bundle's own STOP_AGENT broadcast (from its main-tab stop button,
  // re-broadcast by the SW as {type:"STOP_AGENT",targetTabId}) and our injected
  // content-script button — either one now force-stops regardless of isAgentRunning.
  // Observe-only: never sendResponse / return true, so the bundle's handler still owns
  // the reply channel.
  try {
    (typeof browser !== 'undefined' ? browser : chrome).runtime.onMessage.addListener((m) => {
      if (m && (m.type === 'STOP_AGENT' || m.type === 'FF_FORCE_STOP') && self.czForceStop) {
        try { self.czForceStop(m.type); } catch {}
      }
    });
  } catch {}
}

if (typeof window !== 'undefined' && typeof window.fetch === 'function') {
  const _origFetch = window.fetch;
  const _ver = (() => { try { return chrome.runtime.getManifest().version; } catch { return ''; } })();
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input
      : (input instanceof URL ? input.href : (input && input.url) || '');
    try {
      if (url.startsWith('https://api.anthropic.com/')) {
        if (input && typeof input === 'object' && !(input instanceof URL) &&
            input.headers && typeof input.headers.set === 'function') {
          // Request object — mutate its headers in place
          if (!input.headers.has('anthropic-client-platform')) input.headers.set('anthropic-client-platform', 'claude_browser_extension');
          if (_ver && !input.headers.has('anthropic-client-version')) input.headers.set('anthropic-client-version', _ver);
        } else {
          // string / URL input — merge into init.headers
          const h = new Headers((init && init.headers) || undefined);
          if (!h.has('anthropic-client-platform')) h.set('anthropic-client-platform', 'claude_browser_extension');
          if (_ver && !h.has('anthropic-client-version')) h.set('anthropic-client-version', _ver);
          init = { ...(init || {}), headers: h };
        }
      }
    } catch (e) { console.warn('[claude-zen] fetch header inject failed:', e?.message); }

    // Debug mirror (opt-in): log the outgoing user turn / tool results.
    const _czIsMessages = url.includes('api.anthropic.com') && url.includes('/messages');
    // Force-stop wiring (sidepanel): remember this agent request's signal so czForceStop
    // can abort the SDK's OWN controller (→ clean terminal "Request was aborted."), and
    // if a stop just fired, abort this freshly-started request so the loop exits at its
    // next iteration instead of continuing through the gap/backoff (the gate-bug case).
    if (_czIsMessages) {
      try {
        const _sig = (init && init.signal) || (input && input.signal) || null;
        if (_sig) self.__czLastAgentSignal = _sig;
        if (self.__czStopUntil && Date.now() < self.__czStopUntil && self.__czAbortSignalCtrl) {
          if (_sig) self.__czAbortSignalCtrl(_sig);
          if (self.czForceStop) self.czForceStop('post-stop request');
        }
      } catch {}
    }
    if (_czIsMessages && self.__czDebug && self.__czDebug.enabled) {
      try { self.__czDebug.logRequest(input, init); } catch {}
    }
    // Conversation capture (ALWAYS on): persist the full transcript per chat so it
    // survives sidebar close / restart. The request body carries the entire messages
    // array each turn, so this snapshot is the whole conversation up to the last user turn.
    if (_czIsMessages && self.czCaptureRequest) {
      try { self.czCaptureRequest(input, init); } catch {}
    }
    // Text-first steering (opt-in, ON by default): append a system instruction nudging
    // the model toward the cheap text tools (read_page / get_page_text / find) instead
    // of screenshots, to cut image tokens. Mutates the request body in place; a safe
    // no-op when disabled, when the body shape is unexpected, or when this isn't the
    // tool-bearing agent request (cosmetic /messages calls have no browser tools).
    if (_czIsMessages && self.czSteerBody) {
      try { const r = self.czSteerBody(input, init); if (r) { input = r.input; init = r.init; } } catch {}
    }

    const resp = await _origFetch.call(this, input, init);

    // Debug mirror (opt-in): tee the SSE response → console (non-destructive).
    if (_czIsMessages && self.__czDebug && self.__czDebug.enabled) {
      try { self.__czDebug.tee(resp); } catch {}
    }
    // Conversation capture: also grab the assistant's reply (the one part the next
    // request won't have yet) from the streamed response, non-destructively.
    if (_czIsMessages && self.czCaptureResponse) {
      try { self.czCaptureResponse(resp); } catch {}
    }
    try {
      if (url.includes('api.anthropic.com') && (resp.status === 401 || resp.status === 403)) {
        const body = await resp.clone().text();
        console.error(`[claude-zen] ${resp.status} from ${url}\n  body: ${body.slice(0, 600)}`);
      }
    } catch {}
    return resp;
  };
}

// ── Conversation capture & persistence (previous-chats, layer 1) ──────────────
// Persists the chat transcript per conversation to storage.local.__czChats so it
// survives the sidebar closing AND a browser restart (the bundle keeps messages only
// in volatile React state and never persists them — verified). Capture is non-
// destructive (request body is read from init.body or a Request clone; the response
// is read via resp.clone()). Runs only where a sidepanel ?tabId=N is present (that's
// where the chat fetches originate and where we can attribute them to a thread).
//   self.czChats()         — list saved chats {id,title,turns,updatedAt}
//   self.czChatExport(id)  — download one chat as a .md transcript
//   self.czChatDelete(id)  — remove a saved chat
// Read by firefox-threads.js to populate the switcher's "Recent" section.
(function () {
  const api = (typeof browser !== 'undefined' ? browser : chrome);
  const store = (api && api.storage && api.storage.local) || null;
  const sess  = (api && api.storage && (api.storage.session || api.storage.local)) || null;
  const KEY = '__czChats';
  const CURKEY = '__czChatCur';      // session map: tabId → current chatId
  const CAP_CHATS = 60;              // max saved chats
  const MAX_BLOCK = 20000;          // truncate any single text/tool block

  // Resolved lazily at capture time — the sidepanel's ?tabId=N is injected by the
  // deferred-module loader slightly AFTER this script runs, so reading it now would be
  // null and would wrongly disable the whole module (incl. czRenderChatMd, used by the
  // viewer). Only contexts bound to a tabId (the sidepanel) actually capture.
  const curTabId = () => {
    try { const v = new URLSearchParams(location.search).get('tabId'); return (v != null && v !== '') ? v : null; }
    catch { return null; }
  };
  if (!store) return;

  const trunc = (s) => { s = String(s == null ? '' : s); return s.length > MAX_BLOCK ? s.slice(0, MAX_BLOCK) + `… [+${s.length - MAX_BLOCK}]` : s; };
  // Strip heavy/base64 image data so storage stays small; keep text + tool shapes.
  const sanitize = (messages) => {
    try {
      return messages.map((m) => {
        const role = m.role || 'user';
        let content = m.content;
        if (typeof content === 'string') return { role, content: trunc(content) };
        if (!Array.isArray(content)) return { role, content: '' };
        const blocks = content.map((c) => {
          if (!c || !c.type) return null;
          if (c.type === 'text') return { type: 'text', text: trunc(c.text) };
          if (c.type === 'thinking') return { type: 'thinking', text: trunc(c.thinking || c.text || '') };
          if (c.type === 'image') return { type: 'image' };
          if (c.type === 'tool_use') return { type: 'tool_use', name: c.name, input: c.input };
          if (c.type === 'tool_result') {
            let body = c.content;
            if (Array.isArray(body)) body = body.map((x) => x && x.type === 'text' ? x.text : x && x.type === 'image' ? '[image]' : `[${(x && x.type) || '?'}]`).join('\n');
            return { type: 'tool_result', is_error: !!c.is_error, content: trunc(body) };
          }
          return { type: c.type };
        }).filter(Boolean);
        return { role, content: blocks };
      });
    } catch { return []; }
  };

  // First-user-message signature → decide whether a request continues the current chat
  // or starts a new one (the bundle's "new chat" clears messages, so messages[0] changes).
  // The bundle re-injects a live <system-reminder>{"availableTabs":[…]}</system-reminder>
  // into the first user message on EVERY request, and tab titles inside it can change
  // between turns (e.g. a quiz page counting down "Time Left: 00:55:31" in its title).
  // Comparing the raw text made the sig differ each turn → a fresh chatId per request →
  // one conversation saved as ~30 growing duplicate snapshots. Strip reminder blocks
  // before comparing.
  const stripReminders = (t) => String(t || '').replace(/<system-reminder[\s\S]*?(<\/system-reminder>|$)/g, ' ');
  const firstSig = (messages) => {
    const m = messages.find((x) => x.role === 'user') || messages[0];
    if (!m) return '';
    let t = m.content;
    if (Array.isArray(t)) t = t.map((c) => c && c.type === 'text' ? c.text : '').join(' ');
    return stripReminders(t).replace(/\s+/g, ' ').trim().slice(0, 120);
  };
  const titleOf = (messages) => {
    const sig = firstSig(messages);
    return sig ? sig.replace(/\s+/g, ' ').slice(0, 80) : 'Untitled chat';
  };
  // The bundle fires SEPARATE /v1/messages calls (sidepanel-*.js) for UI cosmetics, not
  // real conversation turns:
  //   • status generator: "<message>…</message>\n\n…generate a 7-word-or-less status…"
  //   • title  generator: "<conversation>…</conversation>\n\n…suggest a title…<title>…"
  // These were each saved as their own 2-msg chat, AND (worse) poisoned the per-tab
  // curMap so the REAL conversation got a brand-new chatId on every turn — that's why one
  // dialog showed up as N separate growing snapshots. Detect by the fixed instruction text
  // and skip them entirely (don't persist, don't touch curMap).
  // "You are helping find elements" = the find tool's internal small-model helper call
  // (one-shot, huge accessibility tree) — not a conversation; don't save it.
  const AUX_RE = /generate a 7-word-or-less status|suggest a title based on the first message|<\/message>\s*$|<\/conversation>|^You are helping find elements on a web page/;
  const isAuxRequest = (messages) => {
    try {
      for (const m of (messages || [])) {
        let t = m && m.content;
        if (Array.isArray(t)) t = t.map((c) => c && c.type === 'text' ? c.text : '').join(' ');
        if (typeof t === 'string' && AUX_RE.test(t)) return true;
      }
    } catch {}
    return false;
  };

  let writeChain = Promise.resolve();
  const persist = (requestObj) => {
    writeChain = writeChain.then(async () => {
      const activeTab = curTabId();
      if (activeTab == null) return; // not a tab-bound context (e.g. background) — skip
      if (isAuxRequest(requestObj.messages)) return; // skip status-title generator calls
      const messages = sanitize(requestObj.messages || []);
      if (!messages.length) return;
      const sig = firstSig(requestObj.messages || []);
      let curMap = {};
      try { const o = sess && await sess.get(CURKEY); curMap = (o && o[CURKEY]) || {}; } catch {}
      let chatId = curMap[activeTab];

      const o = await store.get(KEY);
      const chats = (o && o[KEY]) || {};
      // One-time cleanup: purge bogus status-title chats saved before isAuxRequest existed
      // (sig/title begins with the "<message>" wrapper the generator used).
      for (const id of Object.keys(chats)) {
        if (/^<message>|^<conversation>/.test(String((chats[id] && chats[id].sig) || ''))) delete chats[id];
      }
      // Rotate to a new chat if none active, the active one is gone, or the first
      // message changed (a "new chat" was started in this tab).
      if (!chatId || !chats[chatId] || (chats[chatId].sig && sig && chats[chatId].sig !== sig)) {
        chatId = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        curMap[activeTab] = chatId;
        try { if (sess) await sess.set({ [CURKEY]: curMap }); } catch {}
      }
      const now = Date.now();
      const prev = chats[chatId];
      chats[chatId] = {
        id: chatId, tabId: activeTab, sig,
        title: titleOf(requestObj.messages || []),
        model: requestObj.model || (prev && prev.model) || '',
        messages,
        turns: messages.length,
        createdAt: (prev && prev.createdAt) || now,
        updatedAt: now,
        lastReply: prev && prev.lastReply, // filled by czCaptureResponse
      };
      // Evict oldest beyond cap.
      const ids = Object.keys(chats);
      if (ids.length > CAP_CHATS) {
        ids.sort((a, b) => (chats[a].updatedAt || 0) - (chats[b].updatedAt || 0));
        for (let i = 0; i < ids.length - CAP_CHATS; i++) delete chats[ids[i]];
      }
      self.__czCurChatId = chatId;
      await store.set({ [KEY]: chats });
    }).catch(() => {});
  };

  self.czCaptureRequest = (input, init) => {
    const body = init && init.body;
    if (typeof body === 'string') { try { const o = JSON.parse(body); if (o && Array.isArray(o.messages)) persist(o); } catch {} return; }
    if (input && typeof input.clone === 'function') {
      input.clone().text().then((s) => { try { const o = JSON.parse(s); if (o && Array.isArray(o.messages)) persist(o); } catch {} }).catch(() => {});
    }
  };

  // Append the streamed assistant reply (the part the next request body won't include
  // until the turn after). Parsed from a clone; best-effort, text only.
  self.czCaptureResponse = (resp) => {
    try {
      const ct = (resp.headers && resp.headers.get('content-type')) || '';
      if (!resp.body || !/event-stream/.test(ct)) return;
      (async () => {
        const reader = resp.clone().body.getReader();
        const dec = new TextDecoder();
        let buf = '', text = '';
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, i); buf = buf.slice(i + 2);
            let data = ''; for (const ln of raw.split('\n')) if (ln.startsWith('data:')) data += ln.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let ev; try { ev = JSON.parse(data); } catch { continue; }
            if (ev.type === 'content_block_delta' && ev.delta) { if (ev.delta.type === 'text_delta') text += ev.delta.text || ''; }
          }
        }
        if (!text) return;
        const cid = self.__czCurChatId;
        if (!cid) return;
        const o = await store.get(KEY); const chats = (o && o[KEY]) || {};
        if (chats[cid]) { chats[cid].lastReply = trunc(text); chats[cid].updatedAt = Date.now(); await store.set({ [KEY]: chats }); }
      })().catch(() => {});
    } catch {}
  };

  // Render a saved chat as markdown (used by export + the read-only viewer).
  self.czRenderChatMd = (chat) => {
    const out = ['# ' + (chat.title || 'Chat'), '', '_' + new Date(chat.createdAt || Date.now()).toLocaleString() + (chat.model ? ' · ' + chat.model : '') + '_', ''];
    for (const m of (chat.messages || [])) {
      out.push(m.role === 'user' ? '### 👤 User' : '### 🤖 Assistant');
      if (typeof m.content === 'string') out.push(m.content);
      else for (const b of (m.content || [])) {
        if (b.type === 'text') out.push(b.text || '');
        else if (b.type === 'thinking') out.push('> 💭 ' + String(b.text || '').replace(/\n/g, '\n> '));
        else if (b.type === 'tool_use') out.push('🔧 **' + (b.name || 'tool') + '**\n```json\n' + JSON.stringify(b.input || {}, null, 2) + '\n```');
        else if (b.type === 'tool_result') out.push('✅ tool_result' + (b.is_error ? ' [error]' : '') + '\n```\n' + (b.content || '') + '\n```');
        else if (b.type === 'image') out.push('_[image]_');
      }
      out.push('');
    }
    if (chat.lastReply) out.push('### 🤖 Assistant (final)', chat.lastReply, '');
    return out.join('\n');
  };

  // Console helpers.
  self.czChats = async () => { const o = await store.get(KEY); const c = (o && o[KEY]) || {}; return Object.values(c).sort((a, b) => b.updatedAt - a.updatedAt).map((x) => ({ id: x.id, title: x.title, turns: x.turns, updated: new Date(x.updatedAt).toLocaleString() })); };
  self.czChatExport = async (id) => {
    const o = await store.get(KEY); const c = (o && o[KEY]) || {}; const chat = c[id] || (await self.czChats())[0] && c[(await self.czChats())[0].id];
    if (!chat) return 'no such chat';
    const md = self.czRenderChatMd ? self.czRenderChatMd(chat) : JSON.stringify(chat, null, 2);
    const urlB = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    const fn = 'claude-chat-' + (chat.title || id).replace(/[^\w]+/g, '-').slice(0, 40) + '.md';
    try { if (api.downloads) await api.downloads.download({ url: urlB, filename: fn, saveAs: true }); } catch {}
    setTimeout(() => URL.revokeObjectURL(urlB), 60000);
    return 'exported ' + fn;
  };
  self.czChatDelete = async (id) => { const o = await store.get(KEY); const c = (o && o[KEY]) || {}; delete c[id]; await store.set({ [KEY]: c }); return 'deleted'; };

  // ── Continue a past chat: convert a saved transcript → wire-format messages ──
  // Re-seeds a saved chat into the live bundle (see firefox-threads.js FF_CONTINUE_CHAT,
  // which writes the result to storage.local.test_data_messages — a key the upstream
  // sidepanel reads on mount and hydrates into its React/Zustand conversation store).
  // Capture dropped the data the API requires for STRUCTURAL replay (tool_use has no id,
  // tool_result no tool_use_id, thinking no signature, image no source) — seeding those
  // blocks verbatim makes the next /v1/messages request 400. So we FLATTEN every non-text
  // block to descriptive text, preserving turn order, then merge consecutive same-role
  // turns so roles strictly alternate (the Messages API rejects adjacent same-role msgs).
  const FLAT_CAP = 60000; // bound a flattened turn (blocks were already capped at capture)
  self.czChatToStoreMessages = (chat) => {
    if (!chat || !Array.isArray(chat.messages)) return [];
    const flat = [];
    for (const m of chat.messages) {
      const role = (m && m.role === 'assistant') ? 'assistant' : 'user';
      let text = '';
      if (typeof m.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m.content)) {
        const parts = [];
        for (const b of m.content) {
          if (!b || !b.type) continue;
          if (b.type === 'text') parts.push(b.text || '');
          else if (b.type === 'thinking') parts.push('💭 [thinking] ' + (b.text || ''));
          else if (b.type === 'tool_use') { let j = '{}'; try { j = JSON.stringify(b.input || {}); } catch {} parts.push('🔧 [tool: ' + (b.name || 'tool') + '] ' + j); }
          else if (b.type === 'tool_result') parts.push((b.is_error ? '⚠️ [tool error] ' : '✅ [tool result] ') + (b.content || ''));
          // image: dropped (no source data was captured)
        }
        text = parts.filter((s) => s !== '').join('\n\n');
      }
      text = String(text || '').trim();
      if (text.length > FLAT_CAP) text = text.slice(0, FLAT_CAP) + '… [truncated]';
      // Keep a placeholder rather than dropping an empty turn — dropping one would put two
      // same-role turns next to each other and break alternation.
      flat.push({ role, content: text || '·' });
    }
    if (chat.lastReply) flat.push({ role: 'assistant', content: trunc(chat.lastReply) });
    // Merge consecutive same-role turns → strict alternation.
    const out = [];
    for (const msg of flat) {
      const last = out[out.length - 1];
      if (last && last.role === msg.role) last.content += '\n\n' + msg.content;
      else out.push({ role: msg.role, content: msg.content });
    }
    return out;
  };

  // One-shot guard: the bundle's on-mount loader reads storage.local.test_data_messages
  // and hydrates the live conversation, but never clears it. After "Continue" seeds it,
  // clear it shortly after the loader (~100ms) has consumed it, so a manual sidebar reload
  // doesn't silently re-hydrate the same transcript. Sidepanel context only.
  try {
    if (/sidepanel\.html$/.test(location.pathname)) {
      setTimeout(() => {
        store.get('test_data_messages').then((o) => {
          const v = o && o.test_data_messages;
          if (Array.isArray(v) && v.length) store.remove('test_data_messages').catch(() => {});
        }).catch(() => {});
      }, 1500);
    }
  } catch {}
})();

// ── Debug mirror: tee the chat to the console ─────────────────────────────────
// Optional dev aid. When enabled, mirrors everything that flows through the chat
// to the console: outgoing user turns and tool results (from the request body),
// and the assistant's text, thinking blocks, and tool_use calls WITH their args
// (parsed from the streaming SSE response). This complements the bundle's own
// "[Computer Tool]" logs (PermissionManager-*.js), which only cover tool execution.
// Non-destructive: the response is read via resp.clone(), so the bundle still gets
// the untouched original stream. Toggle from the sidepanel console (right-click the
// sidebar → Inspect, or about:debugging → this Firefox → Inspect):
//     czDebug()        // enable
//     czDebug(false)   // disable
// State persists in storage.local.__czDebugMirror and propagates across contexts.
(function () {
  const api = (typeof browser !== 'undefined' ? browser : chrome);
  const store = (api && api.storage && api.storage.local) || null;
  const FLAG = '__czDebugMirror';
  let enabled = false;

  const C = {
    user:   'color:#2563eb;font-weight:bold',
    text:   'color:#16a34a',
    think:  'color:#9333ea;font-style:italic',
    tool:   'color:#d97706;font-weight:bold',
    result: 'color:#0891b2',
    meta:   'color:#6b7280',
  };
  const trunc = (s, n = 4000) => {
    s = (s == null) ? '' : String(s);
    return s.length > n ? s.slice(0, n) + `… [+${s.length - n} chars]` : s;
  };
  const log = (kind, msg) => {
    try { console.log(`%c[claude-zen][chat] ${msg}`, C[kind] || C.meta); } catch {}
    try { if (self.czLog) self.czLog(kind, msg); } catch {} // persist for later debugging
  };
  const banner = () => log('meta', 'chat mirror enabled — thoughts, tool calls & results will print here');

  // Parse the Anthropic SSE stream (a clone) and print each block once it completes.
  async function parseStream(stream) {
    const reader = stream.getReader();
    const dec = new TextDecoder();
    const blocks = {};
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          handleEvent(buf.slice(0, i), blocks);
          buf = buf.slice(i + 2);
        }
      }
    } catch {}
  }

  function handleEvent(raw, blocks) {
    let data = '';
    for (const ln of raw.split('\n')) if (ln.startsWith('data:')) data += ln.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let ev; try { ev = JSON.parse(data); } catch { return; }
    switch (ev.type) {
      case 'message_start':
        log('meta', `▶ message start${ev.message && ev.message.model ? ' — ' + ev.message.model : ''}`);
        break;
      case 'content_block_start': {
        const b = ev.content_block || {};
        blocks[ev.index] = { type: b.type, text: '', json: '', name: b.name };
        if (b.type === 'tool_use') log('tool', `🔧 tool call: ${b.name}`);
        break;
      }
      case 'content_block_delta': {
        const b = blocks[ev.index] || (blocks[ev.index] = { type: '', text: '', json: '' });
        const d = ev.delta || {};
        if (d.type === 'text_delta') b.text += d.text || '';
        else if (d.type === 'thinking_delta') b.text += d.thinking || '';
        else if (d.type === 'input_json_delta') b.json += d.partial_json || '';
        break;
      }
      case 'content_block_stop': {
        const b = blocks[ev.index]; if (!b) break;
        if (b.type === 'thinking') log('think', `💭 thinking:\n${trunc(b.text)}`);
        else if (b.type === 'text') log('text', `💬 assistant:\n${trunc(b.text)}`);
        else if (b.type === 'tool_use') {
          let input = b.json;
          try { input = JSON.stringify(JSON.parse(b.json || '{}'), null, 2); } catch {}
          log('tool', `🔧 ${b.name || 'tool'} args:\n${trunc(input)}`);
        }
        delete blocks[ev.index];
        break;
      }
      case 'message_delta':
        if (ev.delta && ev.delta.stop_reason)
          log('meta', `■ stop: ${ev.delta.stop_reason}${ev.usage ? ' · usage ' + JSON.stringify(ev.usage) : ''}`);
        break;
      case 'message_stop':
        log('meta', '■ message complete');
        break;
      case 'error':
        log('meta', `⚠ error: ${trunc(JSON.stringify(ev.error || ev))}`);
        break;
    }
  }

  // Print the newest message in an outgoing request body (user input + tool results).
  function printRequest(bodyStr) {
    let obj; try { obj = JSON.parse(bodyStr); } catch { return; }
    if (!obj || !Array.isArray(obj.messages) || !obj.messages.length) return;
    const last = obj.messages[obj.messages.length - 1];
    if (!last) return;
    const role = last.role || 'user';
    if (typeof last.content === 'string') { log('user', `👤 ${role}:\n${trunc(last.content)}`); return; }
    if (!Array.isArray(last.content)) return;
    for (const c of last.content) {
      if (!c || !c.type) continue;
      if (c.type === 'text') log('user', `👤 ${role}: ${trunc(c.text)}`);
      else if (c.type === 'image') log('user', '👤 [image]');
      else if (c.type === 'tool_result') {
        let body = c.content;
        if (Array.isArray(body))
          body = body.map(x => x && x.type === 'text' ? x.text
            : x && x.type === 'image' ? '[image]' : `[${(x && x.type) || '?'}]`).join('\n');
        log('result', `✅ tool result${c.is_error ? ' [ERROR]' : ''}${c.tool_use_id ? ' (' + c.tool_use_id + ')' : ''}:\n${trunc(body)}`);
      }
    }
  }

  // Public hooks called by the window.fetch wrapper above.
  self.__czDebug = {
    get enabled() { return enabled; },
    logRequest(input, init) {
      try {
        const body = init && init.body;
        if (typeof body === 'string') { printRequest(body); return; }
        // Request object: read a clone so the real body isn't consumed.
        if (input && typeof input.clone === 'function') {
          input.clone().text().then(printRequest).catch(() => {});
        }
      } catch {}
    },
    tee(resp) {
      try {
        const ct = (resp.headers && resp.headers.get('content-type')) || '';
        if (!resp.body || !/event-stream/.test(ct)) return;
        parseStream(resp.clone().body).catch(() => {});
      } catch {}
    },
  };

  // Console toggle: czDebug() → on, czDebug(false) → off.
  self.czDebug = function (on) {
    enabled = (on === undefined) ? true : !!on;
    if (store) { try { store.set({ [FLAG]: enabled }); } catch {} }
    log('meta', `mirror ${enabled ? 'ON' : 'OFF'}`);
    return enabled;
  };

  // Load the persisted flag and react to toggles from other contexts.
  if (store) { try { store.get(FLAG).then((o) => { if (o && o[FLAG]) { enabled = true; banner(); } }); } catch {} }
  try {
    api.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch && ch[FLAG]) { enabled = !!ch[FLAG].newValue; if (enabled) banner(); }
    });
  } catch {}
})();

// ── Token savers: text-first steering + screenshot downscale ───────────────────
// Two independent knobs to cut the agent's token spend, both Layer-2 (survive
// update-from-store.ps1 since they live in this shim, not the bundle):
//
//   1) Text-first steering (__czPreferText, default ON). The upstream system prompt
//      pushes the model to screenshot for everything; screenshots are base64 images
//      (~w*h/750 tokens each — the bulk of a session's cost). The bundle ALREADY ships
//      cheap text observers — read_page (accessibility tree w/ ref_ids, see
//      assets/accessibility-tree.js), get_page_text, find — so we append a system
//      block steering the model to prefer them and screenshot only when it must SEE
//      pixels. Appended AFTER the bundle's system blocks so the cached prefix still
//      hits (the extra block is ~90 tokens, uncached, negligible vs an image).
//
//   2) Screenshot downscale (__czShotScale, default 1 = OFF/no change). Image tokens
//      scale with PIXEL count, not file size, so JPEG quality buys nothing — only
//      fewer pixels do. Capturing at scale s shrinks the image (and its token cost)
//      by ~s², but the model then picks click coords in that smaller space, so the
//      CDP mouse handler divides incoming coords by the scale the tab was last shot
//      at (__czShotScaleByTab). Coordinate remapping is the exact class of bug this
//      port has fought, so this stays opt-in; default 1 changes nothing.
//
// Toggles (sidepanel/background console): czPreferText(true|false), czShotScale(0.3..1).
(function () {
  const api = (typeof browser !== 'undefined' ? browser : chrome);
  const store = (api && api.storage && api.storage.local) || null;
  const PT = '__czPreferText', SS = '__czShotScale';

  let preferText = true;            // default ON
  self.__czShotScale = 1;           // default OFF (no downscale)
  self.__czShotScaleByTab = Object.create(null); // tabId → scale actually used for its last shot

  // Tools whose presence marks the real agent request (vs cosmetic title/status /
  // find-helper /messages calls, which carry no browser tools → must NOT be steered).
  const BROWSER_TOOLS = ['read_page', 'get_page_text', 'find', 'computer', 'screenshot', 'navigate', 'click'];
  const MARK = 'cz-token-saver'; // idempotency marker inside the injected block
  const STEER =
    '[' + MARK + '] Token efficiency — observe the page with the TEXT tools first. ' +
    'Prefer `read_page` (accessibility tree with ref_ids for clicking), `get_page_text`, ' +
    'and `find` to read content, locate elements, and verify that an action worked. ' +
    'They cost a fraction of a screenshot and are usually sufficient. ' +
    'Use `screenshot`/`computer` ONLY when you genuinely need to see pixels — visual ' +
    'layout or styling, canvas/video/image content, or when a text read was not enough. ' +
    'Do NOT screenshot after every action just to confirm it; a `read_page` confirms it more cheaply.';

  function hasBrowserTools(o) {
    return Array.isArray(o.tools) && o.tools.some(t => t && BROWSER_TOOLS.includes(t.name));
  }
  function alreadySteered(sys) {
    if (typeof sys === 'string') return sys.includes(MARK);
    if (Array.isArray(sys)) return sys.some(b => b && typeof b.text === 'string' && b.text.includes(MARK));
    return false;
  }
  function withSteer(sys) {
    const block = { type: 'text', text: STEER };
    if (sys == null) return [block];
    if (typeof sys === 'string') return [{ type: 'text', text: sys }, block];
    if (Array.isArray(sys)) return sys.concat([block]);
    return sys; // unknown shape → leave untouched
  }

  // Returns {input, init} with a mutated body, or null to send the original unchanged.
  // Only the string-body-in-init path (the Anthropic SDK's path) is handled; the
  // Request-object path would need async reconstruction and isn't used by the SDK.
  self.czSteerBody = function (input, init) {
    if (!preferText) return null;
    if (!init || typeof init.body !== 'string') return null;
    let o; try { o = JSON.parse(init.body); } catch { return null; }
    if (!o || !Array.isArray(o.messages) || !hasBrowserTools(o)) return null;
    if (alreadySteered(o.system)) return null;
    o.system = withSteer(o.system);
    return { input, init: { ...init, body: JSON.stringify(o) } };
  };

  // Console toggles.
  self.czPreferText = function (on) {
    preferText = (on === undefined) ? true : !!on;
    if (store) { try { store.set({ [PT]: preferText }); } catch {} }
    console.log('[claude-zen] text-first steering ' + (preferText ? 'ON' : 'OFF'));
    return preferText;
  };
  self.czShotScale = function (n) {
    n = Number(n); if (!isFinite(n) || n <= 0) n = 1;
    n = Math.max(0.3, Math.min(1, n));
    self.__czShotScale = n;
    if (store) { try { store.set({ [SS]: n }); } catch {} }
    console.log('[claude-zen] screenshot scale = ' + n + (n < 1 ? ' (downscaled — clicks remapped)' : ' (full size)'));
    return n;
  };

  // Load persisted values + react to toggles from other contexts.
  if (store) {
    try { store.get([PT, SS]).then((o) => {
      if (o && typeof o[PT] === 'boolean') preferText = o[PT];
      if (o && typeof o[SS] === 'number' && o[SS] > 0) self.__czShotScale = Math.max(0.3, Math.min(1, o[SS]));
    }); } catch {}
  }
  try {
    api.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch) return;
      if (ch[PT] && typeof ch[PT].newValue === 'boolean') preferText = ch[PT].newValue;
      if (ch[SS] && typeof ch[SS].newValue === 'number' && ch[SS].newValue > 0) self.__czShotScale = Math.max(0.3, Math.min(1, ch[SS].newValue));
    });
  } catch {}
})();

// ── Persistent session log (save to computer for later debugging) ──────────────
// A ring buffer in storage.local that survives reloads and merges entries from EVERY
// context (background + sidepanel). Records the decisive automation signals — every
// [cdp] click/key result (miss / disabled / domMutations / reachedDoc / defaultPrevented),
// errors, and (when czDebug is on) the assistant's thinking / tool calls / results — so a
// failed "Claude thinks it clicked but nothing happened" run can be analysed AFTER the
// fact instead of needing live console capture.
//   self.czLog(category, text)  — append (used by the shims; cdp entries are always kept)
//   self.czDumpLog()            — download the whole log as a .log file (downloads API)
//   self.czClearLog()           — wipe it
(function () {
  const api = (typeof browser !== 'undefined' ? browser : chrome);
  const store = (api && api.storage && api.storage.local) || null;
  const KEY = '__czSessionLog';
  const CAP = 4000; // max entries kept (oldest dropped)
  const ctx = (typeof location !== 'undefined' && /sidepanel\.html$/.test(location.pathname || '')) ? 'side'
            : (typeof location !== 'undefined' && /_generated_background_page\.html$/.test(location.pathname || '')) ? 'bg'
            : 'page';
  let pending = [];
  let timer = null;

  const flush = async () => {
    timer = null;
    if (!pending.length || !store) return;
    const mine = pending; pending = [];
    try {
      const o = await store.get(KEY);
      let arr = (o && Array.isArray(o[KEY])) ? o[KEY] : [];
      arr = arr.concat(mine);
      if (arr.length > CAP) arr = arr.slice(-CAP);
      await store.set({ [KEY]: arr });
    } catch { pending = mine.concat(pending); } // put back, retry on next tick
  };

  self.czLog = function (cat, text) {
    try {
      pending.push({ t: Date.now(), c: ctx, k: String(cat || 'log'), m: String(text == null ? '' : text).slice(0, 8000) });
      if (!timer) timer = setTimeout(flush, 1000);
    } catch {}
  };

  self.czDumpLog = async function () {
    await flush();
    let all = [];
    try { if (store) { const o = await store.get(KEY); if (o && Array.isArray(o[KEY])) all = o[KEY]; } } catch {}
    const lines = all.slice().sort((a, b) => a.t - b.t)
      .map((e) => `${new Date(e.t).toISOString()} [${e.c}] [${e.k}] ${e.m}`).join('\n');
    const url = URL.createObjectURL(new Blob([lines || '(empty)'], { type: 'text/plain' }));
    const filename = `claude-zen-session-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    try {
      if (api.downloads && api.downloads.download) await api.downloads.download({ url, filename, saveAs: true });
      else if (typeof document !== 'undefined') { const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); }
    } catch (e) { console.warn('[claude-zen] czDumpLog failed:', e && e.message); }
    setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 60000);
    return `${all.length} entries → ${filename}`;
  };

  self.czClearLog = function () { pending = []; if (store) { try { store.set({ [KEY]: [] }); } catch {} } return 'session log cleared'; };
})();

// ── chrome.tabs.query: Firefox sidebar workaround ─────────────────────────────
// In Firefox sidebar context, tabs.query({active:true,currentWindow:true})
// returns [] — the sidebar's window is treated as having no tabs of its own.
// The Chrome bundle relies on this query to find the user's active tab and
// throws "No active tab" otherwise (sidepanel handleKeyDown → Me).
// Strategy: if the native query returns empty, fall back to querying without
// the window filter and pick the active tab in the most-recently-focused
// normal browser window.
if (chrome.tabs && chrome.tabs.query) {
  const _origTabsQuery = chrome.tabs.query.bind(chrome.tabs);
  chrome.tabs.query = function (queryInfo, callback) {
    const wantsActive = queryInfo && queryInfo.active === true;
    const hasWindowFilter = queryInfo &&
      (queryInfo.currentWindow === true || queryInfo.lastFocusedWindow === true);

    if (!(wantsActive && hasWindowFilter)) {
      if (typeof callback === 'function') return _origTabsQuery(queryInfo, callback);
      return _origTabsQuery(queryInfo);
    }

    const handle = async () => {
      // 1. Native first — may work in background or in a normal extension page
      let tabs;
      try { tabs = await _origTabsQuery(queryInfo); } catch { tabs = []; }
      if (tabs && tabs.length > 0) return tabs;

      // 2. Drop window filter, ask for active tabs anywhere
      const noWin = { ...queryInfo };
      delete noWin.currentWindow;
      delete noWin.lastFocusedWindow;
      let allActive;
      try { allActive = await _origTabsQuery(noWin); } catch { allActive = []; }
      if (!allActive || allActive.length === 0) return [];

      // 3. Prefer the tab in the most-recently-focused normal browser window
      try {
        if (chrome.windows && chrome.windows.getLastFocused) {
          const w = await new Promise((resolve) => {
            try {
              const r = chrome.windows.getLastFocused(
                { windowTypes: ['normal'] },
                (win) => resolve(win)
              );
              if (r && typeof r.then === 'function') r.then(resolve, () => resolve(null));
            } catch { resolve(null); }
          });
          if (w && typeof w.id === 'number') {
            const matched = allActive.filter((t) => t.windowId === w.id);
            if (matched.length > 0) return matched;
          }
        }
      } catch {}

      // 4. Last resort: drop tabs in extension/internal pages
      const normal = allActive.filter((t) =>
        t.url &&
        !t.url.startsWith('moz-extension://') &&
        !t.url.startsWith('about:') &&
        !t.url.startsWith('chrome://')
      );
      return normal.length > 0 ? normal : allActive;
    };

    if (typeof callback === 'function') {
      handle().then(callback, () => { try { callback([]); } catch {} });
      return;
    }
    return handle();
  };
}

// ── chrome.tabs.create / windows.create: Chrome new-tab URL → Firefox ─────────
// The upstream bundle opens scratch tabs with url:"chrome://newtab" (Chrome's
// new-tab page) in tabs_create, browser_batch's tabs_create, and the session-group
// fallback paths. Firefox rejects that scheme — "Illegal URL: chrome://newtab" —
// so every new-tab creation fails (observed: "open two tabs" could open only one).
// chrome:// is privileged in Firefox; there is no settable equivalent of Chrome's
// new-tab URL, so we drop the url entirely and let Firefox open its native new tab
// (the bundle navigates it immediately afterwards anyway).
(function () {
  const NEWTAB = /^chrome:\/\/(newtab|new-tab-page)\/?$/i;
  const fix = (o) => {
    if (o && typeof o.url === 'string' && NEWTAB.test(o.url)) {
      const c = { ...o };
      delete c.url;
      return c;
    }
    return o;
  };
  if (chrome.tabs && typeof chrome.tabs.create === 'function') {
    const _create = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = function (opts, cb) {
      return (typeof cb === 'function') ? _create(fix(opts), cb) : _create(fix(opts));
    };
  }
  if (chrome.windows && typeof chrome.windows.create === 'function') {
    const _wcreate = chrome.windows.create.bind(chrome.windows);
    chrome.windows.create = function (opts, cb) {
      return (typeof cb === 'function') ? _wcreate(fix(opts), cb) : _wcreate(fix(opts));
    };
  }
})();

// ── Pending-URL tracking: emulate Chrome's tab.pendingUrl for about:* tabs ─────
// Firefox reports a freshly created / still-navigating tab's url as "about:blank" /
// "about:newtab" until the navigation COMMITS, and `new URL("about:blank").host`
// is "" — empty. The bundle's permission flow keys every grant on that host
// (PermissionManager.findApplicablePermission requires a TRUTHY netloc), so when a
// tool ran against a tab whose navigation hadn't committed yet:
//   • the permission prompt showed "this page" and every user click ("Allow once"/
//     "Always allow") stored a dead {netloc:""} grant that can never match;
//   • the post-grant retry re-checked the same empty host and threw
//     "Permission still required after granting" — an unbreakable loop.
// Chrome doesn't hit this because chrome://newtab parses with host "newtab" and
// tabs expose `pendingUrl` during navigation. We emulate the useful part: record
// the target URL whenever the bundle creates/navigates a tab, and have the
// tabs.get/query overlay report it as the tab's url while the native url is still
// about:*-ish. (Entries expire after 45s or as soon as a real URL commits.)
(function () {
  const PENDING_TTL = 45000;
  const BLANKISH = /^about:(blank|newtab|home|privatebrowsing)?$/i;
  const pending = new Map(); // tabId → { url, ts }

  self.__czRecordPendingUrl = (tabId, url) => {
    if (typeof tabId === 'number' && typeof url === 'string' && /^https?:/i.test(url)) {
      pending.set(tabId, { url, ts: Date.now() });
    }
  };
  // Mutates the tab object in place; safe on overlay copies.
  self.__czApplyPendingUrl = (t) => {
    if (!t || typeof t.id !== 'number') return t;
    const p = pending.get(t.id);
    if (!p) return t;
    if (Date.now() - p.ts > PENDING_TTL || (t.url && !BLANKISH.test(t.url))) {
      pending.delete(t.id); // committed (or stale) — native url wins again
      return t;
    }
    if (!t.url || BLANKISH.test(t.url)) {
      t.url = p.url;
      t.pendingUrl = p.url;
      if (!t.status) t.status = 'loading';
    }
    return t;
  };

  if (chrome.tabs && typeof chrome.tabs.update === 'function') {
    const _update = chrome.tabs.update.bind(chrome.tabs);
    chrome.tabs.update = function (...args) {
      // Signature: update([tabId], props, [cb]) — record only the explicit-tabId form.
      if (typeof args[0] === 'number' && args[1] && typeof args[1].url === 'string') {
        self.__czRecordPendingUrl(args[0], args[1].url);
      }
      return _update(...args);
    };
  }
  if (chrome.tabs && typeof chrome.tabs.create === 'function') {
    const _create = chrome.tabs.create.bind(chrome.tabs); // newtab-fix wrapper above
    chrome.tabs.create = function (opts, cb) {
      const url = opts && typeof opts.url === 'string' ? opts.url : null;
      const tag = (tab) => { if (tab && url) self.__czRecordPendingUrl(tab.id, url); return tab; };
      if (typeof cb === 'function') return _create(opts, (tab) => cb(tag(tab)));
      return _create(opts).then(tag);
    };
  }
})();

// ── Firefox: inject ?tabId=N into sidepanel URL before bundle loads ──────────
// Chrome's bundle reads tabId from `sidepanel.html?tabId=N` (URL param set by
// chrome.sidePanel.setOptions at click time). Firefox's sidebar has a single
// persistent URL — there is no per-tab routing — so the bundle reads undefined,
// the active-tab state `c` stays empty, and any user action throws "No active tab".
//
// The bundle's <script> tag in sidepanel.html is given type="firefox-deferred-module"
// (an unknown type the browser ignores). We resolve the active tab, write
// ?tabId=N via history.replaceState (no navigation), then create a real
// <script type="module"> with the same src so the bundle finally runs with
// the parameter present.
//
// Must run AFTER the chrome.tabs.query patch (above) because the Promise
// constructor calls chrome.tabs.query synchronously.
if (typeof document !== 'undefined' &&
    typeof window !== 'undefined' &&
    document.location.pathname.endsWith('/sidepanel.html')) {
  (function () {
    const LOG = '[claude-zen sidepanel]';
    let released = false;
    let asyncDone = false;
    let domDone = (document.readyState !== 'loading');

    // Secondary safety net: once we know the active tab, expose it so that
    // URLSearchParams("...").get("tabId") returns it even if replaceState
    // somehow didn't stick. The deferred-module loading guarantees this cache
    // is populated before any bundle code reads the URL.
    const _origGet = URLSearchParams.prototype.get;
    URLSearchParams.prototype.get = function (key) {
      const v = _origGet.call(this, key);
      if ((v === null || v === undefined) && key === 'tabId' && window.__ffActiveTabId != null) {
        return String(window.__ffActiveTabId);
      }
      return v;
    };

    const tryRelease = () => {
      if (released || !asyncDone || !domDone) return;
      released = true;
      const deferred = document.querySelectorAll('script[type="firefox-deferred-module"]');
      console.log(`${LOG} releasing ${deferred.length} deferred module script(s); tabId=${window.__ffActiveTabId}`);
      deferred.forEach((node) => {
        const src = node.src;
        const co = node.getAttribute('crossorigin');
        const s = document.createElement('script');
        s.type = 'module';
        if (co !== null) s.setAttribute('crossorigin', co);
        s.src = src;
        node.parentNode.insertBefore(s, node);
        node.remove();
      });
    };

    if (!domDone) {
      document.addEventListener('DOMContentLoaded', () => {
        domDone = true;
        tryRelease();
      }, { once: true });
    }

    (async () => {
      try {
        const sp = new URLSearchParams(window.location.search);
        // Skip injection for mode=window — the bundle resolves tabId from
        // storage.TARGET_TAB_ID in that case (used for scheduled-task popups).
        if (!sp.has('tabId') && sp.get('mode') !== 'window') {
          const tabs = await new Promise((resolve) => {
            try {
              const r = chrome.tabs.query(
                { active: true, lastFocusedWindow: true },
                (t) => resolve(t || [])
              );
              if (r && typeof r.then === 'function') r.then(resolve, () => resolve([]));
            } catch { resolve([]); }
          });
          console.log(`${LOG} tabs.query returned ${(tabs || []).length} tab(s)`, (tabs || []).map((t) => ({ id: t.id, url: (t.url || '').slice(0, 50) })));
          const normal = (tabs || []).filter((t) =>
            t.url &&
            !t.url.startsWith('moz-extension://') &&
            !t.url.startsWith('about:') &&
            !t.url.startsWith('chrome://')
          );
          const pick = normal[0] || (tabs || [])[0];
          if (pick && pick.id != null) {
            window.__ffActiveTabId = pick.id;
            const url = new URL(window.location.href);
            url.searchParams.set('tabId', String(pick.id));
            try { history.replaceState({}, '', url); } catch (e) { console.warn(`${LOG} replaceState failed`, e); }
            console.log(`${LOG} active tabId resolved: ${pick.id}`);
            // Put the main tab in a Claude group so newly created tabs can join it
            // and pass the bundle's same-group access gate (see __ffEnsureMainGroup).
            try { if (self.__ffEnsureMainGroup) await self.__ffEnsureMainGroup(pick.id); } catch {}
          } else {
            console.warn(`${LOG} could not resolve an active tab — bundle may show "No active tab"`);
          }
        }
      } catch (e) {
        console.warn(`${LOG} tabId injection error`, e);
      }
      asyncDone = true;
      tryRelease();
    })();

    // Safety net — release after 2 s even if the tab fetch hangs
    setTimeout(() => {
      asyncDone = true;
      tryRelease();
    }, 2000);
  })();
}

// ── Tab Groups (HYBRID: native on FF 139+, storage-emulation fallback) ────────
// Chrome's bundle uses real OS tab groups to corral the tabs Claude drives, and
// re-finds them on invoke via tabs.query({groupId}) / tab.groupId / tabGroups.*.
// It only ever acts on tabs whose group matches the session's group (bailing when
// tab.groupId === TAB_GROUP_ID_NONE), so the group IS the access boundary.
//
// The hard problem on Firefox: native chrome.tabs.group (FF 139+) REFUSES to group
// privileged/extension pages (moz-extension://, about:*, chrome://). Claude's "main
// tab" is very often exactly that (e.g. a new-tab-page override), and freshly
// created scratch tabs open at about:newtab. If we used the native API blindly,
// createGroup(mainTab) throws → no group is ever created → every new tab is "not in
// the same group" and the agent can't control it (and "No group found for main tab").
//
// So we run a HYBRID with the storage registry as the unified source of truth for
// membership:
//   • groupable web tab  → create a REAL, visible native group; mirror it in the
//                          registry (native:true) so queries stay consistent.
//   • privileged tab / native rejection / FF ≤138 → emulate a LOGICAL group with a
//                          negative id (never collides with native +ve ids or NONE).
// chrome.tabs.get/query are overlaid so a tab's groupId comes from the registry when
// Claude manages it, else from the native value — so both real and emulated groups,
// plus user-made native groups, all report consistently. The registry lives in
// storage.session (shared bg+sidepanel, survives SW unload, cleared on restart).
(function () {
  const api = (typeof browser !== 'undefined' ? browser : chrome);
  const store = api.storage && (api.storage.session || api.storage.local);
  const NONE = -1;
  const K_META = '__ffGroupMeta', K_MEMB = '__ffTabGroup', K_SEQ = '__ffGroupSeq';
  // Detect the background context. On Chrome MV3 the background is a service worker
  // (no `document`). On FIREFOX MV3 the background is a real DOM page (document EXISTS),
  // so the old `typeof document === 'undefined'` test was always false there — meaning
  // the background-only listeners (visual promotion, onRemoved pruning) NEVER installed.
  // Identify Firefox's background by its generated page URL / getBackgroundPage identity.
  const isBackground = (() => {
    if (typeof document === 'undefined') return true;            // Chrome MV3 service worker
    try {
      if (typeof location !== 'undefined' &&
          /_generated_background_page\.html$/.test(location.pathname || '')) return true;
    } catch {}
    try {
      if (chrome.extension && typeof chrome.extension.getBackgroundPage === 'function' &&
          chrome.extension.getBackgroundPage() === window) return true;
    } catch {}
    return false;
  })();

  // FF 139+ exposes chrome.tabGroups + chrome.tabs.group natively.
  const nativeGroups = (typeof chrome.tabGroups !== 'undefined' &&
                        typeof chrome.tabGroups.TAB_GROUP_ID_NONE === 'number');

  // Capture natives BEFORE we override anything. group/ungroup come from `browser`
  // (Promise-based); get/query are the already-installed sidebar-aware wrappers.
  const _natGroup   = (api.tabs && typeof api.tabs.group === 'function')   ? api.tabs.group.bind(api.tabs)   : null;
  const _natUngroup = (api.tabs && typeof api.tabs.ungroup === 'function') ? api.tabs.ungroup.bind(api.tabs) : null;
  const _natGet     = chrome.tabs ? chrome.tabs.get.bind(chrome.tabs)      : null;
  const _natQuery   = chrome.tabs ? chrome.tabs.query.bind(chrome.tabs)    : null;
  const _natTgGet    = (chrome.tabGroups && chrome.tabGroups.get)    ? chrome.tabGroups.get.bind(chrome.tabGroups)    : null;
  const _natTgUpdate = (chrome.tabGroups && chrome.tabGroups.update) ? chrome.tabGroups.update.bind(chrome.tabGroups) : null;

  // CRITICAL: tabs.group() shipped in Firefox 138; the tabGroups *namespace*
  // (TAB_GROUP_ID_NONE, tabGroups.update for title/color) only in Firefox 139.
  // Gate the creation of VISIBLE native groups on the method (canGroup), NOT on the
  // namespace (nativeGroups) — otherwise FF 138 users get no visible group at all.
  // nativeGroups stays the gate only for the title/color overlay (FF 139+).
  const canGroup = typeof _natGroup === 'function';

  // Zen Browser's native tab groups "work poorly", and its pinned-tab FOLDERS have no
  // WebExtension API. So in Zen we run REGISTRY-ONLY (emulated): skip native visual groups
  // entirely. Membership / threads / the access gate are unaffected (they read the
  // registry), and Claude tabs are marked another way — a "◆ " tab-title prefix applied by
  // firefox-thread-jump.js on emulated members. `nativeAllowed()` is the runtime gate
  // everything checks instead of `canGroup`; gating `isGroupable` on it makes BOTH group
  // creation and the visual-promotion listener fall back to emulated automatically.
  // emulatedMode is resolved async just after startup (group creation happens later, when a
  // session starts, so it's set by then).
  let emulatedMode = false;
  const nativeAllowed = () => canGroup && !emulatedMode;
  if (isBackground) {
    try {
      console.log('[claude-zen][groups] init',
        'ff=' + (((typeof navigator !== 'undefined' && navigator.userAgent) || '').match(/Firefox\/[\d.]+/) || ['?'])[0],
        'tabs.group=' + canGroup, 'tabGroups.ns=' + nativeGroups, 'tabGroups.update=' + !!_natTgUpdate);
    } catch {}
  }

  // Resolve emulatedMode: a manual override (storage.local.__czPreferEmulatedGroups —
  // true=force emulated, false=force native) wins; otherwise auto-detect Zen. Detection is
  // best-effort (Zen often keeps a Firefox UA) — getBrowserInfo() name/vendor + a UA scan;
  // the manual override / czEmulateGroups() is the reliable escape hatch if it misses.
  (async () => {
    try {
      const lstore = api.storage && api.storage.local; // toggle must survive restart → local
      let forced;
      try { const o = lstore && await lstore.get('__czPreferEmulatedGroups'); forced = o && o.__czPreferEmulatedGroups; } catch {}
      if (forced === true || forced === false) {
        emulatedMode = forced;
      } else {
        let zen = false;
        try { if (/\bzen\b/i.test((typeof navigator !== 'undefined' && navigator.userAgent) || '')) zen = true; } catch {}
        try {
          if (!zen && api.runtime && api.runtime.getBrowserInfo) {
            const bi = await api.runtime.getBrowserInfo();
            if (/zen/i.test(((bi && bi.name) || '') + ' ' + ((bi && bi.vendor) || ''))) zen = true;
          }
        } catch {}
        emulatedMode = zen;
      }
    } catch {}
    self.__ffEmulatedGroups = emulatedMode;
    if (isBackground) console.log('[claude-zen][groups] emulatedMode=' + emulatedMode + (emulatedMode ? ' (Zen/registry-only — no native groups; Claude tabs marked via ◆ title prefix)' : ''));
  })();

  // Console helper: force emulated grouping on/off (persists; reload for full effect).
  self.czEmulateGroups = function (on) {
    const v = (on === undefined) ? true : !!on;
    emulatedMode = v; self.__ffEmulatedGroups = v;
    try { if (api.storage && api.storage.local) api.storage.local.set({ __czPreferEmulatedGroups: v }); } catch {}
    console.log('[claude-zen][groups] emulatedMode → ' + v + ' (reload the extension for full effect)');
    return v;
  };

  // Tabs showing these schemes cannot be placed in a native Firefox tab group.
  const PRIVILEGED = /^(moz-extension|chrome-extension|about|chrome|view-source|data|resource|file):/i;
  const isGroupable = async (id) => {
    if (!nativeAllowed() || !_natGet) return false;
    try {
      const t = await _natGet(id);
      // Pinned tabs (incl. Zen's "essential"/pinned tabs) live OUTSIDE the normal tab
      // strip; native tabs.group()/move() would yank them out of the pinned area into
      // the group's position — visibly un-pinning the user's tab. Treat pinned like a
      // privileged page: keep it in the registry (emulated) so the agent still controls
      // its tabs, but never physically group/move it. (Verified against Zen pinned tabs.)
      if (t && t.pinned) return false;
      const u = t && t.url; return !!u && !PRIVILEGED.test(u);
    }
    catch { return false; }
  };

  const getState = async () => {
    if (!store) return { meta: {}, memb: {}, seq: 0 };
    const o = await store.get([K_META, K_MEMB, K_SEQ]);
    return { meta: o[K_META] || {}, memb: o[K_MEMB] || {}, seq: o[K_SEQ] || 0 };
  };
  const save = async (obj) => { if (store) await store.set(obj); };
  const toIds = (x) => (Array.isArray(x) ? x : (x != null ? [x] : [])).map(Number);

  // Emulated (logical) group — negative ids so they never collide with native.
  const emulatedGroup = async (opts = {}) => {
    const ids = toIds(opts.tabIds);
    const st = await getState();
    let gid = opts.groupId;
    if (gid == null || !st.meta[gid]) {
      if (gid == null) {
        gid = (typeof st.seq === 'number' && st.seq <= -1000 ? st.seq : -999) - 1;
        st.seq = gid;
      }
      let windowId;
      try { windowId = (await _natGet(ids[0])).windowId; } catch {}
      st.meta[gid] = { id: gid, title: '', color: 'grey', collapsed: false, windowId, native: false, mainTabId: ids[0] };
    }
    for (const id of ids) st.memb[id] = gid;
    await save({ [K_META]: st.meta, [K_MEMB]: st.memb, [K_SEQ]: st.seq });
    return gid;
  };

  const groupFn = async (opts = {}) => {
    const ids = toIds(opts.tabIds);
    const st = await getState();
    const gid = opts.groupId;

    // Adding to a group Claude already tracks (native-backed or emulated).
    if (gid != null && st.meta[gid]) {
      if (st.meta[gid].native && _natGroup) {
        const ok = [];
        for (const id of ids) if (await isGroupable(id)) ok.push(id);
        if (ok.length) { try { await _natGroup({ tabIds: ok, groupId: gid }); } catch {} }
      }
      for (const id of ids) st.memb[id] = gid;
      await save({ [K_MEMB]: st.memb });
      return gid;
    }

    // Dedup: the bundle's createGroup(mainTab) calls group() with NO groupId whenever it
    // can't find the group in its own (empty) metadata Map — so it tries to make a SECOND
    // native group for a session we already track, racing our promotion and splitting the
    // initial tab away from the new ones. If any incoming tab is already in a registry
    // group, route all of them into THAT group instead of creating a new one.
    if (gid == null) {
      const existing = ids.map((id) => st.memb[id]).find((g) => g != null && st.meta[g]);
      if (existing != null) {
        if (st.meta[existing].native && _natGroup) {
          const ok = [];
          for (const id of ids) if (await isGroupable(id)) ok.push(id);
          if (ok.length) { try { await _natGroup({ tabIds: ok, groupId: existing }); } catch {} }
        }
        for (const id of ids) st.memb[id] = existing;
        await save({ [K_MEMB]: st.memb });
        return existing;
      }
    }

    // New group from groupable tabs → real native group, mirrored into the registry.
    if (gid == null && canGroup && _natGroup) {
      let allOk = ids.length > 0;
      for (const id of ids) if (!(await isGroupable(id))) { allOk = false; break; }
      if (allOk) {
        try {
          const ngid = await _natGroup(opts);
          let windowId;
          try { windowId = (await _natGet(ids[0])).windowId; } catch {}
          const fresh = await getState();
          fresh.meta[ngid] = { id: ngid, title: '', color: 'grey', collapsed: false, windowId, native: true, mainTabId: ids[0] };
          for (const id of ids) fresh.memb[id] = ngid;
          await save({ [K_META]: fresh.meta, [K_MEMB]: fresh.memb });
          return ngid;
        } catch {}
      }
    }

    // Fallback: privileged tabs, native rejection, or FF ≤138 → emulate.
    return emulatedGroup(opts);
  };

  const ungroupFn = async (tabIds) => {
    const ids = toIds(tabIds);
    const st = await getState();
    const nativeIds = [];
    for (const id of ids) {
      const gid = st.memb[id];
      if (gid != null && st.meta[gid] && st.meta[gid].native) nativeIds.push(id);
      delete st.memb[id];
    }
    await save({ [K_MEMB]: st.memb });
    if (nativeIds.length && _natUngroup) { try { await _natUngroup(nativeIds); } catch {} }
  };

  // Promise/callback adapter matching the WebExtension dual signature.
  const dual = (fn, onErr) => function (...args) {
    const cb = (typeof args[args.length - 1] === 'function') ? args.pop() : null;
    const p = fn(...args);
    if (cb) { p.then((r) => cb(r), () => cb(onErr ? onErr() : undefined)); return; }
    return p;
  };

  if (chrome.tabs) {
    chrome.tabs.group   = dual(groupFn, () => NONE);
    chrome.tabs.ungroup = dual(ungroupFn);

    // Overlay query: registry membership wins; otherwise keep the native groupId.
    // groupId filtering is applied here so it works for native (+ve) and emulated
    // (-ve) ids alike.
    chrome.tabs.query = function (queryInfo, callback) {
      const qi = { ...(queryInfo || {}) };
      const wantGroup = Object.prototype.hasOwnProperty.call(qi, 'groupId');
      const gid = qi.groupId;
      delete qi.groupId;
      const run = async () => {
        let tabs = (await _natQuery(qi)) || [];
        const st = await getState();
        for (const t of tabs) {
          if (t && typeof t.id === 'number') {
            if (st.memb[t.id] != null) t.groupId = st.memb[t.id];
            else if (typeof t.groupId !== 'number') t.groupId = NONE;
            if (self.__czApplyPendingUrl) self.__czApplyPendingUrl(t);
          }
        }
        if (wantGroup) tabs = tabs.filter((t) => t.groupId === gid);
        return tabs;
      };
      if (typeof callback === 'function') { run().then(callback, () => callback([])); return; }
      return run();
    };

    // Overlay get: same precedence — registry first, else native groupId.
    chrome.tabs.get = function (tabId, callback) {
      const run = async () => {
        const t = await _natGet(tabId);
        const st = await getState();
        if (t) {
          if (st.memb[tabId] != null) t.groupId = st.memb[tabId];
          else if (typeof t.groupId !== 'number') t.groupId = NONE;
          if (self.__czApplyPendingUrl) self.__czApplyPendingUrl(t);
        }
        return t;
      };
      if (typeof callback === 'function') { run().then(callback, () => callback(undefined)); return; }
      return run();
    };

    // Prune membership when a tracked tab closes (background owns this once).
    if (isBackground && api.tabs.onRemoved) {
      api.tabs.onRemoved.addListener(async (tabId) => {
        try {
          const st = await getState();
          if (st.memb[tabId] != null) { delete st.memb[tabId]; await save({ [K_MEMB]: st.memb }); }
        } catch {}
      });
    }

    // Prune a MEMBER tab when the USER navigates it away. The agent drives pages by
    // clicking links / submitting forms (transitionType 'link' / 'form_submit') and
    // never types in the address bar — so a top-frame navigation that is 'typed' /
    // 'generated' / a bookmark, or carries the 'from_address_bar' qualifier, means the
    // user repurposed the tab and it has left Claude's control. Drop it from the
    // registry so the "◆ Open in Claude" button (and the access boundary) no longer
    // treat it as part of the thread. The thread's MAIN tab is kept (it anchors the
    // thread for jump-back). Reloads keep the same URL → not treated as "away".
    if (isBackground && api.webNavigation && api.webNavigation.onCommitted) {
      const USER_NAV = /^(typed|generated|keyword|keyword_generated|auto_bookmark)$/;
      api.webNavigation.onCommitted.addListener(async (d) => {
        try {
          if (!d || d.frameId !== 0) return; // top frame only
          const q = d.transitionQualifiers || [];
          const userNav = USER_NAV.test(d.transitionType || '') || q.indexOf('from_address_bar') !== -1;
          if (!userNav) return;
          const st = await getState();
          const gid = st.memb[d.tabId];
          if (gid == null) return;
          if (st.meta[gid] && st.meta[gid].mainTabId === d.tabId) return; // keep thread anchor
          delete st.memb[d.tabId];
          await save({ [K_MEMB]: st.memb });
          console.log('[claude-zen][groups] pruned tab', d.tabId, 'on user navigation away from group', gid);
        } catch {}
      });
    }
  }

  if (nativeGroups && chrome.tabGroups) {
    // Overlay native tabGroups so Claude's groups (real OR emulated) resolve from the
    // registry, while user-made native groups still pass through.
    const _tgGet    = chrome.tabGroups.get    ? chrome.tabGroups.get.bind(chrome.tabGroups)    : null;
    const _tgQuery  = chrome.tabGroups.query  ? chrome.tabGroups.query.bind(chrome.tabGroups)  : null;
    const _tgUpdate = chrome.tabGroups.update ? chrome.tabGroups.update.bind(chrome.tabGroups) : null;
    const _tgMove   = chrome.tabGroups.move   ? chrome.tabGroups.move.bind(chrome.tabGroups)   : null;

    chrome.tabGroups.get = async (id) => {
      const st = await getState();
      if (st.meta[id]) {
        if (st.meta[id].native && _tgGet) { try { return await _tgGet(id); } catch {} }
        return { ...st.meta[id] };
      }
      if (_tgGet) return _tgGet(id);
      throw new Error(`No group with id: ${id}`);
    };
    chrome.tabGroups.query = async (qi = {}) => {
      const st = await getState();
      let nat = [];
      if (_tgQuery) { try { nat = (await _tgQuery(qi)) || []; } catch {} }
      const emu = Object.values(st.meta).filter((g) => !g.native).filter((g) =>
        (qi.windowId == null || g.windowId === qi.windowId) &&
        (qi.title == null || g.title === qi.title) &&
        (qi.color == null || g.color === qi.color) &&
        (qi.collapsed == null || g.collapsed === qi.collapsed)
      ).map((g) => ({ ...g }));
      return nat.concat(emu);
    };
    chrome.tabGroups.update = async (id, props) => {
      const st = await getState();
      if (st.meta[id]) {
        Object.assign(st.meta[id], props || {});
        await save({ [K_META]: st.meta });
        if (st.meta[id].native && _tgUpdate) { try { return await _tgUpdate(id, props); } catch {} }
        return { ...st.meta[id] };
      }
      if (_tgUpdate) return _tgUpdate(id, props);
      return { id, ...(props || {}) };
    };
    chrome.tabGroups.move = async (id, props) => {
      if (_tgMove) { try { return await _tgMove(id, props); } catch {} }
      const st = await getState();
      return { ...(st.meta[id] || { id }) };
    };
  } else if (!chrome.tabGroups) {
    // FF ≤138: no native API at all — provide the full emulated object.
    chrome.tabGroups = {
      TAB_GROUP_ID_NONE: NONE,
      Color: {
        GREY: 'grey', BLUE: 'blue', RED: 'red', YELLOW: 'yellow', GREEN: 'green',
        PINK: 'pink', PURPLE: 'purple', CYAN: 'cyan', ORANGE: 'orange',
      },
      get: async (id) => {
        const st = await getState();
        if (!st.meta[id]) throw new Error(`No group with id: ${id}`);
        return { ...st.meta[id] };
      },
      query: async (qi = {}) => {
        const st = await getState();
        return Object.values(st.meta).filter((g) =>
          (qi.windowId == null || g.windowId === qi.windowId) &&
          (qi.title == null || g.title === qi.title) &&
          (qi.color == null || g.color === qi.color) &&
          (qi.collapsed == null || g.collapsed === qi.collapsed)
        ).map((g) => ({ ...g }));
      },
      update: async (id, props) => {
        const st = await getState();
        const m = st.meta[id] || { id, title: '', color: 'grey', collapsed: false, native: false };
        Object.assign(m, props || {});
        st.meta[id] = m;
        await save({ [K_META]: st.meta });
        return { ...m };
      },
      move: async (id) => {
        const st = await getState();
        return { ...(st.meta[id] || { id }) };
      },
      onCreated: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
      onUpdated: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
      onMoved:   { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
      onRemoved: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
    };
  }

  // Make Claude's groups VISIBLE as real Firefox tab groups. The registry stays the
  // membership source of truth (so the access gate is unaffected); this only mirrors
  // groupable members into a native group for the user to see. New tabs are privileged
  // at creation (about:newtab) and can't be natively grouped until they navigate to a
  // real URL — so we promote them on navigation. Promotions are serialized so several
  // tabs navigating at once (e.g. browser_batch) land in ONE native group, not many.
  if (isBackground && canGroup && _natGroup && api.tabs && api.tabs.onUpdated) {
    const VISUAL_TITLE = 'Claude';
    const L = (...a) => { try { console.log('[claude-zen][groups]', ...a); } catch {} };
    L('promotion listener installed');
    const promote = async (tabId) => {
      const st = await getState();
      const gid = st.memb[tabId];
      if (gid == null || !st.meta[gid]) return;        // not a Claude-managed tab (silent: fires for every tab)
      L('promote attempt tab', tabId, 'gid', gid, 'native', !!st.meta[gid].native);
      if (!(await isGroupable(tabId))) { L('skip', tabId, 'not groupable'); return; } // still privileged
      // Where should it go? A native-backed group is its own visible group; an
      // emulated group gets a lazily-created sibling native group (visualGroupId).
      let target = st.meta[gid].native ? gid : st.meta[gid].visualGroupId;
      if (target != null && _natTgGet) { try { await _natTgGet(target); } catch { target = null; } }
      let cur; try { cur = await _natGet(tabId); } catch { return; }
      if (cur && typeof cur.groupId === 'number' && cur.groupId === target) return; // already there
      try {
        if (target != null) {
          await _natGroup({ tabIds: [tabId], groupId: target });
          L('added tab', tabId, '→ native group', target);
        } else {
          const ngid = await _natGroup({ tabIds: [tabId] });
          if (_natTgUpdate) { try { await _natTgUpdate(ngid, { title: VISUAL_TITLE, color: 'orange' }); } catch (e) { L('title/color failed (FF<139?)', e && e.message); } }
          const fresh = await getState();
          if (fresh.meta[gid]) { fresh.meta[gid].visualGroupId = ngid; await save({ [K_META]: fresh.meta }); }
          L('created native group', ngid, 'for registry group', gid, 'tab', tabId);
        }
      } catch (e) { L('promote FAILED tab', tabId, e && e.message); }
    };
    let chain = Promise.resolve();
    const enqueue = (tabId) => { chain = chain.then(() => promote(tabId)).catch(() => {}); };
    // Trigger 1: a tracked tab finished (re)navigating to a real URL.
    api.tabs.onUpdated.addListener((tabId, info) => {
      if (info && (info.status === 'complete' || typeof info.url === 'string')) enqueue(tabId);
    });
    // Trigger 2: a tab GAINS group membership. Covers the bundle grouping a tab AFTER it
    // already finished navigating — in that order onUpdated 'complete' fired too early
    // (tab not yet in the registry) and promote() bailed silently. storage.onChanged also
    // catches grouping done in the sidepanel context (this listener lives in background).
    if (store && api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener((changes) => {
        const ch = changes[K_MEMB];
        if (!ch) return;
        const oldM = ch.oldValue || {}, newM = ch.newValue || {};
        for (const tid in newM) {
          if (oldM[tid] !== newM[tid]) enqueue(Number(tid));
        }
      });
    }
  }

  // Seed the session's main tab into a Claude group. The upstream bundle only ever
  // groups the main tab through its MCP/session-group tools — for a plain "open a
  // tab" flow it NEVER calls createGroup, so the main tab's groupId stays NONE,
  // tabs_create's `if (mainTab.groupId !== NONE)` guard skips grouping the new tab,
  // and the access gate rejects every new tab ("not in the same group"). By putting
  // the main tab in a group here, get(mainTab).groupId becomes non-NONE → the bundle
  // groups freshly created tabs into it → the gate's findGroupByTab reconstructs the
  // group from chrome.tabs.query({groupId}) (our overlay) and access is granted.
  // Idempotent; native group when the tab is groupable, emulated otherwise.
  self.__ffEnsureMainGroup = async (tabId, opts = {}) => {
    try {
      if (tabId == null || !chrome.tabs) return;
      // The conversation's main tab is often a PRIVILEGED page (about:blank /
      // about:newtab / a new-tab override) that Firefox refuses to put in a VISIBLE
      // tab group — so it shows as "groupless" while the agent's scratch tabs (which
      // navigate to real URLs) form the visible group. On explicit chat init / new
      // thread (makeGroupable), send that tab to a real, groupable page first so it
      // can visibly join the group. Real pages are left untouched.
      if (opts.makeGroupable) {
        try {
          const t = await _natGet(tabId);
          const u = t && t.url;
          // Never redirect a PINNED tab (incl. Zen pinned/essential): the user pinned it
          // deliberately; navigating it away would clobber their tab. Pinned main tabs stay
          // put and get an emulated group below (the agent still controls their tabs).
          if (t && t.pinned) {
            console.log('[claude-zen][groups] ensureMainGroup: main tab', tabId, 'is pinned — leaving in place (emulated group)');
          } else if (!u || PRIVILEGED.test(u)) {
            await chrome.tabs.update(tabId, { url: 'https://duckduckgo.com' });
            console.log('[claude-zen][groups] ensureMainGroup: navigated privileged main tab', tabId, '→ duckduckgo.com');
          }
        } catch (e) {}
      }
      const st = await getState();
      if (st.memb[tabId] != null) {
        console.log('[claude-zen][groups] ensureMainGroup: tab', tabId, 'already in group', st.memb[tabId]);
        return;   // already in a group
      }
      const gid = await groupFn({ tabIds: [tabId] });
      const fresh = await getState();
      if (fresh.meta[gid] && fresh.meta[gid].mainTabId == null) {
        fresh.meta[gid].mainTabId = tabId;
        await save({ [K_META]: fresh.meta });
      }
      console.log('[claude-zen][groups] ensureMainGroup: grouped main tab', tabId, '→ group', gid);
    } catch (e) { console.warn('[claude-zen][groups] ensureMainGroup FAILED', tabId, e && e.message); }
  };
})();

// ── chrome.debugger (absent in Firefox) → translate CDP to Firefox APIs ───────
// The bundle drives page automation (click/type/screenshot/evaluate) through the
// Chrome DevTools Protocol via chrome.debugger.sendCommand. Firefox has no
// debugger API, so we translate the CDP commands the bundle actually uses into
// Firefox equivalents:
//   Input.dispatchMouseEvent/dispatchKeyEvent/insertText → synthetic DOM events
//     injected into the page MAIN world via scripting.executeScript
//   Page.captureScreenshot                               → tabs.captureVisibleTab
//   Runtime.evaluate                                     → executeScript (MAIN)
//   *.enable / *.disable                                 → no-op {}
//   attach / detach / getTargets                         → no-op (report attached)
// CDP event domains (Network.*, Page.frameNavigated, Runtime.consoleAPICalled…)
// have no Firefox analogue and never fire — onEvent is a no-op listener, so
// network/console monitoring degrades gracefully instead of crashing.
// Limitation: synthetic events are untrusted (isTrusted=false); elements that
// gate on trusted input may ignore them.
if (!chrome.debugger) {
  const __ffApi = (typeof browser !== 'undefined' ? browser : chrome);

  // CDP event fan-out. Firefox has no chrome.debugger.onEvent, so we synthesize
  // events (Network.* from webRequest, Page.frameNavigated from webNavigation —
  // see the background observer block below) and dispatch them to whatever
  // registered onEvent listeners exist in THIS context. Background-origin events
  // reach background listeners via window.__ffEmitCdp (local) and sidepanel
  // listeners via a runtime broadcast (__FF_CDP_EVENT) mirrored here.
  const __cdpListeners = new Set();
  const __emitCdp = (source, method, params) => {
    for (const l of __cdpListeners) { try { l(source, method, params); } catch {} }
  };
  if (typeof window !== 'undefined') window.__ffEmitCdp = __emitCdp;
  if (__ffApi.runtime && __ffApi.runtime.onMessage) {
    __ffApi.runtime.onMessage.addListener((m) => {
      if (m && m.type === '__FF_CDP_EVENT') __emitCdp(m.source, m.method, m.params);
    });
  }
  // Tracks which tabs asked for Network/Runtime events (mirrors the bundle's
  // per-tab enable gating) so the background observers don't emit needlessly.
  const __ffSetCdpFlag = async (kind, tabId, on) => {
    if (tabId == null) return;
    const key = kind === 'net' ? '__ffCdpNet' : '__ffCdpConsole';
    try {
      const o = await __ffApi.storage.session.get(key);
      const map = (o && o[key]) || {};
      if (on) map[tabId] = true; else delete map[tabId];
      await __ffApi.storage.session.set({ [key]: map });
    } catch {}
  };

  // Runs `func(...args)` in the target tab's page (MAIN) world and returns its result.
  const __ffExec = async (tabId, func, args) => {
    if (!__ffApi.scripting || tabId == null) throw new Error('scripting unavailable');
    const res = await __ffApi.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func, args: args || [],
    });
    return res && res[0] ? res[0].result : undefined;
  };

  // Tell the tab's input-blocker (firefox-input-blocker.js) that Claude is acting on it
  // RIGHT NOW, so it blocks real user input even when the bundle's SHOW_*_INDICATOR
  // messages don't reach the content script in Firefox. Fire-and-forget.
  const __ffSignalActive = (tabId) => {
    if (tabId == null) return;
    try {
      const p = __ffApi.tabs.sendMessage(tabId, { type: '__FF_AGENT_ACTIVE' });
      if (p && p.catch) p.catch(() => {});
    } catch {}
  };

  // ── Injected page-world helpers (self-contained — serialized by executeScript) ──
  const __ffMouse = async (p) => {
    // Coordinate space: tabs.captureVisibleTab (our Page.captureScreenshot) returns
    // a CSS-pixel image — its dimensions EQUAL the page's CSS viewport, not device
    // pixels. Verified in the field: a 1077×836 screenshot of a 1077×836 viewport at
    // devicePixelRatio 1.5. So the agent's click coordinates, chosen in screenshot-
    // pixel space, are ALREADY CSS pixels — exactly what elementFromPoint /
    // MouseEvent.clientX expect. Use them as-is. (An earlier "divide by DPR" fix was
    // based on the wrong assumption that the shot was device-scaled; it shifted every
    // click off-target — e.g. (280,358) → (187,239) — and is reverted here.)
    const dpr = window.devicePixelRatio || 1; // diagnostics only — NOT applied to coords
    const x = p.x, y = p.y, m = p.modifiers || 0;
    // Split the null case from a legitimate <body> hit: elementFromPoint === null
    // means the coords landed OUTSIDE the viewport / on no element at all — a real
    // miss the caller must surface (otherwise the agent gets a false "Clicked").
    const elAt = document.elementFromPoint(x, y);
    const el = elAt || document.body;
    const miss = !elAt;
    // Inertness must be read NOW, at hit time. Sites (Angular Material follow-up
    // chips on NotebookLM, etc.) flip the target to disabled / pointer-events:none
    // AS A RESULT of the click — reading the style after dispatch reported a
    // successful click as "target is disabled" and made the agent retry forever.
    let disabled = false;
    try { if (el && (el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'))) disabled = true; } catch {}
    try { const cs = el && getComputedStyle(el); if (cs && cs.pointerEvents === 'none') disabled = true; } catch {}
    const button = { left: 0, middle: 1, right: 2, none: 0 }[p.button] ?? 0;
    let clickMeta = null;
    let mut = null; // DOM mutations observed across the release phase
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8),
      button, buttons: p.buttons || 0, detail: p.clickCount || 1,
    };
    const fireM = (t, ev) => el.dispatchEvent(new MouseEvent(t, ev || base));
    // Pointer Events: modern UI frameworks (React, Radix, Headless UI, etc.) gate
    // buttons/menus on pointerdown/pointerup, NOT mousedown — firing only mouse
    // events left those controls unresponsive to the agent (clicks "did nothing",
    // and it looped re-screenshotting). Fire the pointer pair alongside the mouse
    // pair. PointerEvent may be unavailable in odd contexts, so guard it.
    const fireP = (t, pressure) => {
      if (typeof PointerEvent !== 'function') return;
      try {
        el.dispatchEvent(new PointerEvent(t, {
          ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true,
          width: 1, height: 1, pressure: pressure || 0,
        }));
      } catch {}
    };
    switch (p.type) {
      case 'mouseMoved':
        fireP('pointermove'); fireM('mousemove');
        break;
      case 'mousePressed': {
        // Some widgets (incl. many date pickers) select on mousedown/pointerdown,
        // which arrive as THIS separate CDP call — observe mutations here too, and
        // dump the hit element's HTML so we can see disabled/structure.
        let pm = 0, po = null;
        try { po = new MutationObserver((l) => { pm += l.length; }); po.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
        // hover first so :hover / pointer-enter handlers settle before the press
        fireP('pointerover');  fireM('mouseover');
        fireP('pointerdown', 0.5); fireM('mousedown');
        if (el.focus) { try { el.focus(); } catch {} }
        await new Promise((r) => setTimeout(r, 120));
        try { if (po) po.disconnect(); } catch {}
        let html = ''; try { html = (el.outerHTML || '').slice(0, 140).replace(/\s+/g, ' '); } catch {}
        clickMeta = 'pressMutations=' + pm + ' el=' + html;
        break;
      }
      case 'mouseReleased':
        fireP('pointerup'); fireM('mouseup');
        if (button === 2) { fireM('contextmenu'); break; }
        {
          // Observe DOM mutations across the click to learn whether it actually did
          // ANYTHING — the decisive signal that separates "click works, the agent
          // just screenshotted too early" (mutations>0) from "the site ignores the
          // synthetic click" (mutations==0 → isTrusted/handler gap).
          let mutations = 0;
          let obs = null;
          try { obs = new MutationObserver((list) => { mutations += list.length; }); obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
          let reached = false;
          const probe = () => { reached = true; };
          document.addEventListener('click', probe, { capture: true, once: true });
          // Native activation (el.click()) runs the element's activation behavior and
          // is the most reliable "click this" primitive; fall back to a dispatched
          // event if it's unavailable or throws (SVG / cross-doc / detached nodes).
          let notPrevented = true;
          if (m === 0 && typeof el.click === 'function') {
            try { el.click(); } catch { notPrevented = el.dispatchEvent(new MouseEvent('click', base)); }
          } else {
            notPrevented = el.dispatchEvent(new MouseEvent('click', base));
          }
          document.removeEventListener('click', probe, { capture: true });
          if ((p.clickCount || 1) >= 2) fireM('dblclick');
          // Give sync handlers + a frame of async re-render time to mutate the DOM.
          await new Promise((r) => setTimeout(r, 160));
          try { if (obs) obs.disconnect(); } catch {}
          mut = mutations;
          clickMeta = 'reachedDoc=' + reached + ' defaultPrevented=' + (!notPrevented) + ' domMutations=' + mutations;
        }
        break;
      case 'mouseWheel':
        el.dispatchEvent(new WheelEvent('wheel', { ...base, deltaX: p.deltaX || 0, deltaY: p.deltaY || 0 }));
        break;
    }
    // Diagnostic: report DPR, resolved CSS coords, and what we actually hit so the
    // extension-context caller can log it (page-world console isn't visible there).
    const d = (e) => {
      if (!e) return 'null';
      let s = e.tagName ? e.tagName.toLowerCase() : '?';
      if (e.id) s += '#' + e.id;
      if (e.className && typeof e.className === 'string') s += '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.');
      const flags = [];
      try { if (e.disabled) flags.push('disabled'); } catch {}
      try { if (e.getAttribute && e.getAttribute('aria-disabled') === 'true') flags.push('aria-disabled'); } catch {}
      try { const cs = getComputedStyle(e); if (cs && cs.pointerEvents === 'none') flags.push('pe:none'); } catch {}
      if (flags.length) s += '{' + flags.join(',') + '}';
      const t = (e.textContent || '').trim().replace(/\s+/g, ' ');
      if (t) s += ' "' + t.slice(0, 24) + '"';
      return s;
    };
    // (`disabled` was computed at hit time, before dispatch — see above. `d(el)`
    // re-reads the flags for the log line only; post-click pe:none there is normal.)
    return { dpr, x, y, hit: d(el), miss, disabled, mut, w: window.innerWidth, h: window.innerHeight, act: clickMeta };
  };

  const __ffKey = (p) => {
    const el = document.activeElement || document.body;
    const m = p.modifiers || 0;
    const type = p.type === 'keyUp' ? 'keyup' : 'keydown';
    const initKey = {
      bubbles: true, cancelable: true, composed: true, view: window,
      key: p.key || '', code: p.code || '',
      keyCode: p.windowsVirtualKeyCode || 0, which: p.windowsVirtualKeyCode || 0,
      altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8),
    };
    el.dispatchEvent(new KeyboardEvent(type, initKey));
    // Fire keypress for printable single chars on keydown — some (older / custom)
    // handlers still listen on keypress rather than keydown.
    if (type === 'keydown' && (p.key || '').length === 1 && !initKey.ctrlKey && !initKey.metaKey) {
      el.dispatchEvent(new KeyboardEvent('keypress', initKey));
    }
    // Backspace/Delete in editable targets have no default action for synthetic
    // events — emulate the edit so the bundle's key-based deletes still work.
    // Snapshot before/after so the caller can detect a delete that didn't land
    // (synthetic key ignored). null = not a verifiable delete.
    let editChanged = null;
    if (type === 'keydown' && el.isContentEditable && (p.key === 'Backspace' || p.key === 'Delete')) {
      const before = el.textContent || '';
      if (p.key === 'Backspace') { try { document.execCommand('delete'); } catch {} }
      else { try { document.execCommand('forwardDelete'); } catch {} }
      editChanged = (el.textContent || '') !== before;
    }
    const a = document.activeElement;
    return {
      active: a ? ((a.tagName || '?').toLowerCase() + (a.id ? '#' + a.id : '') + (a.isContentEditable ? '[ce]' : '') + ('value' in a ? '[input]' : '')) : 'null',
      editChanged,
    };
  };

  const __ffInsertText = (text) => {
    const el = document.activeElement;
    if (!el) return { ok: false, changed: false, reason: 'no-active-element' };
    const editable = el.isContentEditable;
    const hasValue = ('value' in el);
    // Snapshot before so the caller can detect an insert that didn't land (field rejects
    // synthetic input / no editable target). target string mirrors __ffKey's `active`.
    const before = editable ? (el.textContent || '') : (hasValue ? String(el.value) : '');
    const tgt = (el.tagName || '?').toLowerCase() + (el.id ? '#' + el.id : '') + (editable ? '[ce]' : '') + (hasValue ? '[input]' : '');
    const done = (ok) => {
      const after = editable ? (el.textContent || '') : (hasValue ? String(el.value) : '');
      return { ok: !!ok, changed: after !== before, target: tgt };
    };
    if (editable) {
      try { const ok = document.execCommand('insertText', false, text); return done(ok); } catch {}
    }
    if (hasValue) {
      // Use the native value setter so React's onChange tracking fires.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? el.value.length;
      const next = el.value.slice(0, s) + text + el.value.slice(e);
      if (setter) setter.call(el, next); else el.value = next;
      const pos = s + text.length;
      try { el.setSelectionRange(pos, pos); } catch {}
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, data: text, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return done(true);
    }
    try { const ok = document.execCommand('insertText', false, text); return done(ok); } catch {}
    return done(false);
  };

  const __ffEval = async (expr) => {
    // Page-world eval errors must come back as DATA (not a rejection): executeScript
    // reports a thrown func inconsistently across FF versions, and the bundle's
    // javascript_tool needs a CDP-shaped `exceptionDetails` to render the real error.
    try {
      // eslint-disable-next-line no-eval
      let value = (0, eval)(expr);
      // CDP Runtime.evaluate(awaitPromise) parity: resolve thenables so async page
      // code returns its value, not "[object Promise]".
      if (value && typeof value.then === 'function') value = await value;
      // The result crosses worlds via structured clone — DOM nodes/functions throw
      // and would nuke the WHOLE response. Degrade them to a string instead.
      if (typeof value === 'function') value = String(value);
      else {
        try { if (typeof structuredClone === 'function') structuredClone(value); }
        catch {
          try { value = JSON.parse(JSON.stringify(value)); }
          catch { value = String(value); }
        }
      }
      return { __czOk: true, value };
    } catch (e) {
      return { __czOk: false, error: String((e && (e.stack || e.message)) || e) };
    }
  };

  const __ffSend = async (target, method, params = {}) => {
    const tabId = target && target.tabId;
    switch (method) {
      case 'Network.enable':  __ffSetCdpFlag('net', tabId, true); return {};
      case 'Network.disable': __ffSetCdpFlag('net', tabId, false); return {};
      case 'Runtime.enable':
        __ffSetCdpFlag('console', tabId, true);
        try { const tp = __ffApi.tabs.sendMessage(tabId, { type: '__FF_CONSOLE_TRACK', on: true }); if (tp && tp.catch) tp.catch(() => {}); } catch {}
        return {};
      case 'Page.enable':
      case 'DOM.enable':
      case 'Page.handleJavaScriptDialog':
        return {};

      case 'Page.captureScreenshot': {
        // Keep the input-blocker armed during the agent's observe-loop: it screenshots
        // repeatedly while "thinking" with no Input.* dispatch, and the heartbeat TTL
        // (8s) would otherwise lapse mid-session and let real user clicks through
        // ("запрет не работает" intermittently). A screenshot of the driven tab is proof
        // the session is active on it, so refresh the block here too. Strictly extends
        // blocking during active operation — never affects synthetic clicks/typing.
        __ffSignalActive(tabId);
        const fmt = {
          format: params.format === 'jpeg' ? 'jpeg' : 'png',
          ...(params.quality != null ? { quality: params.quality } : {}),
        };
        // Token-saver downscale (__czShotScale, default 1 = no change): capturing at
        // scale s<1 yields an s× image (~s² the pixels → ~s² the image tokens). The
        // model then picks click coords in that smaller space, so we record the scale
        // actually used per tab (__czShotScaleByTab) and Input.dispatchMouseEvent
        // divides incoming coords by it. captureVisibleTab has no scale param → that
        // fallback is always full-size, so it records 1 (clicks unscaled).
        const _shotScale = (typeof self.__czShotScale === 'number' && self.__czShotScale > 0) ? self.__czShotScale : 1;
        // Prefer tabs.captureTab(tabId) (FF 59+): it captures the REQUESTED tab even
        // when it isn't active — captureVisibleTab grabs the window's active tab, so
        // if the user switched away the agent "saw" the wrong page and looped.
        // scale:1 pins the image to CSS pixels, matching the coordinate space the
        // click shim expects (see __ffMouse) regardless of devicePixelRatio.
        if (typeof __ffApi.tabs.captureTab === 'function') {
          try {
            const dataUrl = await __ffApi.tabs.captureTab(tabId, { ...fmt, scale: _shotScale });
            if (self.__czShotScaleByTab) self.__czShotScaleByTab[tabId] = _shotScale;
            return { data: String(dataUrl).replace(/^data:image\/\w+;base64,/, '') };
          } catch (e) {
            try { if (self.czLog) self.czLog('cdp', 'tab' + tabId + ' captureTab failed (' + (e && e.message) + ') — falling back to captureVisibleTab'); } catch {}
          }
        }
        if (self.__czShotScaleByTab) self.__czShotScaleByTab[tabId] = 1; // fallback path is full-size
        const tab = await __ffApi.tabs.get(tabId);
        // Fallback: captureVisibleTab grabs the ACTIVE tab of the window, not an
        // arbitrary target. Log a loud warning if that's the wrong tab.
        try {
          const act = await __ffApi.tabs.query({ active: true, windowId: tab.windowId });
          const activeId = act && act[0] && act[0].id;
          if (activeId !== tab.id) {
            console.warn('[claude-zen][cdp] screenshot MISMATCH: target tab', tab.id, '(' + (tab.url || '').slice(0, 40) + ') is NOT active in window', tab.windowId, '— capturing active tab', activeId, 'instead');
          }
        } catch {}
        const dataUrl = await __ffApi.tabs.captureVisibleTab(tab.windowId, fmt);
        return { data: String(dataUrl).replace(/^data:image\/\w+;base64,/, '') };
      }

      case 'Input.dispatchMouseEvent': {
        __ffSignalActive(tabId);
        // Token-saver coordinate remap: if this tab's last screenshot was downscaled
        // (__czShotScale<1), the model's coords are in the shrunk image's space; scale
        // them back up to CSS pixels (what __ffMouse / elementFromPoint expect). No-op
        // at the default scale 1.
        const _ms = (self.__czShotScaleByTab && self.__czShotScaleByTab[tabId]) || 1;
        if (_ms !== 1 && params && typeof params.x === 'number') {
          params = { ...params, x: params.x / _ms, y: params.y / _ms };
        }
        const r = await __ffExec(tabId, __ffMouse, [params]);
        if (r && typeof r === 'object') {
          const line = 'mouse ' + params.type + ' raw=(' + params.x + ',' + params.y + ') dpr=' + r.dpr + ' css=(' + Math.round(r.x) + ',' + Math.round(r.y) + ') viewport=' + r.w + 'x' + r.h + ' hit=' + r.hit + (r.miss ? ' MISS' : '') + (r.disabled ? ' DISABLED' : '') + (r.act ? ' [' + r.act + ']' : '');
          console.log('[claude-zen][cdp] ' + line);
          try { if (self.czLog && (params.type === 'mouseReleased' || params.type === 'mousePressed')) self.czLog('cdp', 'tab' + tabId + ' ' + line); } catch {}
        }
        // Surface a REAL failure on the decisive release phase so the bundle reports
        // an error to the model instead of a false "Clicked". CDP's real
        // Input.dispatchMouseEvent rejects on failure; the bundle awaits sendCommand
        // and propagates the rejection into the tool result. Gate conservatively on
        // unambiguous misses only: coords hit no element, or the target was inert AT
        // HIT TIME and the click provably changed nothing (mut===0). An inert-looking
        // target WITH mutations means the press/release did fire handlers (sites flip
        // pointer-events/disabled as a *result* of the click) — that's a success.
        if (params.type === 'mouseReleased' && r && typeof r === 'object' &&
            (r.miss || (r.disabled && r.mut === 0))) {
          try { if (self.czLog) self.czLog('cdp', 'tab' + tabId + ' CLICK-FAILED (' + params.x + ',' + params.y + ') ' + (r.miss ? 'miss' : 'disabled ' + r.hit + ' mut=' + r.mut)); } catch {}
          throw new Error(
            'Firefox click had no effect at (' + params.x + ',' + params.y + '): ' +
            (r.miss ? 'no element at those coordinates' : 'target is disabled/non-interactive (' + r.hit + ')') +
            '. The element may be off-screen, covered, or the coordinates are wrong — re-screenshot and retry.');
        }
        // (mouseReleased already waits ~160ms inside __ffMouse for the DOM to settle
        // before resolving, so the agent's next screenshot reflects the click.)
        return {};
      }
      case 'Input.dispatchKeyEvent': {
        __ffSignalActive(tabId);
        const r = await __ffExec(tabId, __ffKey, [params]);
        console.log('[claude-zen][cdp] key', params.type, 'key=' + JSON.stringify(params.key) + ' active=' + (r && r.active));
        try { if (self.czLog && params.type !== 'keyUp') self.czLog('cdp', 'tab' + tabId + ' key ' + JSON.stringify(params.key) + ' active=' + (r && r.active)); } catch {}
        // Untrusted-input detection (log-only — many keys legitimately change nothing):
        // a Backspace/Delete in a contentEditable that left the content untouched is a
        // sign the synthetic key was ignored (isTrusted=false). We only LOG it (not throw)
        // because a delete at an empty/boundary field legitimately changes nothing.
        if (r && r.editChanged === false && (params.key === 'Backspace' || params.key === 'Delete')) {
          try { if (self.czLog) self.czLog('cdp', 'tab' + tabId + ' KEY-IGNORED ' + params.key + ' (editable unchanged — synthetic key may be ignored or nothing to delete)'); } catch {}
        }
        return {};
      }
      case 'Input.insertText': {
        __ffSignalActive(tabId);
        const r = await __ffExec(tabId, __ffInsertText, [params.text]);
        console.log('[claude-zen][cdp] insertText ' + JSON.stringify(String(params.text).slice(0, 30)) + ' result=' + JSON.stringify(r));
        try { if (self.czLog) self.czLog('cdp', 'tab' + tabId + ' insertText ' + JSON.stringify(String(params.text).slice(0, 60)) + ' ok=' + JSON.stringify(r)); } catch {}
        // Untrusted-input detection: non-empty text that produced NO change means the
        // insert didn't land — the field rejects synthetic input (isTrusted=false) or
        // nothing editable was focused. Surface a real error so the model retries instead
        // of believing it typed. CDP Input.insertText rejects on failure; the bundle
        // propagates the rejection into the tool result.
        if (params.text && r && typeof r === 'object' && r.changed === false) {
          try { if (self.czLog) self.czLog('cdp', 'tab' + tabId + ' PASTE-IGNORED ' + (r.ok ? ('no change on ' + r.target) : ('reason=' + (r.reason || '?')))); } catch {}
          throw new Error(
            'Firefox text insert had no effect: the focused target (' + (r.target || r.reason || 'none') +
            ') did not change. The field may reject synthetic input (isTrusted=false), or nothing editable was focused — click the field first and retry.');
        }
        return {};
      }

      case 'Runtime.evaluate': {
        // Never throw and never return a malformed shape: the bundle reads
        // `m.exceptionDetails` / `m.result.type` unguarded — an undefined response
        // crashed javascript_tool with "can't access property exceptionDetails".
        const asException = (msg) => ({
          result: { type: 'undefined' },
          exceptionDetails: { text: msg, exception: { description: msg } },
        });
        try {
          const r = await __ffExec(tabId, __ffEval, [params.expression]);
          if (r && r.__czOk === false) return asException(r.error || 'Unknown error');
          const value = r && r.__czOk ? r.value : undefined;
          return { result: { type: typeof value, value } };
        } catch (e) {
          // executeScript itself failed (privileged page, missing host permission…)
          return asException(String((e && e.message) || e));
        }
      }

      default:
        console.warn('[claude-zen] CDP command not implemented in Firefox:', method);
        return {};
    }
  };

  chrome.debugger = {
    // attach/detach/getTargets are invoked callback-style by the bundle
    // (rawAttach does chrome.debugger.attach({tabId},"1.3",cb) inside a
    // Promise.race) — the callback MUST fire or every command stalls.
    attach:     (target, version, cb) => { if (typeof cb === 'function') cb(); return Promise.resolve(); },
    detach:     (target, cb)          => { if (typeof cb === 'function') cb(); return Promise.resolve(); },
    getTargets: (cb)                  => { if (typeof cb === 'function') cb([]); return Promise.resolve([]); },
    sendCommand: (target, method, params, cb) => {
      const p = __ffSend(target, method, params);
      if (typeof cb === 'function') { p.then((r) => cb(r), () => cb(undefined)); return; }
      return p;
    },
    onEvent: {
      addListener: (fn) => __cdpListeners.add(fn),
      removeListener: (fn) => __cdpListeners.delete(fn),
      hasListener: (fn) => __cdpListeners.has(fn),
    },
    onDetach: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
  };
}

// ── Background CDP event sources: webRequest → Network.*, webNavigation → Page.* ─
// Synthesize the CDP events the bundle listens for. Runs in the background page
// only (it owns webRequest/webNavigation). Network events are gated by the
// per-tab enable flags the sendCommand shim records; frameNavigated is cheap and
// ungated. Each event is emitted to local background listeners (window.__ffEmitCdp)
// and broadcast for sidepanel listeners (__FF_CDP_EVENT).
if (typeof location !== 'undefined' &&
    location.pathname.endsWith('_generated_background_page.html')) {
  (function () {
    const api = (typeof browser !== 'undefined' ? browser : chrome);
    const netTabs = new Set();

    const refreshNet = async () => {
      try {
        const o = await api.storage.session.get('__ffCdpNet');
        const map = (o && o.__ffCdpNet) || {};
        netTabs.clear();
        for (const k of Object.keys(map)) netTabs.add(Number(k));
      } catch {}
    };
    refreshNet();
    if (api.storage && api.storage.onChanged) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.__ffCdpNet) refreshNet();
      });
    }

    const emit = (tabId, method, params) => {
      if (tabId == null || tabId < 0) return;
      const source = { tabId };
      if (typeof window !== 'undefined' && typeof window.__ffEmitCdp === 'function') {
        window.__ffEmitCdp(source, method, params);
      }
      try {
        const p = api.runtime.sendMessage({ type: '__FF_CDP_EVENT', source, method, params });
        if (p && p.catch) p.catch(() => {});
      } catch {}
    };

    if (api.webRequest) {
      const filter = { urls: ['<all_urls>'] };
      api.webRequest.onBeforeRequest.addListener((d) => {
        if (!netTabs.has(d.tabId)) return;
        emit(d.tabId, 'Network.requestWillBeSent', {
          requestId: String(d.requestId),
          request: { url: d.url, method: d.method },
          documentURL: d.documentUrl || d.originUrl || d.url,
          type: d.type,
          timestamp: (d.timeStamp || Date.now()) / 1000,
        });
      }, filter);
      api.webRequest.onCompleted.addListener((d) => {
        if (!netTabs.has(d.tabId)) return;
        emit(d.tabId, 'Network.responseReceived', {
          requestId: String(d.requestId),
          response: { url: d.url, status: d.statusCode },
          type: d.type,
        });
      }, filter);
      api.webRequest.onErrorOccurred.addListener((d) => {
        if (!netTabs.has(d.tabId)) return;
        emit(d.tabId, 'Network.loadingFailed', {
          requestId: String(d.requestId),
          errorText: d.error,
          type: d.type,
        });
      }, filter);
    }

    if (api.webNavigation && api.webNavigation.onCommitted) {
      api.webNavigation.onCommitted.addListener((d) => {
        if (d.frameId !== 0) return; // main frame only (bundle gates on !parentId)
        emit(d.tabId, 'Page.frameNavigated', {
          frame: { id: String(d.tabId), url: d.url },
        });
      });
    }

    // Console/exception entries relayed from the page (firefox-console-hook +
    // -relay) → synthetic Runtime.consoleAPICalled / Runtime.exceptionThrown.
    if (api.runtime && api.runtime.onMessage) {
      api.runtime.onMessage.addListener((msg, sender) => {
        if (!msg || msg.type !== '__FF_CDP_CONSOLE' || !sender || !sender.tab) return;
        const tabId = sender.tab.id;
        const p = msg.payload || {};
        if (p.kind === 'exception') {
          emit(tabId, 'Runtime.exceptionThrown', {
            timestamp: p.ts,
            exceptionDetails: {
              text: p.message, exception: { description: p.message },
              url: p.url, lineNumber: p.line, columnNumber: p.col,
            },
          });
        } else {
          emit(tabId, 'Runtime.consoleAPICalled', {
            type: p.level || 'log',
            args: (p.args || []).map((v) => ({ type: 'string', value: v })),
            timestamp: p.ts,
          });
        }
      });
    }
  })();
}

// ── chrome.sidePanel → browser.sidebarAction ──────────────────────────────────
// The bundle calls setOptions({tabId, path:`sidepanel.html?tabId=${id}`}) before
// open() to bind a per-tab sidebar URL. Firefox's sidebarAction.setPanel supports
// a per-tab panel via the tabId option, so we translate it directly. This makes
// the sidebar open with ?tabId=N already in the URL — the bundle then reads it
// and the active-tab state is populated (otherwise it throws "No active tab").
// The deferred-module loader in this file is a backup for paths that bypass
// setOptions (e.g. Firefox's own sidebar toolbar button).
if (!chrome.sidePanel) {
  chrome.sidePanel = {
    setOptions: async (opts) => {
      try {
        // Claude calls setOptions to bind the panel to a tab right as a conversation
        // starts / a new chat opens — the reliable "a thread begins here" signal. Seed
        // the group now so the conversation's INITIAL tab is always in a Claude group
        // (and a switchable thread), and make it groupable if it's a privileged page.
        try {
          let tid = (opts && opts.tabId != null) ? Number(opts.tabId) : null;
          if (tid == null && opts && opts.path) {
            const m = /[?&]tabId=(\d+)/.exec(opts.path);
            if (m) tid = Number(m[1]);
          }
          if (tid != null && self.__ffEnsureMainGroup) await self.__ffEnsureMainGroup(tid, { makeGroupable: true });
        } catch {}
        if (opts && opts.path && browser.sidebarAction && browser.sidebarAction.setPanel) {
          // IMPORTANT: set a GLOBAL panel (no tabId), unlike Chrome's per-tab
          // sidepanel model. Firefox has a single sidebar shared across tabs; if
          // we bind the panel to one tabId, switching to any other tab makes
          // Firefox fall back to the default panel URL (no ?tabId) and RELOAD the
          // sidebar document — re-initializing the whole bundle and wiping the
          // in-progress conversation. A single global panel URL stays constant
          // across tab switches, so the document is kept alive and state persists.
          // The target tabId still reaches the bundle via the deferred-module
          // loader (history.replaceState ?tabId=N + URLSearchParams.get patch).
          //
          // BUG FIX: opts.path is `sidepanel.html?tabId=N`. Passing it verbatim set a
          // per-tab-id GLOBAL panel URL, contradicting the note above — on the next tab
          // switch Firefox saw a different default panel URL and RELOADED the sidebar,
          // wiping the in-progress conversation (the "session not saved across tabs"
          // bug). Strip ?tabId so the global panel URL stays constant; the loader
          // re-injects the correct tabId per document load.
          const globalPanel = String(opts.path)
            .replace(/[?&]tabId=\d+/g, '')
            .replace(/\?&/, '?')
            .replace(/[?&]$/, '');
          await browser.sidebarAction.setPanel({ panel: globalPanel });
        }
      } catch {}
    },
    open:             async () => { try { await browser.sidebarAction.open();  } catch {} },
    close:            async () => { try { await browser.sidebarAction.close(); } catch {} },
    getOptions:       async () => ({ enabled: true, path: 'sidepanel.html' }),
    setPanelBehavior: async () => {},
  };
}

// ── Per-tab sidebar visibility (idle placeholder): SUPERSEDED by thread switcher ──
// An earlier design swapped the per-tab sidebar panel on tabs.onActivated to show
// the chat only on Claude's working-group tabs and `firefox-idle-panel.html` on
// every other tab. It relied on per-tab `sidebarAction.setPanel({tabId})`, which
// is fundamentally incompatible with the thread switcher (firefox-threads.js):
// any per-tab panel override forces Firefox to RELOAD the sidebar document when
// the active tab changes, re-initializing the bundle and wiping the in-progress
// conversation — exactly what the "keep sidebar alive across tab switches" fix in
// setOptions (single constant global panel, ?tabId stripped) exists to prevent.
// The thread switcher subsumes this feature: the sidebar now shows ONE kept-alive
// conversation (the selected thread), and the user repoints it via the dropdown
// (firefox-threads.js) or the "◆ Open in Claude" button (firefox-thread-jump.js),
// decoupled from the active browser tab. The idle block is therefore removed; the
// `__ffChatTabId` state it depended on is no longer set in setOptions.

// ── chrome.offscreen → handled inline in the Firefox background page ───────────
// Chrome needs an offscreen document because its MV3 service worker has no DOM
// (no Audio, canvas, Image, URL.createObjectURL). The bundle uses offscreen.js
// for notification-sound playback and GIF generation (the /share flow).
// Firefox's MV3 background is a real event PAGE with full DOM, so no offscreen
// document is needed — offscreen.js + gif.js are loaded directly into the
// background page (see manifest background.scripts). We report hasDocument:true
// so the bundle skips creation and just posts its OFFSCREEN_PLAY_SOUND /
// GENERATE_GIF / REVOKE_BLOB_URL messages, which offscreen.js's onMessage
// listener handles in the background. Messages the bundle sends FROM the
// background itself don't loop back via runtime.sendMessage (same context), so
// the sendMessage wrapper below dispatches those straight to the handlers.
if (!chrome.offscreen) {
  chrome.offscreen = {
    hasDocument:    async () => true,
    createDocument: async () => {},
    closeDocument:  async () => {},
    Reason: {
      AUDIO_PLAYBACK: 'AUDIO_PLAYBACK', BLOBS: 'BLOBS',
      CLIPBOARD: 'CLIPBOARD',           DISPLAY_MEDIA: 'DISPLAY_MEDIA',
      DOM_PARSER: 'DOM_PARSER',         DOM_SCRAPING: 'DOM_SCRAPING',
      IFRAME_SCRIPTING: 'IFRAME_SCRIPTING', LOCAL_STORAGE: 'LOCAL_STORAGE',
      MATCH_MEDIA: 'MATCH_MEDIA',       TESTING: 'TESTING',
      USER_MEDIA: 'USER_MEDIA',         WORKERS: 'WORKERS',
    },
  };
}

// ── Offscreen-message loopback: dispatch background→background sends directly ──
// runtime.sendMessage does not deliver to listeners in the same context, so when
// the bundle (running in the background page) posts an offscreen message, the
// offscreen.js listener in that same page never sees it. Intercept those types
// at send time and call the handlers offscreen.js exposes as page globals.
// Other contexts (sidepanel) lack the handlers, fall through, and reach the
// background's offscreen.js listener cross-context as usual.
if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
  const _send = chrome.runtime.sendMessage.bind(chrome.runtime);
  const OFFSCREEN_TYPES = new Set(['OFFSCREEN_PLAY_SOUND', 'GENERATE_GIF', 'REVOKE_BLOB_URL']);
  const hasHandlers = () => typeof window !== 'undefined' && typeof window.generateGif === 'function';
  const handle = async (m) => {
    try {
      if (m.type === 'OFFSCREEN_PLAY_SOUND') { await window.playAudioWithWebAudioAPI(m.audioUrl, m.volume ?? 0.5); return { success: true }; }
      if (m.type === 'GENERATE_GIF')         { return { success: true, result: await window.generateGif(m.frames, m.options) }; }
      if (m.type === 'REVOKE_BLOB_URL')      { URL.revokeObjectURL(m.blobUrl); return { success: true }; }
    } catch (e) { return { success: false, error: e?.message }; }
  };
  // Firefox is stricter than Chrome about message-channel lifetime. The Chrome
  // bundle has onMessage listeners that return true (or are async) and don't always
  // call sendResponse, and it fires messages without awaiting a real reply. In
  // Chrome an unanswered sendMessage just resolves undefined; in Firefox the
  // sender's promise REJECTS — "Promised response from onMessage listener went out
  // of scope" / "message channel closed" / "Receiving end does not exist" — which
  // surfaces as noisy unhandled rejections from the minified bundle (we can't edit
  // assets/). Swallow ONLY those benign channel errors on the promise path and
  // resolve undefined, restoring Chrome's behavior. Anything else is rethrown.
  const BENIGN_MSG = /out of scope|message channel closed|port closed|Receiving end does not exist|establish connection/i;
  chrome.runtime.sendMessage = function (...args) {
    const m = args[0];
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    if (m && typeof m === 'object' && OFFSCREEN_TYPES.has(m.type) && hasHandlers()) {
      const p = handle(m);
      if (cb) { p.then(cb, () => cb(undefined)); return; }
      return p;
    }
    const r = _send(...args);
    if (!cb && r && typeof r.then === 'function') {
      return r.catch((e) => {
        if (BENIGN_MSG.test((e && e.message) || '')) return undefined;
        throw e;
      });
    }
    return r;
  };
}

// ── chrome.declarativeNetRequest enums (undefined in Firefox) ─────────────────
// Firefox does not expose the RuleActionType / HeaderOperation / ResourceType
// enum objects. The bundle's B() builds a MODIFY_HEADERS session rule via
// `chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS` etc.; in Firefox
// those enum objects are undefined, so the property access throws a TypeError.
// B() is `await`ed at the TOP of both the onStartup and onInstalled handlers
// (before t.initialize(), bridge setup, native messaging…), so the throw ABORTS
// the entire background-init sequence on every startup. We supply the enum
// string constants so the rule object builds cleanly. The client headers
// themselves are injected via fetch (page) + webRequest (background); the
// MODIFY_HEADERS rule itself is allowed to run (FF 128 may honor it) but
// updateSessionRules is wrapped so a rejection can never abort init.
try {
  if (chrome.declarativeNetRequest) {
    let dnr = chrome.declarativeNetRequest;
    const RAT = {
      BLOCK: 'block', REDIRECT: 'redirect', ALLOW: 'allow',
      UPGRADE_SCHEME: 'upgradeScheme', MODIFY_HEADERS: 'modifyHeaders',
      ALLOW_ALL_REQUESTS: 'allowAllRequests',
    };
    const HO = { APPEND: 'append', SET: 'set', REMOVE: 'remove' };
    const RT = {
      MAIN_FRAME: 'main_frame', SUB_FRAME: 'sub_frame', STYLESHEET: 'stylesheet',
      SCRIPT: 'script', IMAGE: 'image', FONT: 'font', OBJECT: 'object',
      XMLHTTPREQUEST: 'xmlhttprequest', PING: 'ping', CSP_REPORT: 'csp_report',
      MEDIA: 'media', WEBSOCKET: 'websocket', OTHER: 'other',
    };
    // Try plain assignment, then defineProperty (handles a sealed sub-object).
    const ensure = (obj, key, val) => {
      if (obj[key]) return;
      try { obj[key] = val; } catch {}
      if (!obj[key]) { try { Object.defineProperty(obj, key, { value: val, configurable: true, writable: true }); } catch {} }
    };
    ensure(dnr, 'RuleActionType', RAT);
    ensure(dnr, 'HeaderOperation', HO);
    ensure(dnr, 'ResourceType', RT);

    // If the namespace was non-extensible, replace it wholesale (delegating methods)
    // so the bundle's `chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS`
    // never throws and aborts the onStartup/onInstalled init sequence.
    if (!dnr.RuleActionType || !dnr.HeaderOperation || !dnr.ResourceType) {
      const orig = dnr;
      const wrapMethod = (name, fallback) => (...a) => {
        try { return orig[name] ? orig[name](...a) : fallback(); }
        catch (e) { console.warn(`[claude-zen] DNR ${name} ignored (FF):`, e?.message); return fallback(); }
      };
      const replacement = {
        RuleActionType: RAT, HeaderOperation: HO, ResourceType: RT,
        updateSessionRules: wrapMethod('updateSessionRules', () => Promise.resolve()),
        getSessionRules: wrapMethod('getSessionRules', () => Promise.resolve([])),
        updateDynamicRules: wrapMethod('updateDynamicRules', () => Promise.resolve()),
        getDynamicRules: wrapMethod('getDynamicRules', () => Promise.resolve([])),
      };
      try { chrome.declarativeNetRequest = replacement; } catch {}
      dnr = chrome.declarativeNetRequest;
    } else if (typeof dnr.updateSessionRules === 'function') {
      // Enums set in place — wrap updateSessionRules so a rejected modifyHeaders
      // rule (FF may not honor it) can never abort the init sequence.
      const _origUSR = dnr.updateSessionRules.bind(dnr);
      const wrapped = async (...a) => {
        try { return await _origUSR(...a); }
        catch (e) { console.warn('[claude-zen] DNR updateSessionRules ignored (FF):', e?.message); }
      };
      try { dnr.updateSessionRules = wrapped; } catch {
        try { Object.defineProperty(dnr, 'updateSessionRules', { value: wrapped, configurable: true, writable: true }); } catch {}
      }
    }
  }
} catch (e) { console.warn('[claude-zen] declarativeNetRequest shim error:', e?.message); }

// ── chrome.identity shim ─────────────────────────────────────────────────────
// Firefox lacks chrome.identity. Implementation:
//   - Background context → calls browser.identity.launchWebAuthFlow directly
//   - Page context (sidepanel) → routes through background via FF_IDENTITY_LAUNCH
// Both paths use CHROME_URI as redirect_url — this is the only URI registered
// with Anthropic. chromiumapp.org is NOT registered (causes "Invalid request format").
if (!chrome.identity) {
  const CHROME_URI   = 'chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/oauth_callback.html';
  const FF_REDIRECT  = 'https://fcoeoabgfenejglbffodgkkbkcdhcgfn.chromiumapp.org/';
  const isBackground = typeof document === 'undefined';

  const _doLaunch = async (url, interactive, timeoutMs) => {
    if (isBackground) {
      // Try browser.identity first (native Firefox OAuth popup)
      if (typeof browser !== 'undefined' && browser.identity) {
        try {
          return await browser.identity.launchWebAuthFlow({
            url, interactive, redirect_url: CHROME_URI,
          });
        } catch (e) {
          console.warn('[claude-zen] browser.identity failed, trying manualTabAuth:', e.message);
        }
      }
      // Fallback: manualTabAuth with webRequest interception (exposed by firefox-bg-loader.js)
      if (typeof self._claudeZenManualAuth === 'function') {
        return self._claudeZenManualAuth(url, interactive, timeoutMs);
      }
      throw new Error('No background auth mechanism available');
    }
    const res = await chrome.runtime.sendMessage({
      type: 'FF_IDENTITY_LAUNCH', url, interactive, timeoutMs,
    });
    if (!res || res.error) throw new Error(res?.error || 'Auth cancelled');
    return res.url;
  };

  chrome.identity = {
    getRedirectURL: (path) => FF_REDIRECT + (path || ''),

    launchWebAuthFlow: (details, callback) => {
      const interactive = details.interactive !== false;
      const timeoutMs   = interactive
        ? 120_000
        : (details.timeoutMsForNonInteractive || 5000);

      const p = _doLaunch(details.url, interactive, timeoutMs)
        .then((url) => {
          delete chrome.runtime.lastError;
          if (callback) callback(url);
          return url;
        })
        .catch((err) => {
          const msg = err?.message || String(err);
          chrome.runtime.lastError = { message: msg };
          if (callback) callback(undefined);
          throw err;
        });
      return p;
    },

    getAuthToken:              (_, cb) => { if (cb) cb(undefined); return Promise.resolve(undefined); },
    removeCachedAuthToken:     (_, cb) => { if (cb) cb();          return Promise.resolve(); },
    clearAllCachedAuthTokens:  (cb)    => { if (cb) cb();          return Promise.resolve(); },
  };
}

// ── chrome.dom (Chrome-only) → shadow-root access ────────────────────────────
// The bundle's DOM/accessibility traversal uses chrome.dom.openOrClosedShadowRoot
// to descend into shadow DOM. Firefox has no chrome.dom; map it to the open
// shadow root (closed roots are inaccessible to extensions in Firefox and return
// null, which the traversal tolerates).
if (typeof chrome !== 'undefined' && !chrome.dom) {
  chrome.dom = {
    openOrClosedShadowRoot: (el) => {
      try {
        if (el && typeof el.openOrClosedShadowRoot === 'function') return el.openOrClosedShadowRoot();
      } catch {}
      return (el && el.shadowRoot) || null;
    },
  };
}

// ── chrome.action.getUserSettings (Chrome-only) ──────────────────────────────
// Firefox exposes browser.action but not getUserSettings; the bundle awaits it.
// Report the action as pinned so the bundle proceeds.
if (chrome.action && typeof chrome.action.getUserSettings !== 'function') {
  chrome.action.getUserSettings = async () => ({ isOnToolbar: true });
}

// ── Theme detection (replaces the CSP-blocked inline <script> in HTML pages) ──
try {
  if (typeof document !== 'undefined' && typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (dark) =>
      document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
    apply(mq.matches);
    mq.addEventListener('change', (e) => apply(e.matches));
  }
} catch {}
