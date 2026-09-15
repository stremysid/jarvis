// Minimal vitest-compatible shim so the real PR test files can run under plain node.
const suites = [];
let current = null;
const afterEachHooks = [];

export function describe(name, fn) {
  const previous = current;
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = previous;
}

export function it(name, fn) {
  if (current === null) {
    current = { name: "(root)", tests: [] };
    suites.push(current);
  }
  current.tests.push({ name, fn });
}
export const test = it;

export function afterEach(fn) {
  afterEachHooks.push(fn);
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Reflect.ownKeys(a);
  const kb = Reflect.ownKeys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!kb.includes(k)) return false;
    if (!deepEqual(a[k], b[k])) return false;
  }
  return true;
}

function show(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function matchesThrown(error, pattern) {
  if (pattern === undefined) return true;
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  if (pattern instanceof RegExp) return pattern.test(message);
  return message.includes(String(pattern));
}

function fail(message) {
  throw new Error(`ASSERTION: ${message}`);
}

function core(value, negated) {
  const ok = (condition, message) => {
    if (negated ? condition : !condition) fail(message);
  };
  return {
    toBe(expected) { ok(Object.is(value, expected), `expected ${show(value)} ${negated ? "not " : ""}to be ${show(expected)}`); },
    toEqual(expected) { ok(deepEqual(value, expected), `expected ${show(value)} ${negated ? "not " : ""}to equal ${show(expected)}`); },
    toStrictEqual(expected) { ok(deepEqual(value, expected), `expected ${show(value)} ${negated ? "not " : ""}to strictly equal ${show(expected)}`); },
    toContain(expected) {
      const contained = typeof value === "string"
        ? value.includes(expected)
        : Array.isArray(value) && value.some((entry) => deepEqual(entry, expected));
      ok(contained, `expected ${show(value)} ${negated ? "not " : ""}to contain ${show(expected)}`);
    },
    toBeUndefined() { ok(value === undefined, `expected ${show(value)} ${negated ? "not " : ""}to be undefined`); },
    toBeNull() { ok(value === null, `expected ${show(value)} ${negated ? "not " : ""}to be null`); },
    toThrow(pattern) {
      if (typeof value !== "function") fail("toThrow needs a function");
      let threw = false;
      let error;
      try { value(); } catch (caught) { threw = true; error = caught; }
      if (negated) {
        if (threw) fail(`expected no throw but got ${show(error && error.message)}`);
        return;
      }
      if (!threw) fail("expected a throw but none happened");
      if (!matchesThrown(error, pattern)) fail(`thrown ${show(error && error.message)} does not match ${String(pattern)}`);
    },
  };
}

function asyncCore(promise, kind, negated) {
  const settle = async () => {
    let value;
    let error;
    let rejected = false;
    try { value = await promise; } catch (caught) { rejected = true; error = caught; }
    return { value, error, rejected };
  };
  return {
    async toThrow(pattern) {
      const { error, rejected } = await settle();
      if (kind !== "rejects") fail("resolves.toThrow is not supported");
      if (negated) { if (rejected) fail("expected no rejection"); return; }
      if (!rejected) fail("expected a rejection but the promise resolved");
      if (!matchesThrown(error, pattern)) fail(`rejection ${show(error && error.message)} does not match ${String(pattern)}`);
    },
    async toBe(expected) {
      const { value, rejected, error } = await settle();
      if (kind === "resolves") {
        if (rejected) fail(`expected resolve but rejected with ${show(error && error.message)}`);
        core(value, negated).toBe(expected);
      } else {
        if (!rejected) fail("expected a rejection but the promise resolved");
        core(error, negated).toBe(expected);
      }
    },
    async toEqual(expected) {
      const { value, rejected, error } = await settle();
      if (kind === "resolves") {
        if (rejected) fail(`expected resolve but rejected with ${show(error && error.message)}`);
        core(value, negated).toEqual(expected);
      } else {
        if (!rejected) fail("expected a rejection but the promise resolved");
        core(error, negated).toEqual(expected);
      }
    },
    async toBeUndefined() {
      const { value, rejected, error } = await settle();
      if (rejected) fail(`expected resolve but rejected with ${show(error && error.message)}`);
      core(value, negated).toBeUndefined();
    },
  };
}

export function expect(value) {
  const build = (negated) => ({
    ...core(value, negated),
    get rejects() { return asyncCore(value, "rejects", negated); },
    get resolves() { return asyncCore(value, "resolves", negated); },
  });
  const base = build(false);
  Object.defineProperty(base, "not", { get: () => build(true) });
  return base;
}

export async function runAll() {
  let passed = 0;
  const failures = [];
  for (const suite of suites) {
    for (const entry of suite.tests) {
      try {
        await entry.fn();
        passed += 1;
      } catch (error) {
        failures.push({ suite: suite.name, test: entry.name, message: error && error.message ? error.message : String(error) });
      }
      for (const hook of afterEachHooks) {
        try { await hook(); } catch { /* ignore cleanup failure */ }
      }
    }
  }
  return { passed, failures, total: passed + failures.length };
}
