// Isolation-world relay: forwards postMessages from the MAIN world bridge
// to the extension background, then returns the response.
window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?._czOAuth !== 'req') return;
  const { msgId, message } = e.data;

  chrome.runtime.sendMessage({ _czOAuthType: 'relay', message }, (response) => {
    window.postMessage({ _czOAuth: 'res', msgId, response: response || null }, '*');
  });
});
