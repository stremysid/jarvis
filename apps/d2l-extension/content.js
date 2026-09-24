chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab !== undefined) return false;
  if (message?.type !== "D2L_READ") return false;
  void (async () => {
    try { reply(await D2LProbe.read(message.route, message.args)); }
    catch { reply({ status: null, error: "invalid-route" }); }
  })();
  return true;
});
