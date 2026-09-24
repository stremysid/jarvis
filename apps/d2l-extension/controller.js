(() => {
  function createController(api, fetchImpl) {
    const probe = globalThis.D2LProbe;
    let active = false;
    const tabs = () => api.tabs.query({ url: probe.MATCH });

    async function run() {
      if (active) return;
      active = true;
      let context;
      let report;
      try {
        const openTabs = await tabs();
        context = openTabs.length === 0 ? "background" : "content";
        const target = openTabs.find((tab) => tab.active) ?? openTabs[0];
        report = { state: "incomplete", rows: [] };
        const save = async () => { await api.storage.session.set({ [context]: report }); };
        await save();
        const readRoute = async (route, args) => {
          if (context === "content") {
            return await api.tabs.sendMessage(target.id, { type: "D2L_READ", route, args }, { frameId: 0 });
          }
          if ((await tabs()).length !== 0) throw new Error("context-changed");
          const result = await probe.read(route, args, fetchImpl);
          if ((await tabs()).length !== 0) throw new Error("context-changed");
          return result;
        };
        report.state = await probe.collect(readRoute, async (row) => {
          report.rows.push(row);
          await save();
        });
        await save();
      } catch {
        if (!report) throw new Error("probe-unavailable");
        report.state = "interrupted: retry with D2L tabs closed, or refresh the open D2L tab";
        await api.storage.session.set({ [context]: report });
      } finally {
        active = false;
      }
    }

    function onMessage(message, sender, reply) {
      if (sender.id !== api.runtime.id || sender.url !== api.runtime.getURL("popup.html")) return false;
      if (message?.type !== "RUN_PROBE") return false;
      void (async () => {
        try { await run(); reply({ done: true }); }
        catch { reply({ done: false }); }
      })();
      return true;
    }
    return { run, onMessage };
  }
  globalThis.D2LController = { createController };
})();
