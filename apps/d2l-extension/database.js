export function database(indexed = indexedDB) {
  const opened = new Promise((resolve, reject) => {
    const request = indexed.open("jarvis-d2l-collector", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("collector-storage-unavailable"));
  });
  async function operation(mode, action) {
    const db = await opened;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("state", mode);
      const request = action(transaction.objectStore("state"));
      // A successful request can still be rolled back by a quota or disk error.
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = transaction.onerror = () => reject(new Error("collector-storage-unavailable"));
    });
  }
  return {
    get: (key) => operation("readonly", (store) => store.get(key)),
    set: (key, value) => operation("readwrite", (store) => store.put(value, key)),
  };
}
