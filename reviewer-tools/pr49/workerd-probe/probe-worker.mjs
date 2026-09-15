export default {
  async test() {
    const out = {};
    const url = "https://school.example/d2l/le/calendar/feed/user/feed.ics";
    const probe = async (name, fn) => { try { out[name] = "OK " + (await fn()); } catch (e) { out[name] = "THROW " + (e && e.name) + ": " + (e && e.message); } };
    await probe("new Request redirect=error", async () => new Request(url, { redirect: "error" }).redirect);
    await probe("new Request cache=no-store", async () => new Request(url, { cache: "no-store" }).cache);
    await probe("fetch PR49 init (redirect=error, cache=no-store)", async () => { const r = await fetch(url, { method: "GET", headers: { accept: "text/calendar" }, redirect: "error", cache: "no-store" }); return r.status + " " + (await r.text()); });
    await probe("fetch redirect=manual cache=no-store", async () => { const r = await fetch(url, { method: "GET", redirect: "manual", cache: "no-store" }); return r.status + " " + (await r.text()); });
    await probe("fetch redirect=manual to 302 stub", async () => { const r = await fetch(url + "?redirect=1", { method: "GET", redirect: "manual" }); return r.status + " redirected=" + r.redirected + " location=" + r.headers.get("location"); });
    console.log("PROBE_RESULT " + JSON.stringify(out, null, 2));
  }
};
