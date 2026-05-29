// firefox-thread-jump.js — in-page "Open in Claude" / jump-to-thread button.
// ─────────────────────────────────────────────────────────────────────────────
// Injected (dynamically, on <all_urls>, top frame, document_idle — see the
// scripting.registerContentScripts call in firefox-threads.js) into every page.
// If the current tab is a member of a Claude group, it shows a small floating
// button that repoints the (open) global sidebar to THIS page's thread, so you can
// jump from a Claude-driven page back to the conversation driving it.
//
// Membership lives in storage.session, which content scripts can't read, so we ask
// the background (firefox-threads.js) via FF_THREAD_MEMBERSHIP / FF_JUMP_TO_THREAD.
// Firefox can't open a closed sidebar without a user gesture (lost across the
// message hop), so when the sidebar is closed we just hint the user to open it.
(function () {
  'use strict';
  if (window.top !== window) return; // top frame only
  const api = (typeof browser !== 'undefined' ? browser : chrome);
  if (!api || !api.runtime) return;
  const BTN_ID = '__cz_jump_btn';
  let btn = null;
  let timer = null;

  const send = (msg) => new Promise((res) => {
    try { const r = api.runtime.sendMessage(msg, (resp) => res(resp)); if (r && typeof r.then === 'function') r.then(res, () => res(null)); }
    catch (e) { res(null); }
  });

  const toast = (text) => {
    if (!document.body) return;
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;bottom:64px;right:16px;z-index:2147483647;background:#1a1a1a;color:#fff;padding:8px 12px;border-radius:8px;font:12px system-ui,sans-serif;box-shadow:0 3px 12px rgba(0,0,0,.4);opacity:0;transition:opacity .2s;max-width:280px';
    document.body.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2800);
  };

  const removeBtn = () => { if (btn) { btn.remove(); btn = null; } };

  const showBtn = () => {
    if (btn || !document.body) return;
    btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = '◆ Open in Claude';
    btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#d97757;color:#fff;border:none;border-radius:999px;padding:8px 14px;font:12px/1 system-ui,sans-serif;font-weight:600;cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.3);opacity:.92';
    btn.onmouseenter = () => { btn.style.opacity = '1'; };
    btn.onmouseleave = () => { btn.style.opacity = '.92'; };
    btn.onclick = async () => {
      const resp = await send({ type: 'FF_JUMP_TO_THREAD' });
      if (resp && resp.ok && resp.delivered) return; // sidebar switched
      if (resp && resp.ok && !resp.delivered) toast('Open the Claude sidebar (Ctrl+E) to view this thread');
      else toast('This tab isn’t part of a Claude thread');
    };
    document.body.appendChild(btn);
  };

  const check = async () => {
    const resp = await send({ type: 'FF_THREAD_MEMBERSHIP' });
    if (resp && resp.inGroup) showBtn(); else removeBtn();
  };

  check();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('pageshow', check);
  // Membership can change after load (Claude groups the tab a moment later);
  // re-check periodically while the tab is visible.
  timer = setInterval(() => { if (!document.hidden) check(); }, 5000);
  window.addEventListener('pagehide', () => { if (timer) clearInterval(timer); });
})();
