const run = document.getElementById("run");
const copy = document.getElementById("copy");
const status = document.getElementById("status");
const summary = document.getElementById("summary");

async function refresh() {
  try { summary.value = D2LProbe.format(await chrome.storage.session.get(["background", "content"])); }
  catch { status.textContent = "Could not read the report. Reopen the popup."; }
}
chrome.storage.onChanged.addListener(() => { void refresh(); });
run.addEventListener("click", async () => {
  run.disabled = true;
  status.textContent = "Running. You can close this popup and reopen it to check progress.";
  try {
    const result = await chrome.runtime.sendMessage({ type: "RUN_PROBE" });
    status.textContent = result?.done ? "Pass ended. Check the route statuses below." : "Pass interrupted. Run again.";
  } catch { status.textContent = "Pass interrupted. Run again."; }
  finally { run.disabled = false; await refresh(); }
});
copy.addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(summary.value); status.textContent = "Summary copied."; }
  catch {
    summary.focus();
    summary.select();
    status.textContent = "Clipboard unavailable. Press Ctrl+C to copy the selected summary.";
  }
});
void refresh();
