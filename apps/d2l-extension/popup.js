export function format(status = {}) {
  const lines = [status.running ? "Reading…" : "Idle", `Pairing: ${status.pairing?.status ?? "unpaired"}`];
  if (status.pairing?.status === "pending") lines.push(`Pairing code: ${status.pairing.code}`, `Expires: ${status.pairing.expiresAt}`, "Approve this code in Jarvis Telegram, then check pairing.");
  if (status.error) lines.push(status.error);
  for (const host of status.hosts ?? []) {
    lines.push("", host.host, `Last good read: ${host.lastGoodRead ?? "none yet"}`, `Context: ${host.context ?? "unknown"}`);
    if (host.error) lines.push(host.error);
    for (const course of host.courses) lines.push(`${course.name}: ${course.read} tools read, ${course.refused} refused${course.error ? `; ${course.error}` : ""}`);
  }
  if (status.delivery) lines.push("", `Batches waiting: ${status.delivery.queued}`, status.delivery.error ?? "Push queue delivered.");
  if (status.backgroundTest) {
    lines.push("", `Background test: ${status.backgroundTest.at}`);
    for (const host of status.backgroundTest.hosts) lines.push(`${host.host}: HTTP ${host.status}; ${host.error ?? "JSON read succeeded"}`);
  }
  lines.push("", "If Durham renewal failed: sign in on LDSB, then click the course under My Courses in Other Boards once.");
  return lines.join("\n");
}
export function wire(api, page) {
  const notice = page.getElementById("notice");
  const show = async () => { page.getElementById("status").textContent = format((await api.storage.local.get("status")).status); };
  const send = async (message) => {
    try {
      const result = await api.runtime.sendMessage(message);
      notice.textContent = result?.ok === false ? "Setup or pairing was refused. Check the saved link and receiver availability." : "Request accepted.";
      await show();
    } catch { notice.textContent = "Collector unavailable. Reload the extension and try again."; }
  };
  page.getElementById("sync").onclick = () => send({ type: "SYNC" });
  page.getElementById("test").onclick = () => send({ type: "BACKGROUND_TEST" });
  page.getElementById("pairing").onclick = () => send({ type: "PAIRING_STATUS" });
  page.getElementById("setup").onsubmit = (event) => {
    event.preventDefault();
    const hop = page.getElementById("hop");
    void send({ type: "SETUP", deviceLabel: page.getElementById("label").value, hop: hop.value });
    hop.value = "";
  };
  api.storage.onChanged.addListener(() => { void show(); });
  void show();
}
if (typeof document !== "undefined") wire(chrome, document);
