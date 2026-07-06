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

  // Read a boolean flag from storage.local with a default (used for the Zen
  // cross-space unpin workaround toggle, __czSpaceSwitchUnpin).
  const getFlag = async (key, dflt) => {
    try { const o = await api.storage.local.get(key); return (o && o[key] != null) ? !!o[key] : dflt; }
    catch (e) { return dflt; }
  };
  // Console toggle: czSpaceSwitch(true|false) — enable/disable the unpin trick that
  // makes Zen switch Spaces when focusing a pinned Claude tab. Default ON.
  self.czSpaceSwitch = (on) => {
    const v = (on !== false);
    try { api.storage.local.set({ __czSpaceSwitchUnpin: v }); } catch (e) {}
    console.log(LOG, 'czSpaceSwitch →', v, '(focus-tab unpin workaround ' + (v ? 'ON' : 'OFF') + ')');
    return v;
  };

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

    // ── Main-tab close / Zen window-move: resurrect or auto-stop ──────────────
    // Chrome's side panel is per-tab: closing the session's tab closes the panel and
    // the session dies with it. Firefox's global sidebar stays pinned to the dead
    // ?tabId, the bundle keeps running, every tool returns "Invalid tab ID: N" /
    // empty availableTabs, and the model spins retrying — each retry re-sends the
    // whole conversation (observed: a session ended on 9 back-to-back tabs_context
    // calls against an empty group, pure token burn).
    //
    // Complication: in Zen, dragging a tab to ANOTHER WINDOW destroys the tab and
    // recreates it with a NEW id (stock Firefox preserves the id via detach/attach),
    // so onRemoved also fires for tabs the user merely moved. Strategy:
    //   • onRemoved of a registry tab → stash {url, gid, wasMain} for a grace window;
    //   • a tab navigating to that exact URL within it = the SAME logical tab →
    //     rebind the registry (memb, and meta.mainTabId if it anchored the thread).
    //     Driven tabs then stay controllable (tools enumerate members through our
    //     tabs.query overlay, which serves the new id). A moved MAIN tab still kills
    //     the live conversation — the bundle's session is hard-bound to the old
    //     ?tabId — so abort the zombie run (STOP_AGENT, keyed to the OLD id) and
    //     repoint the sidebar to the resurrected thread (FF_SWITCH_THREAD);
    //   • no matching tab within the grace window = a real close → STOP_AGENT
    //     (the same message the injected Stop button sends), mirroring Chrome.
    if (api.tabs && api.tabs.onRemoved && api.tabs.onUpdated) {
      const RESURRECT_MS = 2500;
      // Registry mirror, readable SYNCHRONOUSLY at event time: firefox-page-shims.js's
      // own onRemoved listener (registered earlier) prunes memb[tabId] concurrently,
      // so an async getState() here could already see the membership gone.
      let regMirror = { meta: {}, memb: {} };
      const refreshMirror = () => { getState().then((st) => { regMirror = st; }); };
      refreshMirror();
      try { api.storage.onChanged.addListener((ch) => { if (ch && (ch[K_META] || ch[K_MEMB])) refreshMirror(); }); } catch (e) {}

      const lastUrl = new Map(); // tabId → last committed URL (all tabs; cheap)
      try { api.tabs.query({}).then((ts) => { for (const t of ts || []) if (t && t.url) lastUrl.set(t.id, t.url); }); } catch (e) {}

      const pendingGone = new Map(); // url → {gid, wasMain, oldId, timer}
      const sendStop = (fromTabId) => {
        try { api.runtime.sendMessage({ type: 'STOP_AGENT', fromTabId }); } catch (e) {}
        console.log(LOG, 'main tab', fromTabId, 'gone — sent STOP_AGENT to abort its session');
      };

      api.tabs.onRemoved.addListener((tabId) => {
        const url = lastUrl.get(tabId);
        lastUrl.delete(tabId);
        const gid = regMirror.memb[tabId];
        if (gid == null) return;
        const m = regMirror.meta[gid] || {};
        const wasMain = (m.mainTabId != null)
          ? m.mainTabId === tabId
          : Object.keys(regMirror.memb).filter((t) => String(regMirror.memb[t]) === String(gid)).map(Number)[0] === tabId;
        if (!url) { if (wasMain) sendStop(tabId); return; }
        const entry = { gid, wasMain, oldId: tabId };
        entry.timer = setTimeout(() => {
          pendingGone.delete(url);
          if (wasMain) sendStop(tabId);
        }, RESURRECT_MS);
        pendingGone.set(url, entry);
      });

      const tryResurrect = async (newId, url) => {
        const e = pendingGone.get(url);
        if (!e || newId === e.oldId) return;
        pendingGone.delete(url);
        clearTimeout(e.timer);
        try {
          const st = await getState();
          st.memb[newId] = e.gid;
          const meta = st.meta[e.gid];
          if (meta && e.wasMain) meta.mainTabId = newId;
          await store.set({ [K_MEMB]: st.memb, [K_META]: st.meta });
          console.log(LOG, 'tab', e.oldId, 'moved/recreated as', newId, '— rebound in group', e.gid, e.wasMain ? '(main tab)' : '');
          // Re-evaluate the banner: onActivated for the recreated tab can fire BEFORE
          // this rebind lands (the new id isn't in the registry yet), leaving the
          // "вы на другой вкладке" banner stuck on the thread's own tab. Now that
          // memb[newId] is set, re-broadcast for the live active tab.
          try {
            const active = await new Promise((res) => {
              try { const r = api.tabs.query({ active: true, currentWindow: true }, (t) => res((t && t[0]) || null)); if (r && r.then) r.then((t) => res((t && t[0]) || null), () => res(null)); }
              catch (er) { res(null); }
            });
            if (active && active.id != null) broadcastForeign(active.id);
          } catch (er) {}
          if (e.wasMain) {
            sendStop(e.oldId); // the live session is hard-bound to the dead id — abort it
            try { api.runtime.sendMessage({ type: 'FF_SWITCH_THREAD', tabId: newId }); } catch (err) {}
          }
        } catch (err) {}
      };

      api.tabs.onUpdated.addListener((id, info) => {
        if (!info || !info.url) return;
        lastUrl.set(id, info.url);
        tryResurrect(id, info.url);
      });
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
          // mark: this thread has no visible NATIVE group (emulated, or Zen registry-only),
          // so the page should mark itself another way (◆ title prefix). Native-group
          // threads already show the orange "Claude" chrome, so no extra marker there.
          .then((t) => sendResponse(t ? { inGroup: true, groupId: t.groupId, mainTabId: t.mainTabId, mark: !t.native } : { inGroup: false }))
          .catch(() => sendResponse({ inGroup: false }));
        return true; // async response
      }

      // Resolve the session's MAIN tab for a driven tab, straight from OUR registry.
      // The injected Stop button uses this so STOP_AGENT carries the real numeric main
      // tabId — the bundle's own getMainTabId can miss it (its internal groupMetadata
      // and our registry can diverge), and then the abort never reaches the session.
      if (msg.type === 'FF_RESOLVE_MAIN_TAB') {
        const tid = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : msg.tabId;
        threadForTab(tid)
          .then((t) => sendResponse({ mainTabId: t ? t.mainTabId : null }))
          .catch(() => sendResponse({ mainTabId: null }));
        return true;
      }

      if (msg.type === 'FF_FOCUS_TAB') {
        if (!fromExtPage(sender)) {
          console.warn(LOG, 'FF_FOCUS_TAB forbidden — sender.url=', sender && sender.url, 'selfPrefix=', __selfPrefix);
          sendResponse({ ok: false, error: 'forbidden' }); return true;
        }
        (async () => {
          try {
            const tid = Number(msg.tabId);
            // Resolve the tab's real window (meta.windowId can be stale/missing,
            // and the tab may live in another window than the supplied one).
            let winId = (msg.windowId != null) ? msg.windowId : null;
            let info = null;
            try { info = await tabGet(tid); if (info && info.windowId != null) winId = info.windowId; } catch (e) {}
            // Zen Browser "Spaces": tabs in an inactive space are marked hidden
            // (tab.hidden===true). Firefox refuses to make a hidden tab active, so a
            // cross-space focus silently no-ops. Un-hide it first (needs "tabHide");
            // selecting it then makes Zen switch to that tab's space.
            if (info && info.hidden && api.tabs && api.tabs.show) {
              try { await api.tabs.show([tid]); console.log(LOG, 'un-hid cross-space tab', tid); }
              catch (e) { console.warn(LOG, 'tabs.show failed', tid, e && e.message); }
            }
            // Focus the window FIRST, then activate the tab inside it — activating a
            // tab in a non-focused window otherwise looks like "nothing happened".
            if (winId != null && api.windows && api.windows.update) {
              try { await api.windows.update(winId, { focused: true }); } catch (e) {}
            }
            await api.tabs.update(tid, { active: true });

            // Zen "Spaces": activating a PINNED tab (Zen essential / per-space pinned)
            // does NOT switch the visible space — Zen shows the essential in the current
            // space instead (zen-browser/desktop#5020, #901). A normal tab, on the other
            // hand, DOES make Zen follow on select (same tabs.update the upstream tab
            // switcher uses). Workaround: briefly UNPIN so the tab is a normal member of
            // its space → re-select → Zen switches → re-pin to restore the user's state.
            // Opt-out with czSpaceSwitch(false); it only ever runs for pinned tabs.
            let unpinTrick = false;
            if (info && info.pinned) {
              const useUnpin = await getFlag('__czSpaceSwitchUnpin', true);
              if (useUnpin) {
                try {
                  // Absolute indices are unreliable here: Zen keeps every Space's pinned
                  // tabs in ONE window, so info.index shifts after we switch Space + re-pin.
                  // Anchor to the NEIGHBOURING pinned tab by id instead and restore order
                  // relative to it (resolve its live index at move time).
                  let prevId = null, nextId = null;
                  try {
                    const all = await new Promise((res) => {
                      try { const r = api.tabs.query({ windowId: winId }, (t) => res(t || [])); if (r && r.then) r.then(res, () => res([])); }
                      catch (e) { res([]); }
                    });
                    all.sort((a, b) => a.index - b.index);
                    const pos = all.findIndex((t) => t.id === tid);
                    if (pos > 0 && all[pos - 1].pinned) prevId = all[pos - 1].id;
                    if (pos >= 0 && pos + 1 < all.length && all[pos + 1].pinned) nextId = all[pos + 1].id;
                  } catch (e) {}

                  await api.tabs.update(tid, { pinned: false });
                  await api.tabs.update(tid, { active: true });
                  unpinTrick = true;
                  // Re-pin, then slot back next to its original neighbour (re-pin appends
                  // to the END of the pinned strip otherwise).
                  setTimeout(async () => {
                    try {
                      await api.tabs.update(tid, { pinned: true });
                      const anchor = await tabGet(prevId != null ? prevId : nextId);
                      if (anchor && anchor.index != null) {
                        const target = (prevId != null) ? anchor.index + 1 : anchor.index;
                        try { await api.tabs.move(tid, { index: target }); } catch (e) {}
                      } else {
                        try { await api.tabs.move(tid, { index: 0 }); } catch (e) {}
                      }
                    } catch (e) {}
                  }, 600);
                } catch (e) { console.warn(LOG, 'space-switch unpin failed', tid, e && e.message); }
              }
            }
            console.log(LOG, 'FF_FOCUS_TAB → focused tab', tid, 'win', winId,
              'pinned', !!(info && info.pinned), 'unpinTrick', unpinTrick, 'wasHidden', !!(info && info.hidden));
            sendResponse({ ok: true, pinned: !!(info && info.pinned), unpinTrick: unpinTrick });
          } catch (e) {
            console.warn(LOG, 'FF_FOCUS_TAB failed', msg.tabId, e && e.message);
            sendResponse({ ok: false, error: e && e.message });
          }
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

      // Continue a past chat: re-seed a saved transcript into the live bundle. We convert
      // __czChats[chatId] → wire-format messages (czChatToStoreMessages, firefox-page-
      // shims.js) and write them to storage.local.test_data_messages — a key the upstream
      // sidepanel reads on mount and hydrates into its conversation store. The sidepanel
      // then location.replace()s to ?tabId=<targetTabId> so the bundle re-runs + hydrates.
      if (msg.type === 'FF_CONTINUE_CHAT') {
        if (!fromExtPage(sender)) { sendResponse({ ok: false, error: 'forbidden' }); return true; }
        (async () => {
          try {
            const chatId = msg.chatId;
            if (!chatId) { sendResponse({ ok: false, error: 'no-chat-id' }); return; }
            const localStore = api.storage && api.storage.local;
            const o = await localStore.get('__czChats');
            const chat = o && o.__czChats && o.__czChats[chatId];
            if (!chat) { sendResponse({ ok: false, error: 'not-found' }); return; }
            const messages = (typeof self.czChatToStoreMessages === 'function')
              ? self.czChatToStoreMessages(chat) : [];
            if (!messages.length) { sendResponse({ ok: false, error: 'empty' }); return; }
            // Target tab: if the chat's original tab still maps to a live thread, continue
            // on that thread's main tab (agent keeps acting on the same tabs); else fall
            // back to the sidebar's current tab (post-restart → agent starts a fresh group).
            let targetTabId = null;
            try {
              if (chat.tabId != null) {
                const t = await threadForTab(Number(chat.tabId));
                if (t && t.mainTabId != null) targetTabId = t.mainTabId;
              }
            } catch (e) {}
            if (targetTabId == null && msg.fallbackTabId != null) targetTabId = Number(msg.fallbackTabId);
            await localStore.set({ test_data_messages: messages });
            console.log(LOG, 'FF_CONTINUE_CHAT seeded', messages.length, 'msgs → tab', targetTabId, 'chat', chatId);
            sendResponse({ ok: true, targetTabId, count: messages.length });
          } catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        })();
        return true;
      }
      return;
    });

    // ── Tell the sidebar when the active tab is NOT its Claude tab ──────────────
    // Firefox's sidebar is one GLOBAL instance shown on every tab/window, and the
    // platform gives NO way to auto-close it: sidebarAction.close()/open() may only be
    // called from a user-gesture handler (MDN), never from tabs.onActivated. So we can't
    // hide it programmatically. Instead we leave the chat fully usable everywhere and
    // just BROADCAST whether the current tab belongs to the sidebar's thread; the
    // sidepanel shows a slim "you're on another tab — Claude keeps working in its own
    // tab" banner when foreign. The agent already acts only on its group's tabs, so the
    // user can keep typing here and browse freely elsewhere without interference.
    // The sidepanel records its pinned tab in storage.session (__ffSidebarTab).
    const K_SIDETAB = '__ffSidebarTab';
    const K_SIDEGROUP = '__ffSidebarGroup';
    const sidebarPinnedTab = async () => {
      try { const o = await store.get(K_SIDETAB); const v = o && o[K_SIDETAB]; return v != null ? Number(v) : null; }
      catch (e) { return null; }
    };
    // The sidebar's GROUP id — stable across Zen's tab-id recreation (the registry
    // rebinds memb/meta to the new tab id on a window/space move but keeps the same
    // gid). The pinned tab id is NOT stable, so keying foreign-detection on it left
    // the "вы на другой вкладке" banner stuck after a move: the stale pinned id no
    // longer resolved to a thread, so even the thread's own (recreated) main tab read
    // as foreign. The sidepanel persists this whenever it can resolve its thread.
    const sidebarGroup = async () => {
      try { const o = await store.get(K_SIDEGROUP); const v = o && o[K_SIDEGROUP]; return v != null ? Number(v) : null; }
      catch (e) { return null; }
    };
    // foreign = active tab is neither the sidebar's pinned tab nor in the sidebar's group.
    const isForeignTab = async (tabId) => {
      const pinned = await sidebarPinnedTab();
      if (pinned != null && tabId === pinned) return false; // the sidebar's own (live) tab
      // Primary, recreation-proof check: compare GROUP ids, not tab ids.
      const grp = await sidebarGroup();
      if (grp != null) {
        const cur = await threadForTab(tabId);
        return !(cur && cur.groupId === grp);
      }
      // Fallback (group not resolved yet): the original pinned-id comparison.
      if (pinned == null) return false;          // sidebar not bound yet — nothing to scope
      const cur = await threadForTab(tabId);
      if (cur) {
        const pin = await threadForTab(pinned);
        if (pin && cur.groupId === pin.groupId) return false; // same thread as pinned
      }
      return true;
    };
    const broadcastForeign = async (tabId) => {
      try {
        if (tabId == null) return;
        const foreign = await isForeignTab(tabId);
        // Delivered to the sidepanel (not back to background); harmless if no panel open.
        try { await api.runtime.sendMessage({ type: 'FF_ACTIVE_TAB', activeTabId: tabId, foreign }); } catch (e) {}
      } catch (e) {}
    };
    if (api.tabs && api.tabs.onActivated) {
      api.tabs.onActivated.addListener((info) => { if (info) broadcastForeign(info.tabId); });
    }
    if (api.windows && api.windows.onFocusChanged) {
      api.windows.onFocusChanged.addListener(async (winId) => {
        try {
          if (winId == null || (api.windows.WINDOW_ID_NONE != null && winId === api.windows.WINDOW_ID_NONE)) return;
          const tabs = await new Promise((res) => {
            try { const r = api.tabs.query({ active: true, windowId: winId }, (t) => res(t || [])); if (r && r.then) r.then(res, () => res([])); }
            catch (e) { res([]); }
          });
          if (tabs[0] && tabs[0].id != null) broadcastForeign(tabs[0].id);
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
      let recents = [];
      let listOpen = false;
      const localStore = api.storage && api.storage.local;

      // Saved chats (firefox-page-shims capture → storage.local.__czChats), newest first.
      const loadRecents = async () => {
        try {
          const o = localStore && await localStore.get('__czChats');
          const c = (o && o.__czChats) || {};
          // Two passes of de-noising so the list reads as CHATS, not per-turn snapshots:
          //   1. Drop the bundle's cosmetic status/title generator calls (their first
          //      message is wrapped in <message>…/<conversation>…). Historical ones may
          //      still be in storage if no capture has rewritten the file yet.
          //   2. Collapse the growing snapshots of ONE conversation — every turn was once
          //      saved under a fresh chatId (the curMap-poisoning bug) so the same dialog
          //      appears as 114/118/…/132-msg rows. Group by first-message signature and
          //      keep only the most complete (max turns, then latest) per signature.
          const isAux = (s) => /^\s*<message>|^\s*<conversation>/.test(String(s || ''));
          const byKey = new Map();
          for (const chat of Object.values(c)) {
            const sig = (chat && (chat.sig || chat.title)) || '';
            if (isAux(sig)) continue;
            const key = sig ? sig.trim().slice(0, 120) : ('__id:' + (chat && chat.id));
            const cur = byKey.get(key);
            if (!cur || (chat.turns || 0) > (cur.turns || 0) ||
                ((chat.turns || 0) === (cur.turns || 0) && (chat.updatedAt || 0) > (cur.updatedAt || 0))) {
              byKey.set(key, chat);
            }
          }
          return Array.from(byKey.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 25);
        } catch (e) { return []; }
      };

      // ── Read-only transcript viewer ──────────────────────────────────────────
      const viewer = document.createElement('div');
      viewer.id = 'cz-chat-viewer';
      viewer.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647', 'display:none',
        'background:Canvas', 'color:CanvasText', 'overflow:auto', 'padding:0',
        'font:13px/1.5 system-ui,-apple-system,sans-serif',
      ].join(';');
      const viewerBar = document.createElement('div');
      viewerBar.style.cssText = 'position:sticky;top:0;display:flex;align-items:center;gap:8px;padding:8px 12px;background:Canvas;border-bottom:1px solid rgba(127,127,127,.3);';
      const viewerBack = document.createElement('button');
      viewerBack.textContent = '← Back'; viewerBack.type = 'button';
      viewerBack.style.cssText = 'border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;border-radius:6px;padding:4px 10px;cursor:pointer';
      const viewerTitle = document.createElement('div');
      viewerTitle.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600';
      const viewerContinue = document.createElement('button');
      viewerContinue.textContent = '▶ Continue'; viewerContinue.type = 'button'; viewerContinue.title = 'Re-load this chat into the live agent';
      viewerContinue.style.cssText = viewerBack.style.cssText + ';font-weight:600';
      const viewerExport = document.createElement('button');
      viewerExport.textContent = '⬇ .md'; viewerExport.type = 'button'; viewerExport.title = 'Export transcript';
      viewerExport.style.cssText = viewerBack.style.cssText;
      viewerBar.appendChild(viewerBack); viewerBar.appendChild(viewerTitle); viewerBar.appendChild(viewerContinue); viewerBar.appendChild(viewerExport);
      const viewerBody = document.createElement('div');
      viewerBody.style.cssText = 'padding:12px;white-space:pre-wrap;word-break:break-word';
      viewer.appendChild(viewerBar); viewer.appendChild(viewerBody);
      document.body.appendChild(viewer);
      viewerBack.onclick = () => { viewer.style.display = 'none'; };
      const openViewer = (chat) => {
        viewerTitle.textContent = chat.title || 'Chat';
        // Reuse the markdown renderer from firefox-page-shims; show as preformatted text.
        viewerBody.textContent = (typeof self.czRenderChatMd === 'function')
          ? self.czRenderChatMd(chat)
          : JSON.stringify(chat.messages || [], null, 2);
        viewerExport.onclick = () => { try { if (self.czChatExport) self.czChatExport(chat.id); } catch (e) {} };
        viewerContinue.onclick = () => { continueChat(chat); };
        viewer.style.display = 'block';
        viewer.scrollTop = 0;
      };

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

      // Continue a past chat: ask the background to seed the saved transcript into the
      // bundle (storage.local.test_data_messages), then repoint this sidebar to the
      // resolved tab. The full reload re-runs the bundle, whose on-mount loader reads the
      // seed and hydrates the live conversation. If the chat's old thread is still alive
      // the background returns its main tab; otherwise we stay on the current tab.
      const continueChat = async (chat) => {
        if (!chat || !chat.id) return;
        try {
          const resp = await api.runtime.sendMessage({
            type: 'FF_CONTINUE_CHAT', chatId: chat.id, fallbackTabId: curTabId(),
          });
          if (!resp || !resp.ok) { console.warn(LOG, 'continue failed', resp && resp.error); return; }
          const target = (resp.targetTabId != null) ? resp.targetTabId : curTabId();
          if (target != null) repoint(target); else location.reload();
        } catch (e) { console.warn(LOG, 'continue error', e && e.message); }
      };

      // Record which tab THIS sidebar is pinned to, so the background's sidebar-scoping
      // (closeSidebarIfForeign) never closes the sidebar on its own tab. Re-runs on every
      // repoint reload (location.replace re-loads this script). Also resolve and persist
      // the sidebar's GROUP id — stable across Zen's tab-id recreation, so the foreign-tab
      // banner keeps scoping to this thread even after a window/space move (see
      // isForeignTab → sidebarGroup in the background block).
      try {
        const tid = curTabId();
        if (tid != null) {
          store.set({ __ffSidebarTab: tid });
          const p = api.runtime.sendMessage({ type: 'FF_THREAD_MEMBERSHIP', tabId: tid });
          if (p && p.then) p.then((r) => {
            if (r && r.inGroup && r.groupId != null) { try { store.set({ __ffSidebarGroup: r.groupId }); } catch (e) {} }
          }, () => {});
        }
      } catch (e) {}
      const currentThread = () => {
        const cur = curTabId();
        return threads.filter((t) => t.mainTabId === cur)[0] ||
               threads.filter((t) => t.tabIds.indexOf(cur) !== -1)[0] || null;
      };
      // "+ New thread".
      //   • Already on a live Claude thread → just a FRESH CHAT in it: reload the sidepanel
      //     on the SAME tab. The bundle keeps the conversation only in volatile state (no
      //     persistence), so a reload starts an empty chat — WITHOUT spawning a new browser
      //     tab or a second tab group (the old FF_NEW_THREAD path opened a duckduckgo tab +
      //     made a new group, which the user does not want). The thread's existing group is
      //     reused, so the agent can still act.
      //   • Not on a thread (post-restart, or sidebar on a non-Claude tab) → adopt/create
      //     one via the background (FF_NEW_THREAD), then point the sidebar at it.
      const newThread = async () => {
        try {
          // Authoritative "am I on a thread?" — ask the background (the in-memory `threads`
          // can lag a group change); fall back to the synchronous local check.
          const tid = curTabId();
          let onThread = !!currentThread();
          if (tid != null) {
            try {
              const r = await api.runtime.sendMessage({ type: 'FF_THREAD_MEMBERSHIP', tabId: tid });
              if (r && typeof r.inGroup === 'boolean') onThread = r.inGroup;
            } catch (e) {}
          }
          if (onThread) {
            closeMenu();
            // Clear the Continue seed so the reload is a guaranteed-empty chat (avoids a
            // race where a just-continued transcript would re-hydrate on reload).
            try { if (localStore && localStore.remove) await localStore.remove('test_data_messages'); } catch (e) {}
            location.reload();
            return;
          }
          const resp = await api.runtime.sendMessage({ type: 'FF_NEW_THREAD' });
          if (resp && resp.ok && resp.mainTabId != null) {
            closeMenu();
            if (resp.mainTabId !== curTabId()) repoint(resp.mainTabId);
            else refresh();
          }
        } catch (e) { console.warn(LOG, 'new thread failed', e && e.message); }
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

      // ── Foreign-tab banner ─────────────────────────────────────────────────
      // Firefox can't close its global sidebar on tab switch (close() needs a user
      // gesture), so instead of hiding the chat we just notify: when the active browser
      // tab isn't this thread's tab, show a slim non-blocking bar. The chat stays fully
      // usable — the user can keep replying and the agent keeps working in its OWN tab
      // (it only ever acts on its group's tabs), so other tabs are undisturbed.
      const fbanner = document.createElement('div');
      fbanner.id = 'cz-foreign-banner';
      fbanner.style.cssText = [
        'position:fixed', 'top:34px', 'left:50%', 'transform:translateX(-50%)',
        'z-index:2147483645', 'display:none', 'align-items:center', 'gap:8px',
        'max-width:94%', 'box-sizing:border-box', 'padding:5px 10px',
        'font:11.5px/1.3 system-ui,-apple-system,sans-serif',
        'background:rgba(180,120,0,.16)', 'color:CanvasText',
        'border:1px solid rgba(200,140,0,.5)', 'border-radius:8px',
        'box-shadow:0 2px 8px rgba(0,0,0,.18)',
      ].join(';');
      const fbText = document.createElement('span');
      fbText.style.cssText = 'flex:1;min-width:0';
      fbText.textContent = '⚠ Вы на другой вкладке. Чат доступен — Claude работает в своей вкладке.';
      const fbJump = document.createElement('button');
      fbJump.type = 'button';
      fbJump.textContent = '⤴';
      fbJump.title = 'Перейти на вкладку Claude';
      fbJump.style.cssText = 'flex:none;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;border-radius:6px;width:22px;height:20px;line-height:1;cursor:pointer;font:13px/1 system-ui;padding:0';
      fbJump.onclick = () => {
        const tid = curTabId();
        if (tid != null) {
          // Optimistic: the user explicitly asked to go to Claude's tab. If they were
          // already on it (focusing an active tab fires no onActivated), nothing would
          // re-evaluate, so clear now; a real onActivated will re-affirm if not.
          setForeign(false);
          try {
            const p = api.runtime.sendMessage({ type: 'FF_FOCUS_TAB', tabId: tid });
            if (p && p.then) p.then((r) => { if (!r || !r.ok) console.warn(LOG, 'banner focus-tab no-op', r); }, (err) => console.warn(LOG, 'banner focus-tab send failed', err && err.message));
          } catch (e) { console.warn(LOG, 'banner focus-tab threw', e && e.message); }
        }
      };
      const fbClose = document.createElement('button');
      fbClose.type = 'button';
      fbClose.textContent = '✕';
      fbClose.title = 'Скрыть';
      fbClose.style.cssText = 'flex:none;border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;font:12px/1 system-ui;padding:2px';
      fbClose.onclick = () => { fbanner.style.display = 'none'; };
      fbanner.appendChild(fbText); fbanner.appendChild(fbJump); fbanner.appendChild(fbClose);
      document.body.appendChild(fbanner);
      const setForeign = (foreign) => { fbanner.style.display = foreign ? 'flex' : 'none'; };

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
          empty.textContent = 'No open Claude threads';
          menu.appendChild(empty);
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
            try {
              const p = api.runtime.sendMessage({ type: 'FF_FOCUS_TAB', tabId: t.mainTabId, windowId: t.windowId });
              if (p && p.then) p.then((r) => { if (!r || !r.ok) console.warn(LOG, 'focus-tab no-op', r); }, (err) => console.warn(LOG, 'focus-tab send failed', err && err.message));
            } catch (err) { console.warn(LOG, 'focus-tab threw', err && err.message); }
          };

          row.appendChild(dot); row.appendChild(txt); row.appendChild(jump);
          row.onclick = () => { closeMenu(); if (t.mainTabId !== cur) repoint(t.mainTabId); };
          menu.appendChild(row);
        });

        // ── Recent (saved) chats — survive sidebar close + restart ──────────────
        // Row click opens the read-only viewer; ▶ re-seeds the chat into the live agent
        // (continueChat → FF_CONTINUE_CHAT); 🗑 deletes the saved transcript.
        if (recents.length) {
          const hdr = document.createElement('div');
          hdr.style.cssText = 'padding:8px 12px 4px;opacity:.55;font-size:11px;text-transform:uppercase;letter-spacing:.04em;border-top:1px solid rgba(127,127,127,.2)';
          hdr.textContent = 'Recent chats';
          menu.appendChild(hdr);
          recents.forEach((chat) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid rgba(127,127,127,.12);cursor:pointer';
            row.onmouseenter = () => { row.style.background = 'rgba(127,127,127,.10)'; };
            row.onmouseleave = () => { row.style.background = ''; };
            const txt = document.createElement('div');
            txt.style.cssText = 'flex:1;min-width:0';
            const ln1 = document.createElement('div');
            ln1.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
            ln1.textContent = chat.title || 'Untitled chat';
            const ln2 = document.createElement('div');
            ln2.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.55;font-size:11px';
            ln2.textContent = (chat.turns || 0) + ' msgs · ' + new Date(chat.updatedAt || Date.now()).toLocaleString();
            txt.appendChild(ln1); txt.appendChild(ln2);
            const cont = document.createElement('button');
            cont.type = 'button'; cont.textContent = '▶'; cont.title = 'Continue this chat (load into the live agent)';
            cont.style.cssText = 'flex:none;border:none;background:transparent;color:inherit;opacity:.6;cursor:pointer;font:13px/1 system-ui';
            cont.onclick = (e) => { e.stopPropagation(); continueChat(chat); };
            const del = document.createElement('button');
            del.type = 'button'; del.textContent = '🗑'; del.title = 'Delete saved chat';
            del.style.cssText = 'flex:none;border:none;background:transparent;color:inherit;opacity:.5;cursor:pointer;font:12px/1 system-ui';
            del.onclick = (e) => { e.stopPropagation(); try { if (self.czChatDelete) self.czChatDelete(chat.id); } catch (err) {} recents = recents.filter((c) => c.id !== chat.id); renderMenu(); };
            row.appendChild(txt); row.appendChild(cont); row.appendChild(del);
            row.onclick = () => { openViewer(chat); };
            menu.appendChild(row);
          });
        }
      };

      const openMenu = () => { listOpen = true; caret.textContent = '▴'; menu.style.display = 'block'; renderMenu(); };
      const closeMenu = () => { listOpen = false; caret.textContent = '▾'; menu.style.display = 'none'; };

      const refresh = async () => {
        try { threads = await getThreads(); } catch (e) { threads = []; }
        try { recents = await loadRecents(); } catch (e) { recents = []; }
        // Always visible — the pill hosts the "+ New thread" button even with 0–1 threads.
        pill.style.display = 'flex';
        // Keep the sidebar's persisted group id fresh whenever this sidebar's tab still
        // resolves to a thread (gid is stable; only refresh on a positive match so a
        // transient stale curTabId never wipes a still-valid group).
        try { const t = currentThread(); if (t && t.groupId != null) store.set({ __ffSidebarGroup: t.groupId }); } catch (e) {}
        renderLabel();
        if (listOpen) renderMenu();
      };

      pill.onclick = () => { refresh().then(() => { if (listOpen) closeMenu(); else openMenu(); }); };
      document.addEventListener('click', (e) => {
        if (listOpen && !menu.contains(e.target) && !pill.contains(e.target)) closeMenu();
      });

      // Live updates when Claude creates/changes groups or saves a chat.
      try { api.storage.onChanged.addListener((ch) => { if (ch && (ch[K_META] || ch[K_MEMB] || ch.__czChats)) refresh(); }); } catch (e) {}
      // In-page "jump to thread" → repoint this sidebar.
      try {
        api.runtime.onMessage.addListener((msg) => {
          if (msg && msg.type === 'FF_SWITCH_THREAD' && msg.tabId != null && msg.tabId !== curTabId()) repoint(msg.tabId);
          if (msg && msg.type === 'FF_ACTIVE_TAB') setForeign(!!msg.foreign);
        });
      } catch (e) {}

      refresh();
      console.log(LOG, 'switcher ready; tabId=' + curTabId());
    });
  }
})();
