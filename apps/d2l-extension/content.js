chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  if (message?.type !== "D2L_READ" || message.host !== location.origin) return false;
  void (async () => {
    try { reply(await D2L.read(message.host, message.route, message.args)); }
    catch { reply(D2L.failed(0, "invalid-route")); }
  })();
  return true;
});
