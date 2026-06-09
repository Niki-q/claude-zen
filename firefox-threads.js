// firefox-threads.js — Claude Zen "thread switcher"
// ─────────────────────────────────────────────────────────────────────────────
// WHY: Chrome's side panel is per-tab, so switching tab groups automatically swaps
// the sidebar to that session's conversation. Firefox's sidebar is a single GLOBAL
// instance pinned to one `?tabId=N` (resolved once by firefox-page-shims.js). With
// several Claude sessions open there is no way to switch which conversation the
// sidebar shows, nor to get from a Claude-driven page back to its thread.
//
// A "thread" = one Claude group in the registry (__ffGroupMeta / __ffTabGroup,
// owned by firefox-page-shims.js), addressed by its MAIN TAB. This file adds:
//   • a dropdown thread switcher at the top of the sidebar (sidebar-only repoint),
//   • a per-thread "jump to tab" button (focuses that thread's browser tab),
//   • background handlers + an in-page "jump to thread" content script
//     (firefox-thread-jump.js, registered dynamically below).
//
// Loaded as a classic script in BOTH the background context (message handlers +
// content-script registration) and the sidepanel document (switcher UI). It reads
// the group registry straight from storage, so it does not depend on the private
// internals of the firefox-page-shims.js tab-groups IIFE.
//
// NOTE: Firefox cannot OPEN a closed sidebar without a live user gesture, and a
// content-script click can't carry one across messaging — so the in-page button
// only repoints an ALREADY-OPEN sidebar (the normal case while using Claude) and
// otherwise hints the user to open it. See sidebarAction.open() docs.
(function () {
  'use strict';
  const api = (typeof browser !== 'undefined' ? browser : chrome);
  if (!api || !api.storage) return;
  const store = api.storage.session || api.storage.local;
  const K_META = '__ffGroupMeta', K_MEMB = '__ffTabGroup';
  const LOG = '[claude-zen][threads]';

  // Background detection mirrors firefox-page-shims.js (FF background is a real DOM
  // page, so `typeof document === 'undefined'` is false there — don't use it alone).
  const isBackground = (() => {
    if (typeof document === 'undefined') return true; // Chrome MV3 service worker
    try { if (typeof location !== 'undefined' && /_generated_background_page\.html$/.test(location.pathname || '')) return true; } catch (e) {}
    try { if (chrome.extension && typeof chrome.extension.getBackgroundPage === 'function' && chrome.extension.getBackgroundPage() === window) return true; } catch (e) {}
    return false;
  })();
  const isSidepanel = (typeof document !== 'undefined' && typeof location !== 'undefined' &&
    /\/sidepanel\.html$/.test(location.pathname || ''));

  // ── registry → thread model ────────────────────────────────────────────────
  const getState = async () => {
    try { const o = await store.get([K_META, K_MEMB]); return { meta: o[K_META] || {}, memb: o[K_MEMB] || {} }; }
    catch (e) { return { meta: {}, memb: {} }; }
  };
  const tabGet = (id) => new Promise((res) => {
    try { const r = api.tabs.get(id, (t) => res(t)); if (r && typeof r.then === 'function') r.then(res, () => res(null)); }
    catch (e) { res(null); }
  });

  const threadFromMeta = async (gid, st) => {
    const m = st.meta[gid];
    if (!m) return null;
    const members = Object.keys(st.memb).filter((t) => String(st.memb[t]) === String(gid)).map(Number);
    let mainTabId = m.mainTabId;
    if (mainTabId == null || members.indexOf(mainTabId) === -1) mainTabId = members[0];
    if (mainTabId == null) return null;
    const info = await tabGet(mainTabId);
    if (!info) return null; // main tab gone → skip stale thread
    let host = '';
    try { host = new URL(info.url || '').host; } catch (e) {}
    return {
      groupId: Number(gid), mainTabId: mainTabId, windowId: m.windowId, native: !!m.native,
      tabIds: members, memberCount: members.length || 1,
      title: info.title || host || 'Claude', host: host, url: info.url || '',
    };
  };
  const getThreads = async () => {
    const st = await getState();
    const out = [];
    const gids = Object.keys(st.meta);
    for (let i = 0; i < gids.length; i++) { const t = await threadFromMeta(gids[i], st); if (t) out.push(t); }
    out.sort((a, b) => a.groupId - b.groupId);
    return out;
  };
  const threadForTab = async (tabId) => {
    const st = await getState();
    const gid = st.memb[tabId];
    if (gid == null) return null;
    return threadFromMeta(gid, st);
  };
  // Expose for other shims / debugging.
  self.__ffGetThreads = getThreads;
  self.__ffThreadForTab = threadForTab;

  // ── BACKGROUND: register the in-page content script + message handlers ───────
  if (isBackground) {
    if (api.scripting && api.scripting.registerContentScripts) {
      (async () => {
        try { await api.scripting.unregisterContentScripts({ ids: ['cz-thread-jump'] }); } catch (e) {}
        try {
          await api.scripting.registerContentScripts([{
            id: 'cz-thread-jump',
            js: ['firefox-thread-jump.js'],
            matches: ['<all_urls>'],
            runAt: 'document_idle',
            allFrames: false,
            persistAcrossSessions: false,
          }]);
          console.log(LOG, 'jump content script registered');
        } catch (e) { console.warn(LOG, 'registerContentScripts failed', e && e.message); }
      })();
    }

    // True only when the message came from one of OUR extension pages (sidepanel),
    // not from a content script / web page. Used to gate handlers that act on an
    // arbitrary, caller-supplied tabId (focus / open tabs), so a compromised or buggy
    // content script can't drive the user's tabs. Membership/jump handlers stay open
    // to content scripts because they only ever act on the SENDER'S OWN tab.
    let __selfPrefix = '';
    try { __selfPrefix = api.runtime.getURL('/'); } catch (e) {}
    const fromExtPage = (sender) =>
      !!(sender && typeof sender.url === 'string' && __selfPrefix && sender.url.indexOf(__selfPrefix) === 0);

    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string' || msg.type.indexOf('FF_') !== 0) return;

      if (msg.type === 'FF_THREAD_MEMBERSHIP') {
        const tid = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : msg.tabId;
        threadForTab(tid)
          .then((t) => sendResponse(t ? { inGroup: true, groupId: t.groupId, mainTabId: t.mainTabId } : { inGroup: false }))
          .catch(() => sendResponse({ inGroup: false }));
        return true; // async response
      }

      if (msg.type === 'FF_FOCUS_TAB') {
        if (!fromExtPage(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return true; }
        (async () => {
          try {
            await api.tabs.update(msg.tabId, { active: true });
            if (msg.windowId != null && api.windows && api.windows.update) {
              try { await api.windows.update(msg.windowId, { focused: true }); } catch (e) {}
            }
            sendResponse({ ok: true });
          } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        })();
        return true;
      }

      if (msg.type === 'FF_JUMP_TO_THREAD') {
        (async () => {
          const tid = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : msg.tabId;
          const t = await threadForTab(tid);
          if (!t) { sendResponse({ ok: false, reason: 'no-thread' }); return; }
          // We can't open a closed sidebar from here (no user gesture survives the
          // message hop), so detect whether it's open and report it to the page.
          let open = false;
          try { if (api.sidebarAction && api.sidebarAction.isOpen) open = await api.sidebarAction.isOpen({}); } catch (e) {}
          try { await api.runtime.sendMessage({ type: 'FF_SWITCH_THREAD', tabId: t.mainTabId }); } catch (e) {}
          sendResponse({ ok: true, delivered: open, mainTabId: t.mainTabId });
        })();
        return true;
      }

      if (msg.type === 'FF_NEW_THREAD') {
        if (!fromExtPage(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return true; }
        (async () => {
          try {
            // "this tab" = the tab the user is currently on (active, focused window).
            let anchorId = (msg.tabId != null) ? Number(msg.tabId) : null;
            if (anchorId == null) {
              const tabs = await new Promise((res) => {
                try { const r = api.tabs.query({ active: true, lastFocusedWindow: true }, (t) => res(t || [])); if (r && r.then) r.then(res, () => res([])); }
                catch (e) { res([]); }
              });
              anchorId = (tabs[0] && tabs[0].id != null) ? tabs[0].id : null;
            }
            if (anchorId == null) { sendResponse({ ok: false, reason: 'no-active-tab' }); return; }
            // If this tab is already a Claude thread, don't clobber its conversation —
            // open a fresh tab to anchor the new thread instead. (The bundle's own
            // "new chat" button covers starting a new chat within an existing thread.)
            const existing = await threadForTab(anchorId);
            if (existing) {
              const nt = await new Promise((res) => {
                try { const r = api.tabs.create({ active: true, url: 'https://duckduckgo.com' }, (t) => res(t)); if (r && r.then) r.then(res, () => res(null)); }
                catch (e) { res(null); }
              });
              if (nt && nt.id != null) anchorId = nt.id;
            }
            // Seed/anchor the group on this tab so it becomes a switchable thread.
            // makeGroupable: if the adopted current tab is a privileged page, it gets
            // sent to a groupable Claude page so it visibly joins the group.
            if (self.__ffEnsureMainGroup) await self.__ffEnsureMainGroup(anchorId, { makeGroupable: true });
            sendResponse({ ok: true, mainTabId: anchorId, reused: !existing });
          } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        })();
        return true;
      }
      return;
    });

    // ── Scope the GLOBAL Firefox sidebar to Claude's tabs ──────────────────────
    // Firefox's sidebar is one global instance shown on EVERY tab and window, so it
    // lingers on pages that have nothing to do with Claude. When the user activates a
    // tab that is NOT part of any Claude thread (and isn't the tab the sidebar is
    // pinned to), close it. We canNOT auto-reopen on return — Firefox requires a live
    // user gesture to OPEN a sidebar — so the user reopens with Ctrl+E; but it no longer
    // sticks to unrelated tabs/windows. The sidepanel records its pinned tab in
    // storage.session (__ffSidebarTab) so we never close the sidebar's own tab.
    const K_SIDETAB = '__ffSidebarTab';
    const sidebarPinnedTab = async () => {
      try { const o = await store.get(K_SIDETAB); const v = o && o[K_SIDETAB]; return v != null ? Number(v) : null; }
      catch (e) { return null; }
    };
    const closeSidebarIfForeign = async (tabId) => {
      try {
        if (tabId == null || !api.sidebarAction) return;
        let open = true;
        try { if (api.sidebarAction.isOpen) open = await api.sidebarAction.isOpen({}); } catch (e) {}
        if (!open) return;                                  // nothing to close
        if (tabId === await sidebarPinnedTab()) return;      // the sidebar's own tab — keep
        const t = await threadForTab(tabId);
        if (t) return;                                       // a Claude thread tab — keep
        try { await api.sidebarAction.close(); } catch (e) {} // foreign tab — close (best-effort)
      } catch (e) {}
    };
    if (api.tabs && api.tabs.onActivated) {
      api.tabs.onActivated.addListener((info) => { if (info) closeSidebarIfForeign(info.tabId); });
    }
    if (api.windows && api.windows.onFocusChanged) {
      api.windows.onFocusChanged.addListener(async (winId) => {
        try {
          if (winId == null || (api.windows.WINDOW_ID_NONE != null && winId === api.windows.WINDOW_ID_NONE)) return;
          const tabs = await new Promise((res) => {
            try { const r = api.tabs.query({ active: true, windowId: winId }, (t) => res(t || [])); if (r && r.then) r.then(res, () => res([])); }
            catch (e) { res([]); }
          });
          if (tabs[0] && tabs[0].id != null) closeSidebarIfForeign(tabs[0].id);
        } catch (e) {}
      });
    }

    console.log(LOG, 'background handlers ready');
  }

  // ── SIDEPANEL: thread switcher UI ───────────────────────────────────────────
  if (isSidepanel) {
    const ready = (fn) => { if (document.body) fn(); else document.addEventListener('DOMContentLoaded', fn, { once: true }); };
    ready(() => {
      let threads = [];
      let listOpen = false;

      const curTabId = () => {
        const v = new URLSearchParams(location.search).get('tabId');
        if (v != null && v !== '') return Number(v);
        return (window.__ffActiveTabId != null) ? Number(window.__ffActiveTabId) : null;
      };
      const repoint = (tabId) => {
        if (tabId == null) return;
        const u = new URL(location.href);
        u.searchParams.set('tabId', String(tabId));
        location.replace(u.toString()); // full reload → bundle re-runs for that thread
      };

      // Record which tab THIS sidebar is pinned to, so the background's sidebar-scoping
      // (closeSidebarIfForeign) never closes the sidebar on its own tab. Re-runs on every
      // repoint reload (location.replace re-loads this script).
      try { const tid = curTabId(); if (tid != null) store.set({ __ffSidebarTab: tid }); } catch (e) {}
      // Start a new thread. Background adopts the current page as the thread when it
      // isn't already a Claude thread, else opens a fresh tab; we then point the
      // sidebar at it. Resolves to a clean new context, so there's no history to lose.
      const newThread = async () => {
        try {
          const resp = await api.runtime.sendMessage({ type: 'FF_NEW_THREAD' });
          if (resp && resp.ok && resp.mainTabId != null) {
            closeMenu();
            if (resp.mainTabId !== curTabId()) repoint(resp.mainTabId);
            else refresh();
          }
        } catch (e) { console.warn(LOG, 'new thread failed', e && e.message); }
      };
      const currentThread = () => {
        const cur = curTabId();
        return threads.filter((t) => t.mainTabId === cur)[0] ||
               threads.filter((t) => t.tabIds.indexOf(cur) !== -1)[0] || null;
      };

      // Pill (collapsed) — floats over the very top of the sidebar; no layout reflow.
      const pill = document.createElement('div');
      pill.id = 'cz-thread-pill';
      pill.style.cssText = [
        'position:fixed', 'top:6px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483646', 'display:none', 'align-items:center', 'gap:6px',
        'max-width:92%', 'box-sizing:border-box', 'padding:4px 10px',
        'font:12px/1.2 system-ui,-apple-system,sans-serif', 'background:Canvas', 'color:CanvasText',
        'border:1px solid rgba(127,127,127,.35)', 'border-radius:999px',
        'box-shadow:0 2px 8px rgba(0,0,0,.18)', 'cursor:pointer', 'user-select:none', 'opacity:.96',
      ].join(';');
      const caret = document.createElement('span'); caret.textContent = '▾'; caret.style.opacity = '.7';
      const label = document.createElement('span');
      label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:240px';
      label.textContent = 'Claude threads';
      const newBtn = document.createElement('button');
      newBtn.type = 'button';
      newBtn.textContent = '＋';
      newBtn.title = 'New thread';
      newBtn.style.cssText = 'flex:none;margin-left:2px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;border-radius:999px;width:20px;height:20px;line-height:1;cursor:pointer;font:14px/1 system-ui;padding:0';
      newBtn.onclick = (e) => { e.stopPropagation(); newThread(); };
      pill.appendChild(caret); pill.appendChild(label); pill.appendChild(newBtn);

      const menu = document.createElement('div');
      menu.id = 'cz-thread-menu';
      menu.style.cssText = [
        'position:fixed', 'top:36px', 'left:50%', 'transform:translateX(-50%)',
        'width:320px', 'max-width:92%', 'max-height:60vh', 'overflow:auto',
        'z-index:2147483646', 'display:none', 'background:Canvas', 'color:CanvasText',
        'border:1px solid rgba(127,127,127,.35)', 'border-radius:10px',
        'box-shadow:0 8px 24px rgba(0,0,0,.30)', 'font:12px/1.3 system-ui,-apple-system,sans-serif',
      ].join(';');

      document.body.appendChild(pill);
      document.body.appendChild(menu);

      const fmt = (t) => 'Claude · ' + (t.host || t.title || ('group ' + t.groupId)) +
        (t.memberCount > 1 ? ' (' + t.memberCount + ')' : '');

      const renderLabel = () => {
        const t = currentThread();
        label.textContent = t ? fmt(t) : 'Claude · switch thread';
      };
      const renderMenu = () => {
        menu.textContent = '';
        const cur = curTabId();

        // Always-present "New thread" action at the top.
        const newRow = document.createElement('div');
        newRow.style.cssText = 'display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid rgba(127,127,127,.15);cursor:pointer;font-weight:600';
        newRow.textContent = '＋  New thread';
        newRow.onmouseenter = () => { newRow.style.background = 'rgba(127,127,127,.10)'; };
        newRow.onmouseleave = () => { newRow.style.background = ''; };
        newRow.onclick = () => { newThread(); };
        menu.appendChild(newRow);

        if (!threads.length) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:10px 12px;opacity:.7';
          empty.textContent = 'No Claude threads yet';
          menu.appendChild(empty);
          return;
        }
        threads.forEach((t) => {
          const active = (t.mainTabId === cur) || (t.tabIds.indexOf(cur) !== -1);
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.15);' +
            (active ? 'background:rgba(127,127,127,.18);' : '');
          row.onmouseenter = () => { if (!active) row.style.background = 'rgba(127,127,127,.10)'; };
          row.onmouseleave = () => { if (!active) row.style.background = ''; };

          const dot = document.createElement('span');
          dot.textContent = active ? '●' : '○';
          dot.style.cssText = 'flex:none;opacity:' + (active ? '1' : '.5');

          const txt = document.createElement('div');
          txt.style.cssText = 'flex:1;min-width:0';
          const ln1 = document.createElement('div');
          ln1.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600';
          ln1.textContent = t.host || 'Claude';
          const ln2 = document.createElement('div');
          ln2.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.6;font-size:11px';
          ln2.textContent = (t.title || t.url || '') + (t.memberCount > 1 ? ' · ' + t.memberCount + ' tabs' : '');
          txt.appendChild(ln1); txt.appendChild(ln2);

          const jump = document.createElement('button');
          jump.type = 'button';
          jump.textContent = '⤴';
          jump.title = 'Focus this thread’s tab';
          jump.style.cssText = 'flex:none;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;cursor:pointer;font:13px/1 system-ui';
          jump.onclick = (e) => {
            e.stopPropagation();
            try { api.runtime.sendMessage({ type: 'FF_FOCUS_TAB', tabId: t.mainTabId, windowId: t.windowId }); } catch (err) {}
          };

          row.appendChild(dot); row.appendChild(txt); row.appendChild(jump);
          row.onclick = () => { closeMenu(); if (t.mainTabId !== cur) repoint(t.mainTabId); };
          menu.appendChild(row);
        });
      };

      const openMenu = () => { listOpen = true; caret.textContent = '▴'; menu.style.display = 'block'; renderMenu(); };
      const closeMenu = () => { listOpen = false; caret.textContent = '▾'; menu.style.display = 'none'; };

      const refresh = async () => {
        try { threads = await getThreads(); } catch (e) { threads = []; }
        // Always visible — the pill hosts the "+ New thread" button even with 0–1 threads.
        pill.style.display = 'flex';
        renderLabel();
        if (listOpen) renderMenu();
      };

      pill.onclick = () => { refresh().then(() => { if (listOpen) closeMenu(); else openMenu(); }); };
      document.addEventListener('click', (e) => {
        if (listOpen && !menu.contains(e.target) && !pill.contains(e.target)) closeMenu();
      });

      // Live updates when Claude creates/changes groups.
      try { api.storage.onChanged.addListener((ch) => { if (ch && (ch[K_META] || ch[K_MEMB])) refresh(); }); } catch (e) {}
      // In-page "jump to thread" → repoint this sidebar.
      try {
        api.runtime.onMessage.addListener((msg) => {
          if (msg && msg.type === 'FF_SWITCH_THREAD' && msg.tabId != null && msg.tabId !== curTabId()) repoint(msg.tabId);
        });
      } catch (e) {}

      refresh();
      console.log(LOG, 'switcher ready; tabId=' + curTabId());
    });
  }
})();
