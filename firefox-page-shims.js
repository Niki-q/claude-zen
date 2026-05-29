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
    if (_czIsMessages && self.__czDebug && self.__czDebug.enabled) {
      try { self.__czDebug.logRequest(input, init); } catch {}
    }

    const resp = await _origFetch.call(this, input, init);

    // Debug mirror (opt-in): tee the SSE response → console (non-destructive).
    if (_czIsMessages && self.__czDebug && self.__czDebug.enabled) {
      try { self.__czDebug.tee(resp); } catch {}
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
  const isBackground = (typeof document === 'undefined');

  // FF 139+ exposes chrome.tabGroups + chrome.tabs.group natively.
  const nativeGroups = (typeof chrome.tabGroups !== 'undefined' &&
                        typeof chrome.tabGroups.TAB_GROUP_ID_NONE === 'number');

  // Capture natives BEFORE we override anything. group/ungroup come from `browser`
  // (Promise-based); get/query are the already-installed sidebar-aware wrappers.
  const _natGroup   = (api.tabs && typeof api.tabs.group === 'function')   ? api.tabs.group.bind(api.tabs)   : null;
  const _natUngroup = (api.tabs && typeof api.tabs.ungroup === 'function') ? api.tabs.ungroup.bind(api.tabs) : null;
  const _natGet     = chrome.tabs ? chrome.tabs.get.bind(chrome.tabs)      : null;
  const _natQuery   = chrome.tabs ? chrome.tabs.query.bind(chrome.tabs)    : null;

  // Tabs showing these schemes cannot be placed in a native Firefox tab group.
  const PRIVILEGED = /^(moz-extension|chrome-extension|about|chrome|view-source|data|resource|file):/i;
  const isGroupable = async (id) => {
    if (!nativeGroups || !_natGet) return false;
    try { const t = await _natGet(id); const u = t && t.url; return !!u && !PRIVILEGED.test(u); }
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
      st.meta[gid] = { id: gid, title: '', color: 'grey', collapsed: false, windowId, native: false };
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

    // New group from groupable tabs → real native group, mirrored into the registry.
    if (gid == null && nativeGroups && _natGroup) {
      let allOk = ids.length > 0;
      for (const id of ids) if (!(await isGroupable(id))) { allOk = false; break; }
      if (allOk) {
        try {
          const ngid = await _natGroup(opts);
          let windowId;
          try { windowId = (await _natGet(ids[0])).windowId; } catch {}
          const fresh = await getState();
          fresh.meta[ngid] = { id: ngid, title: '', color: 'grey', collapsed: false, windowId, native: true };
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

  // Seed the session's main tab into a Claude group. The upstream bundle only ever
  // groups the main tab through its MCP/session-group tools — for a plain "open a
  // tab" flow it NEVER calls createGroup, so the main tab's groupId stays NONE,
  // tabs_create's `if (mainTab.groupId !== NONE)` guard skips grouping the new tab,
  // and the access gate rejects every new tab ("not in the same group"). By putting
  // the main tab in a group here, get(mainTab).groupId becomes non-NONE → the bundle
  // groups freshly created tabs into it → the gate's findGroupByTab reconstructs the
  // group from chrome.tabs.query({groupId}) (our overlay) and access is granted.
  // Idempotent; native group when the tab is groupable, emulated otherwise.
  self.__ffEnsureMainGroup = async (tabId) => {
    try {
      if (tabId == null || !chrome.tabs) return;
      const st = await getState();
      if (st.memb[tabId] != null) return;   // already in a group
      await groupFn({ tabIds: [tabId] });
    } catch {}
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

  // Runs `func(...args)` in the target tab's page (MAIN) world and returns its result.
  const __ffExec = async (tabId, func, args) => {
    if (!__ffApi.scripting || tabId == null) throw new Error('scripting unavailable');
    const res = await __ffApi.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func, args: args || [],
    });
    return res && res[0] ? res[0].result : undefined;
  };

  // ── Injected page-world helpers (self-contained — serialized by executeScript) ──
  const __ffMouse = (p) => {
    const x = p.x, y = p.y, m = p.modifiers || 0;
    const el = document.elementFromPoint(x, y) || document.body;
    const button = { left: 0, middle: 1, right: 2, none: 0 }[p.button] ?? 0;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8),
      button, buttons: p.buttons || 0, detail: p.clickCount || 1,
    };
    const fire = (t) => el.dispatchEvent(new MouseEvent(t, base));
    switch (p.type) {
      case 'mouseMoved': fire('mousemove'); break;
      case 'mousePressed': if (el.focus) try { el.focus(); } catch {} fire('mousedown'); break;
      case 'mouseReleased': fire('mouseup'); fire('click'); break;
      case 'mouseWheel':
        el.dispatchEvent(new WheelEvent('wheel', { ...base, deltaX: p.deltaX || 0, deltaY: p.deltaY || 0 }));
        break;
    }
    return true;
  };

  const __ffKey = (p) => {
    const el = document.activeElement || document.body;
    const m = p.modifiers || 0;
    const type = p.type === 'keyUp' ? 'keyup' : 'keydown';
    el.dispatchEvent(new KeyboardEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      key: p.key || '', code: p.code || '',
      keyCode: p.windowsVirtualKeyCode || 0, which: p.windowsVirtualKeyCode || 0,
      altKey: !!(m & 1), ctrlKey: !!(m & 2), metaKey: !!(m & 4), shiftKey: !!(m & 8),
    }));
    // Backspace/Delete in editable targets have no default action for synthetic
    // events — emulate the edit so the bundle's key-based deletes still work.
    if (type === 'keydown' && el.isContentEditable) {
      if (p.key === 'Backspace') { try { document.execCommand('delete'); } catch {} }
      else if (p.key === 'Delete') { try { document.execCommand('forwardDelete'); } catch {} }
    }
    return true;
  };

  const __ffInsertText = (text) => {
    const el = document.activeElement;
    if (!el) return false;
    if (el.isContentEditable) {
      try { document.execCommand('insertText', false, text); return true; } catch {}
    }
    if ('value' in el) {
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
      return true;
    }
    try { document.execCommand('insertText', false, text); return true; } catch {}
    return false;
  };

  const __ffEval = (expr) => {
    // eslint-disable-next-line no-eval
    return (0, eval)(expr);
  };

  const __ffSend = async (target, method, params = {}) => {
    const tabId = target && target.tabId;
    switch (method) {
      case 'Runtime.enable':
      case 'Page.enable':
      case 'Network.enable':
      case 'Network.disable':
      case 'DOM.enable':
      case 'Page.handleJavaScriptDialog':
        return {};

      case 'Page.captureScreenshot': {
        const tab = await __ffApi.tabs.get(tabId);
        const dataUrl = await __ffApi.tabs.captureVisibleTab(tab.windowId, {
          format: params.format === 'jpeg' ? 'jpeg' : 'png',
          ...(params.quality != null ? { quality: params.quality } : {}),
        });
        return { data: String(dataUrl).replace(/^data:image\/\w+;base64,/, '') };
      }

      case 'Input.dispatchMouseEvent':
        await __ffExec(tabId, __ffMouse, [params]);
        return {};
      case 'Input.dispatchKeyEvent':
        await __ffExec(tabId, __ffKey, [params]);
        return {};
      case 'Input.insertText':
        await __ffExec(tabId, __ffInsertText, [params.text]);
        return {};

      case 'Runtime.evaluate': {
        const value = await __ffExec(tabId, __ffEval, [params.expression]);
        return { result: { type: typeof value, value } };
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
    onEvent:  { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
    onDetach: { addListener: () => {}, removeListener: () => {}, hasListener: () => false },
  };
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
          await browser.sidebarAction.setPanel({ panel: opts.path });
        }
      } catch {}
    },
    open:             async () => { try { await browser.sidebarAction.open();  } catch {} },
    close:            async () => { try { await browser.sidebarAction.close(); } catch {} },
    getOptions:       async () => ({ enabled: true, path: 'sidepanel.html' }),
    setPanelBehavior: async () => {},
  };
}

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
  chrome.runtime.sendMessage = function (...args) {
    const m = args[0];
    const cb = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined;
    if (m && typeof m === 'object' && OFFSCREEN_TYPES.has(m.type) && hasHandlers()) {
      const p = handle(m);
      if (cb) { p.then(cb, () => cb(undefined)); return; }
      return p;
    }
    return _send(...args);
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
