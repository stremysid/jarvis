const rows = [];
const add = (name, file, find, replace, testFile, testName) => rows.push({ name, file, find, replace, testFile, testName });
const read = "It hard-codes credentialed GET and refuses login HTML, redirects, and invalid JSON.";
const pin = "It pins both literal D2L origins and every generated route to their allowlist.";
const collector = (name, file, find, replace, testName) => add(name, file, find, replace, "collector.test.js", testName);
const protocol = (name, file, find, replace, testName) => add(name, file, find, replace, "protocol.test.js", testName);
const wiring = (name, file, find, replace, testName) => add(name, file, find, replace, "wiring.test.js", testName);

collector("Literal LDSB host", "probe.js", '"https://ldsb.elearningontario.ca"', '"https://other.invalid"', pin);
collector("Literal Durham host", "probe.js", '"https://durham.elearningontario.ca"', '"https://other.invalid"', pin);
collector("D2L host allowlist", "probe.js", '!HOSTS.includes(host)', 'false', pin);
collector("D2L route allowlist", "probe.js", '!Object.hasOwn(LABELS, route)', 'false', pin);
collector("D2L identifiers", "probe.js", '!/^[0-9]{1,20}$/.test(String(value))', 'false', pin);
collector("Student submissions route", "probe.js", '/submissions/mysubmissions/', '/submissions/', pin);
collector("Required org-unit CSV", "probe.js", '?orgUnitIdsCSV=<course>', '?wrong=<course>', pin);
collector("Enrollment bookmark query", "probe.js", 'url.searchParams.set("bookmark", args.bookmark)', 'url.searchParams.set("wrong", args.bookmark)', pin);
for (const [name, find, replace] of [
  ["Hard-coded GET", 'method: "GET"', 'method: "POST"'],
  ["GET ignores caller method", 'method: "GET"', 'method: args.method ?? "GET"'],
  ["D2L session credentials", 'credentials: "include"', 'credentials: "omit"'],
  ["D2L manual redirects", 'redirect: "manual"', 'redirect: "follow"'],
  ["D2L no cache", 'cache: "no-store"', 'cache: "default"'],
  ["Opaque redirect", 'response.status === 0', 'false'],
  ["Followed redirect", 'response.redirected', 'false'],
  ["HTTP redirect", '(response.status >= 300 && response.status < 400)', 'false'],
  ["JSON MIME", '!/^application\\/(?:[\\w.+-]+\\+)?json\\b/i.test(response.headers.get("content-type") ?? "")', 'false'],
  ["JSON parse failure", 'catch { return failed(response.status, "session-expired"); }', 'catch { return { status: 200, complete: true, body: [] }; }'],
  ["Unauthorized session", 'response.status === 401', 'false'],
  ["JSON refusals stay complete", 'return { status: response.status, complete: true, body };', 'return { status: response.status, complete: response.status === 200, body };'],
  ["Network failure", 'catch { return failed(0, "network-or-timeout"); }', 'catch { return { status: 200, complete: true, body: [] }; }'],
]) collector(name, "probe.js", find, replace, read);
const offerings = "It reads active accessible course offerings without judging their names.";
for (const [name, find] of [["Accessible course", 'item?.Access?.CanAccess === true'], ["Active course", 'item.Access.IsActive === true'], ["Course offering type", 'item.OrgUnit?.Type?.Id === 3']]) collector(name, "collector.js", find, 'true', offerings);
collector("Orientation travels as evidence", "collector.js", 'item.OrgUnit?.Type?.Id === 3', 'item.OrgUnit?.Type?.Id === 3 && item.OrgUnit.Name !== "DCE D2L BrightSpace Orientation"', offerings);
collector("Pinned LP and LE versions", "collector.js", '[["lp", "1.43"], ["le", "1.82"]]', '[["lp", "1.43"]]', "It requires both observed API versions and pushes version loss as failed course evidence.");
collector("Missing version failure", "collector.js", '!supported(versions.body)', 'false', "It requires both observed API versions and pushes version loss as failed course evidence.");
collector("Version read failure", "collector.js", '!versions.complete', 'false', "It refuses malformed enrollment manifests and never invents a course after a first-run login failure.");
collector("Complete enrollment shape", "collector.js", '!Array.isArray(page.body?.Items) || typeof page.body.PagingInfo?.HasMoreItems !== "boolean"', 'false', "It refuses malformed enrollment manifests and never invents a course after a first-run login failure.");
collector("Enrollment course name", "collector.js", 'typeof item.OrgUnit.Name !== "string" || !item.OrgUnit.Name.trim() || item.OrgUnit.Name.length > 512', 'false', "It refuses malformed enrollment manifests and never invents a course after a first-run login failure.");
collector("Pagination completion", "collector.js", '!page.body.PagingInfo.HasMoreItems', 'true', "It follows enrollment bookmarks and reads every required tool for each unique course.");
collector("Pagination cycle and missing bookmark", "collector.js", 'typeof bookmark !== "string" || !bookmark || bookmarks.has(bookmark)', 'false', "It stops repeated or missing bookmarks without claiming complete enrollments.");
collector("Course manifest bound", "collector.js", 'manifest.length > 128', 'false', "It bounds the enrollment manifest and labels Durham batches with their own host.");
collector("Failure batch status", "collector.js", 'enrollmentComplete: !error', 'enrollmentComplete: true', "It requires both observed API versions and pushes version loss as failed course evidence.");
collector("Folder-list shape", "collector.js", 'route === "folders" && result.status === 200 && result.complete && !Array.isArray(result.body)', 'false', "It refuses malformed folder listings and retains valid folder evidence in the cache.");
collector("Invalid folder remains incomplete", "collector.js", 'catch { normalEvidence = false; routes.find((entry) => entry.route === pathFor(host, "folders", { course: course.id })).complete = false; continue; }', 'catch { continue; }', "It refuses malformed folder listings and retains valid folder evidence in the cache.");
collector("Last good read requires normal evidence", "collector.js", 'summaries.every((course) => course.normalEvidence && !course.error)', 'true', "It preserves null dates and submission refusals while continuing through optional tools.");
collector("Cached folders do not hide refusal", "collector.js", 'if (fresh) await store.set(key, folders.body);', 'await store.set(key, folders.body);', "It keeps cached folder IDs without relabeling a failed listing as fresh evidence.");
collector("Request throttle", "sessions.js", '1000 - (now() - lastRequest)', '0', "It spaces actual requests by one second and leaves the background test free of fallback tabs.");
collector("Background test never falls back", "sessions.js", ' || backgroundOnly', '', "It spaces actual requests by one second and leaves the background test free of fallback tabs.");
collector("Durham refusals trigger one renewal", "probe.js", ' || result.status === 403', '', "It renews Durham only after LDSB is live and retries once through the stored hop.");
collector("LDSB tool refusals never open tabs", "sessions.js", 'if (result.error !== "session-expired") return result;', '', "It reads a course with refused LDSB quizzes without opening a fallback tab.");
collector("Close only collector-created tabs", "sessions.js", 'if (owned) await api.tabs.remove(owned.id).catch(() => {});', 'await api.tabs.remove(owned?.id ?? 7).catch(() => {});', "It falls back to an isolated LDSB tab and closes only tabs it created.");
collector("Durham renewal only once", "sessions.js", 'if (renewed.has(host)) return result;', '', "It renews Durham only after LDSB is live and retries once through the stored hop.");
collector("LDSB first", "sessions.js", 'if (!await ldsbLive()) return failed(result.status, "ldsb-session-required");', '', "It reports failed federation and never attempts Durham login without a live LDSB session.");
collector("Missing hop failure", "sessions.js", 'if (!hop) return failed(result.status, "durham-hop-required");', '', "It reports failed federation and never attempts Durham login without a live LDSB session.");
collector("Failed renewal stays failed", "sessions.js", 'needsSession(retry) && needsSession(result)', 'false', "It reports failed federation and never attempts Durham login without a live LDSB session.");
collector("Hop origin and credentials", "sessions.js", '!HOSTS.includes(url.origin) || url.username || url.password', 'false', "It rejects hop URLs outside the two approved origins and URLs with credentials.");

const canon = "It canonicalizes JSON with the receiver ordering, Unicode rules, and structural bounds.";
for (const [name, find, replace] of [
  ["Unicode well-formedness", '!text.isWellFormed()', 'false'],
  ["Structural item limit", 'items > 4096', 'false'],
  ["Container depth", 'depth >= 32', 'false'],
  ["Finite JSON numbers", 'Number.isFinite(node)', 'true'],
  ["NFC key collision", 'new Set(keys.map(([key]) => key)).size !== keys.length', 'false'],
  ["Wire byte limit", 'encoder.encode(text).length >= 65536', 'false'],
]) protocol(name, "protocol.js", find, replace, canon);
const signature = "It generates a non-extractable Ed25519 private key and signs the receiver exact envelope.";
protocol("Non-extractable private key", "protocol.js", 'generateKey("Ed25519", false,', 'generateKey("Ed25519", true,', signature);
protocol("Signing audience", "protocol.js", '"jarvis-school-collector"', '"wrong-audience"', signature);
protocol("Signature method binding", "protocol.js", '["POST", path, envelope.deviceId', '["GET", path, envelope.deviceId', signature);
protocol("Signature route binding", "protocol.js", '["POST", path, envelope.deviceId', '["POST", "/wrong", envelope.deviceId', signature);
protocol("Signing route allowlist", "protocol.js", '!PATHS.slice(1).includes(path)', 'false', signature);
protocol("Fresh nonce", "protocol.js", 'cryptoImpl.getRandomValues(new Uint8Array(32))', 'new Uint8Array(32)', signature);
const network = "It sends only pinned gateway POSTs without ambient credentials or redirect following.";
for (const [name, find, replace] of [
  ["Gateway route allowlist", '!PATHS.includes(path)', 'false'],
  ["Gateway request bound", 'encoder.encode(body).length >= 65536', 'false'],
  ["Gateway POST", 'method: "POST"', 'method: "GET"'],
  ["Gateway omits credentials", 'credentials: "omit"', 'credentials: "include"'],
  ["Gateway manual redirect", 'redirect: "manual"', 'redirect: "follow"'],
  ["Gateway no cache", 'cache: "no-store"', 'cache: "default"'],
  ["Gateway redirect rejection", 'response.status === 0 || response.redirected || response.status >= 300 && response.status < 400', 'false'],
  ["Gateway HTTP rejection", '!response.ok', 'false'],
]) protocol(name, "protocol.js", find, replace, network);
protocol("Too many route evidences", "protocol.js", 'batch.routes.length > 256', 'false', "It replaces oversized course bodies with explicit failure evidence under sixty-four KiB.");
protocol("Oversize batch remains failed", "protocol.js", 'status: 0, complete: false, body: { collectorFailure: "batch-exceeds-wire-limits" }', 'status: 200, complete: true, body: []', "It replaces oversized course bodies with explicit failure evidence under sixty-four KiB.");
const pairing = "It refuses invalid pairing labels, malformed responses, and invented pairing states.";
protocol("Device label contract", "delivery.js", 'typeof deviceLabel !== "string" || !deviceLabel.trim() || deviceLabel.length > 64 || /\\p{C}/u.test(deviceLabel)', 'false', pairing);
protocol("Pairing response contract", "delivery.js", '!["collectorId", "principalId", "challenge", "code", "expiresAt"].every((key) => typeof identity[key] === "string" && identity[key])', 'false', pairing);
protocol("Pairing status contract", "delivery.js", '!["pending", "active"].includes(result.status)', 'false', pairing);
protocol("Existing key preservation", "delivery.js", 'existing && (existing.approved || existing.status === "active" || existing.expiresAt > clock())', 'false', "It persists the key before pairing and proves only the server-issued challenge.");
protocol("Persist before public pairing", "delivery.js", 'await store.set("keys", keys);', '', "It persists the key before pairing and proves only the server-issued challenge.");
protocol("Active key before push", "delivery.js", 'sendPending && identity?.status === "active"', 'sendPending && identity', "It requires active pairing and a valid receipt before removing queued evidence.");
protocol("Receipt before dequeue", "delivery.js", '!receipt.batchId || !["good", "failed"].includes(receipt.outcome)', 'false', "It requires active pairing and a valid receipt before removing queued evidence.");
protocol("Keep failed queue entries", "delivery.js", '} catch { continue; }', '} catch { /* fault: discard */ }', "It retains failed batches across restarts and retries identical bytes with fresh nonces.");

const scan = "It allows one D2L read call site and one gateway push call site across every runtime asset.";
wiring("Popup fetch gap", "popup.js", 'export function format', 'fetch("https://other.invalid");\nexport function format', scan);
wiring("Popup HTML network gap", "popup.html", '<body>', '<body><script>new EventSource("https://other.invalid");</script>', scan);
wiring("Remote code", "worker.js", 'const app = controller', 'importScripts("https://other.invalid/code.js");\nconst app = controller', scan);
wiring("Duplicate D2L call site", "probe.js", 'const url = routeUrl(host, route, args);', 'const url = routeUrl(host, route, args); fetchImpl(url);', scan);
wiring("Cookie access", "content.js", 'chrome.runtime.onMessage', 'document.cookie; chrome.runtime.onMessage', scan);
const control = "It rejects control messages from content scripts and from non-popup extension pages.";
for (const [name, find] of [["Worker sender identity", 'sender.id !== api.runtime.id || '], ["Worker tab sender", 'sender.tab !== undefined || '], ["Worker popup sender", ' || sender.url !== api.runtime.getURL("popup.html")']]) wiring(name, "controller.js", find, '', control);
const isolated = "It restricts content reads to worker messages for the current D2L origin.";
wiring("Content sender identity", "content.js", 'sender.id !== chrome.runtime.id || ', '', isolated);
wiring("Content tab sender", "content.js", ' || sender.tab !== undefined', '', isolated);
wiring("Content current origin", "content.js", ' || message.host !== location.origin', '', isolated);
wiring("Content read message type", "content.js", 'message?.type !== "D2L_READ"', 'false', isolated);
const alarms = "It wires hourly alarms and browser startup to the collector without widening permissions.";
wiring("Hourly cadence", "worker.js", 'periodInMinutes: 60', 'periodInMinutes: 1', alarms);
wiring("Named alarm", "worker.js", 'alarm.name === "d2l-hourly"', 'true', alarms);
wiring("Trusted status storage", "worker.js", '"TRUSTED_CONTEXTS"', '"TRUSTED_AND_UNTRUSTED_CONTEXTS"', alarms);
wiring("Sync serialization", "controller.js", 'if (busy) return;\n    busy = true;\n    let status', 'busy = true;\n    let status', "It serializes sync runs and persists only course names and fixed status fields for the popup.");
wiring("Popup body isolation", "collector.js", 'routeErrors.find(Boolean)', 'routes.find((entry) => entry.body?.collectorFailure)?.body.collectorFailure', "It serializes sync runs and persists only course names and fixed status fields for the popup.");
wiring("Transaction commit before success", "database.js", 'transaction.oncomplete = () => resolve(request.result);', 'resolve(request.result); transaction.oncomplete = () => {};', "It waits for IndexedDB transaction completion and rejects rollback instead of claiming durable storage.");
collector("Tool pages stay incomplete", "collector.js", 'result.status === 200 && result.complete && (result.body?.Next != null || result.body?.PagingInfo?.HasMoreItems === true)', 'false', "It marks an unfinished tool page incomplete instead of claiming the first page is everything.");
protocol("Proof response may be lost", "delivery.js", 'await prove().catch(() => {});', 'await prove();', "It retains an ambiguous proof for retry and stops pushing after a refused status check.");
protocol("Proof is idempotent locally", "delivery.js", '!identity || identity.proved', '!identity', "It retains an ambiguous proof for retry and stops pushing after a refused status check.");
protocol("Status refusal blocks push", "delivery.js", 'await store.set("pairing", { ...identity, status: "unavailable-or-refused" });', '', "It retains an ambiguous proof for retry and stops pushing after a refused status check.");
protocol("Preserve previously approved keys", "delivery.js", 'existing.approved || ', '', "It preserves an approved key through temporary receiver failures and later setup retries.");
collector("Fallback listener retry bound", "sessions.js", 'attempt < 15', 'attempt < 1', "It records failed tab creation and bounds retries when the content listener never arrives.");
collector("Tab failure becomes evidence", "sessions.js", 'return failed(0, "in-tab-unavailable");', 'throw new Error("fault: lost failure evidence");', "It records failed tab creation and bounds retries when the content listener never arrives.");
const manifest = "It grants only the two literal D2L hosts, the pinned gateway, alarms, and storage.";
wiring("Literal gateway pin", "protocol.js", 'export const GATEWAY = "https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev";', 'export const GATEWAY = "https://other.invalid";', manifest);
wiring("Gateway manifest host", "manifest.json", '"https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev/*"', '"https://*.workers.dev/*"', manifest);
wiring("Minimal collector permissions", "manifest.json", '"permissions": ["alarms", "storage"]', '"permissions": ["alarms", "storage", "cookies"]', manifest);
const refusals = "It records complete tool refusals normally while refusing enrollment and version failures.";
collector("Version HTTP status", "collector.js", 'versions.status !== 200 || ', '', refusals);
collector("Enrollment HTTP status", "collector.js", 'page.status !== 200 || ', '', refusals);
collector("Folder success before caching", "collector.js", 'const fresh = folders.status === 200 && folders.complete;', 'const fresh = folders.complete;', "It keeps cached folder IDs without relabeling a failed listing as fresh evidence.");
collector("Refusals are normal evidence", "collector.js", '[200, 403].includes(result.status)', '[200].includes(result.status)', refusals);
collector("Folder refusal is not a shape failure", "collector.js", 'route === "folders" && result.status === 200 && result.complete', 'route === "folders" && result.complete', refusals);
collector("Durham refusal remains evidence", "sessions.js", 'if (retry.status === 403 && !retry.error) return retry;', '', "It retains a complete Durham tool refusal after the single renewal attempt.");
const queue = (name, file, find, replace, testName) => add(name, file, find, replace, "queue.test.js", testName);
// With the client-side hold gone a Durham batch, and a batch carrying news/ or
// quizzes/, are ordinary uploads. Both mutations below restore that hold by
// skipping an entry instead of sending it, which must fail the named test.
const noHold = "It sends a Durham board batch and a news and quizzes batch instead of holding them.";
queue("Durham board is sent", "delivery.js", 'const entry of [...queue]', 'const entry of [...queue].filter((entry) => entry.host === "ldsb.elearningontario.ca")', noHold);
queue("News and quizzes are sent", "delivery.js", 'const entry of [...queue]', 'const entry of [...queue].filter((entry) => !JSON.parse(entry.body).routes.some((route) => /\\/(news|quizzes)\\/$/.test(route.route)))', noHold);
protocol("Actual receiver signature witness", "protocol.js", '["POST", path, envelope.deviceId', '["POST", "/wrong", envelope.deviceId', "It passes extension bytes and signatures through the pinned receiver verifier and batch parser.");
rows.at(-1).testFile = "receiver-contract.test.js";
const bounded = "It bounds a week of unavailable delivery to the newest two reads of each board and course.";
queue("Queue course retention", "delivery.js", 'count <= QUEUE_PER_COURSE', 'true', bounded);
queue("Queue identity includes host", "delivery.js", '[entry.host, entry.courseId]', '[entry.courseId]', bounded);
queue("Queue retains newest reads", "delivery.js", 'combined.toReversed()', 'combined', bounded);
queue("Queue enqueues without writes", "delivery.js", 'return entry;', 'await store.set("queue", pending); return entry;', bounded);
queue("Queue commit exists", "delivery.js", 'await store.set("queue", queue);', '', bounded);
const bytes = "It bounds serialized queue bytes and exposes every eviction in the popup.";
queue("Queue byte ceiling", "delivery.js", 'bytes > QUEUE_MAX_BYTES', 'false', bytes);
queue("Queue bytes include UTF8", "delivery.js", 'new TextEncoder().encode(JSON.stringify(queue)).length', 'JSON.stringify(queue).length', bytes);
queue("Queue eviction count", "delivery.js", 'combined.length - queue.length', '0', bytes);
queue("Popup reports evictions", "popup.js", 'if (status.delivery?.evicted)', 'if (false)', bytes);
const attempts = "It limits each flush to eight attempts and commits the queue once for success or refusal.";
queue("Queue attempt ceiling", "delivery.js", 'attempts >= FLUSH_ATTEMPTS', 'false', attempts);
queue("Queue attempts include refusals", "delivery.js", 'attempts += 1;', '', attempts);
queue("Queue persists only once", "delivery.js", 'queue.splice(queue.indexOf(entry), 1);', 'queue.splice(queue.indexOf(entry), 1); await store.set("queue", queue);', attempts);
const retain = "It retains pending evidence if the single queue commit fails and retries it without duplication.";
queue("Queue clears pending after commit", "delivery.js", 'await store.set("queue", queue);\n    pending = [];', 'pending = [];\n    await store.set("queue", queue);', retain);
queue("Queue clears committed pending", "delivery.js", 'pending = [];\n    return', 'return', retain);
queue("Previously held evidence is sent", "delivery.js", 'const entry of [...queue]', 'const entry of [...queue].filter((entry) => false)', noHold);
queue("Interrupted reads persist", "controller.js", 'if (!backgroundOnly) status.delivery = await push.flush(!status.error);', 'if (!backgroundOnly && !status.error) status.delivery = await push.flush(!status.error);', "It commits collected evidence once when a later host interrupts the run without uploading it.");
queue("Interrupted flush does not upload", "delivery.js", 'sendPending && identity?.status', 'identity?.status', "It commits collected evidence once when a later host interrupts the run without uploading it.");
queue("Stored hop revalidated at use", "sessions.js", 'validateHop(hop)', 'hop', "It revalidates a hop loaded directly from settings before creating any tab for it.");
export default rows;
