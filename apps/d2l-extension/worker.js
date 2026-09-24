import { controller } from "./controller.js";
import { database } from "./database.js";

const app = controller({ api: chrome, store: database() });
async function start() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.alarms.create("d2l-hourly", { periodInMinutes: 60 });
  await app.run();
}
chrome.runtime.onInstalled.addListener(() => { void start(); });
chrome.runtime.onStartup.addListener(() => { void start(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "d2l-hourly") void app.run();
});
chrome.runtime.onMessage.addListener(app.onMessage);
