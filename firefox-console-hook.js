// MAIN-world console/error hook (Firefox). Captures the page's console output and
// uncaught errors so the agent can read them — the Firefox stand-in for CDP's
// Runtime.consoleAPICalled / Runtime.exceptionThrown events.
//
// Runs in the page's MAIN world (manifest content_scripts world:"MAIN") so it sees
// the real console. It has no access to chrome.* APIs, so it relays entries to the
// ISOLATED-world relay (firefox-console-relay.js) via window.postMessage, which
// forwards them to the background. Capture is OFF by default and only turns on when
// the relay forwards a toggle (sent when the bundle calls CDP Runtime.enable for the
// tab) — zero overhead on pages where the agent isn't watching the console.
(function () {
  if (window.__claudeZenConsoleHook) return;
  window.__claudeZenConsoleHook = true;

  let active = false;
  const MAX_ARGS = 20;

  const str = (a) => {
    try {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object' && a !== null) return JSON.stringify(a);
      return String(a);
    } catch {
      try { return String(a); } catch { return '[unserializable]'; }
    }
  };

  const post = (payload) => {
    try { window.postMessage({ __claudeZenConsole: 'entry', payload }, '*'); } catch {}
  };

  for (const lvl of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = typeof console[lvl] === 'function' ? console[lvl].bind(console) : null;
    console[lvl] = function (...args) {
      if (active) {
        try { post({ kind: 'console', level: lvl, args: args.slice(0, MAX_ARGS).map(str), ts: Date.now() }); } catch {}
      }
      if (orig) return orig(...args);
    };
  }

  window.addEventListener('error', (e) => {
    if (!active) return;
    post({
      kind: 'exception',
      message: (e.error && (e.error.stack || e.error.message)) || e.message,
      url: e.filename, line: e.lineno, col: e.colno, ts: Date.now(),
    });
  }, true);

  window.addEventListener('unhandledrejection', (e) => {
    if (!active) return;
    const r = e.reason;
    post({ kind: 'exception', message: (r && (r.stack || r.message)) || str(r), ts: Date.now() });
  });

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (d && d.__claudeZenConsole === 'toggle') active = !!d.on;
  });
})();
