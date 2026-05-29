// ISOLATED-world relay between the MAIN-world console hook and the background.
// MAIN world can't use chrome.* and the background can't read the page console, so
// this bridges them:
//   background → {type:'__FF_CONSOLE_TRACK', on} → postMessage toggle → MAIN hook
//   MAIN hook  → postMessage entry              → runtime → background (__FF_CDP_CONSOLE)
// The background turns capture on/off per tab when the bundle enables/disables CDP
// Runtime events, and converts forwarded entries into synthetic onEvent calls.
(function () {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === '__FF_CONSOLE_TRACK') {
      try { window.postMessage({ __claudeZenConsole: 'toggle', on: !!msg.on }, '*'); } catch {}
    }
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.__claudeZenConsole === 'entry') {
      try {
        const p = chrome.runtime.sendMessage({ type: '__FF_CDP_CONSOLE', payload: d.payload });
        if (p && p.catch) p.catch(() => {});
      } catch {}
    }
  });
})();
