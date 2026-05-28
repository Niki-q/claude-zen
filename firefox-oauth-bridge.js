// Injected into claude.ai pages in the MAIN world at document_start.
// Claude.ai's OAuth page calls chrome.runtime.sendMessage("fcoeoabgfenejglbffodgkkbkcdhcgfn", ...)
// to communicate with the Chrome extension. In Firefox, chrome.runtime does not exist on
// web pages. We provide it here so the OAuth flow works.
// Messages are relayed via window.postMessage → firefox-oauth-relay.js → background.
(function () {
  const CHROME_EXT_ID = 'fcoeoabgfenejglbffodgkkbkcdhcgfn';

  if (typeof window.chrome === 'undefined') window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = {};

  const _orig = window.chrome.runtime.sendMessage;

  window.chrome.runtime.sendMessage = function (extId, msg, optsOrCb, cb) {
    // Normalize: (msg), (msg, cb), (extId, msg), (extId, msg, cb), (extId, msg, opts, cb)
    let targetId, message, callback;
    if (typeof extId === 'string') {
      targetId = extId;
      message  = msg;
      callback = typeof optsOrCb === 'function' ? optsOrCb : (typeof cb === 'function' ? cb : null);
    } else {
      targetId = null;
      message  = extId;
      callback = typeof msg === 'function' ? msg : null;
    }

    if (targetId === null || targetId === CHROME_EXT_ID) {
      const msgId = Math.random().toString(36).slice(2);
      return new Promise((resolve) => {
        const onReply = (e) => {
          if (e.source !== window || e.data?._czOAuth !== 'res' || e.data.msgId !== msgId) return;
          window.removeEventListener('message', onReply);
          delete window.chrome.runtime.lastError;
          const response = e.data.response;
          if (callback) {
            try { callback(response); } catch {}
          }
          resolve(response);
        };
        window.addEventListener('message', onReply);
        window.postMessage({ _czOAuth: 'req', msgId, message }, '*');
      });
    }

    if (_orig) return _orig.apply(this, arguments);
  };

  // Some pages check chrome.runtime.id to detect extension presence
  if (!window.chrome.runtime.id) {
    window.chrome.runtime.id = CHROME_EXT_ID;
  }

  // Stub connect so pages that call it don't throw
  if (!window.chrome.runtime.connect) {
    window.chrome.runtime.connect = () => ({
      onMessage:     { addListener: () => {}, removeListener: () => {} },
      onDisconnect:  { addListener: () => {}, removeListener: () => {} },
      postMessage:   () => {},
      disconnect:    () => {},
    });
  }
})();
