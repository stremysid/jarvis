importScripts("probe.js", "controller.js");
const controller = D2LController.createController(chrome, globalThis.fetch.bind(globalThis));
chrome.runtime.onMessage.addListener(controller.onMessage);
