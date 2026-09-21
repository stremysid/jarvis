# Fixing the auditor's read-only guarantee — root cause and remedy

**Supersedes `auditor-readonly-diagnosis.md`.** The cause is now proven from the plugin's source,
not inferred from behaviour. Corrected 2026-09-20 after the first version of this report named the
wrong mechanism.

## Root cause — proven

**There are two controls, and neither is the one the launcher sets.**

### Control 1: a persisted user setting

**Control 1 — the persisted user setting.** `~/.dsh/settings.yaml`:

```yaml
permission:
  defaultPreset: danger-full-access
```

`dsh-permission-presets/lib/index.js` derives the mode from exactly that value:

```js
if (ctx.shell.sandboxMode === void 0) throw new Error("permission: the mounted bash executor does not confine ...")
const inferredDefault = this.derive(EMPTY_KNOBS);
const defaultPreset = config.defaultPreset ?? inferredDefault;
this.resolve(defaultPreset);
```

This is the `Full access` your UI showed, and the picker's own label confirms it —
`dsh-client-ui-permission-presets/lib/client.js:31`: *"Choose the default permission mode for new
sessions"*, read and written through the `permission` namespace of the settings store.

**Control 2 — the storage schema's default,** which is what applies when control 1 is disabled:

`dsh-sandbox-policy/lib/index.js`:

```js
L97   static Config = z.object({
L98     mode: z.union(["read-only","workspace-write","danger-full-access"]).default("read-only"),
L103    workspaceRoot: z.string()
      });
L112  this.defaultMode = config.mode;
...
L141  resolve(request = {}) {
L144    mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,
      }
```

Resolution is `request.mode ?? sessionOverride ?? defaultMode`, where `defaultMode` is the
**validated** config value.

And the only consumer of the variable, `dsh-base/cordis.patch.yml:211`:

```yaml
mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
```

**The `?? 'workspace-write'` is dead code.** An unset variable makes that expression `undefined`,
and the schema's `.default("read-only")` replaces it *before* `defaultMode` is assigned. The
literal fallback can only fire if the schema had no default — and it does.

**So `$env:DSH_PERMISSION_MODE` is not the control.** The launcher sets a variable whose only
consumer is an expression whose fallback is then overridden by a schema default, while the value
that actually applies comes from a persisted user setting the launcher never mentions.

### The observation is now explained — and it is worse than a gap

I wrote earlier that I could not explain why the auditor's runs saw `workspace-write` while this
harness sees `read-only`. **That is resolved, and the resolution is the finding.**

**There are two paths, and they disagree:**

- **Headless / `dsh-audit.ps1`:** the `jarvis-auditor` preset disables `dsh-permission-presets`, so
  `permission.defaultPreset` is never consulted and the sandbox-policy schema's
  `.default("read-only")` applies. **Read-only**, which is what this harness measures on every run.
- **UI / web:** the picker reads and writes the `permission` namespace in `~/.dsh/settings.yaml`,
  which holds **`danger-full-access`**. A session launched from the UI resolves to full access,
  **not** read-only.

So the guarantee holds on the path I kept testing and **fails on the path you actually used**. That
is the opposite of reassuring, and it is why the file appeared in `C:\javis`.

### Confirmed: a patch REPLACES a row's config, it does not merge

This is the mechanism that made read-only hold by accident, and it is load-bearing for the fix.
`dsh-app-boot/lib/index.js`, `applyEntryPatches`:

```js
for (const [key, value] of Object.entries(overrides)) {
  if (key === "id") continue;
  target[key] = value;      // assignment — whole-value replacement
}
```

There is **no deep-merge helper anywhere** in the loader (verified by search). So when the preset
previously supplied `config: { mode: read-only }`, it replaced the base's entire config — destroying
the `!!js` expression *and* dropping `workspaceRoot`, which is what made the load fail with
`service "sandboxPolicy" has been registered`. And today, with no `mode` supplied, the value
reaching the schema is `undefined`, so `.default("read-only")` fires.

**Read-only is an accident, not a construction.** It holds because a Zod default catches it —
something nobody chose, one config edit away from silently flipping.

### Measured

| Environment | Config patch | Session's reported policy | Could write inside `C:\javis` |
|---|---|---|---|
| `read-only` | none | (not captured) | **no**, denied |
| `workspace-write` | `mode: read-only` | (not captured) | **no**, denied |
| **`workspace-write`** | **none** | **`read-only`** | **no**, denied |
| `read-only` | `mode: read-only` | (not captured) | **no**, denied |
| `read-only` | `mode: workspace-write` | (not captured) | **no**, denied |

Every run in this harness refused a write **inside the workspace**, and the one run that reported
its policy said `read-only` while the environment said `workspace-write`. The variable is ignored.
The probe targets a path inside `C:\javis`, the only place `read-only` and `workspace-write`
differ — an earlier version targeted `%TEMP%`, where both refuse, and its mutation survived twice.

### Not yet explained

The auditor's runs (`d7bbb7ea`, `e6762f05`) reported **`workspace-write`** and one created a file in
`C:\javis`. This harness does not reproduce that, and `permission.defaultPreset:
danger-full-access` is a plausible cause that has **not been tested**. Something differs between
the two invocation paths. **Do not treat this report as closing that.**

## What this rules out

- **Not the variable.** `workspace-write` in the environment produced a `read-only` policy.
- **Not the preset's content.** It no longer mounts `sandbox-policy`; the composed tree carries
  exactly one, owned by the base. Verified: 0 occurrences of `- id: sandbox-policy` in the preset.
- **Not the headless profile.** `~/.dsh/profiles/headless/cordis.patch.yml` is `[]`, and its
  bundles are `dsh-base` + `dsh-headless`.
- **Not `dsh-headless`.** No `sandbox` or `DSH_PERMISSION_MODE` reference anywhere in it.
- **Not shell propagation.** Verified: `read-only` reaches both a `pwsh` child and an `npx`
  grandchild.
- **Not `--dump-config`.** It prints `!!js` expressions **unevaluated**, so it can never confirm a
  resolved mode. I used it twice as evidence and it was worth nothing.

## The fix

**Do not rely on the environment. Patch the config literally, by row id, in the overlay the
launcher already writes.**

```yaml
- id: sandbox-policy
  config:
    mode: read-only
    workspaceRoot: !!js process.cwd()
```

Why this shape:

- **A patch REPLACES the row's whole `config`** (proven above — `target[key] = value`, no merge).
  Supplying **both** keys is therefore mandatory, not tidy: an earlier preset supplied only `mode`
  and silently destroyed `workspaceRoot`, which is what broke the load.
- It removes the environment from the path entirely, so no harness curation, subprocess
  construction, or upstream change can move it.
- `mode: read-only` is a validated enum member, so it cannot be silently swapped for a default,
  and it no longer depends on a Zod default nobody chose.

**Also, and this half is not optional:** the UI path resolves `permission.defaultPreset` from
`~/.dsh/settings.yaml`, which currently reads `danger-full-access`. Pinning the row fixes the
composition, but **a session launched from the UI still starts full-access unless that setting is
changed or the preset disables the plugin.** The preset does disable `dsh-permission-presets`, and
this harness confirms read-only — but the UI path was not re-tested after the preset stopped
mounting a sandbox row, and the setting remains a live hazard. Either set
`permission.defaultPreset: read-only` or treat the UI path as advisory.

**Also:** stop `dsh-audit.ps1` printing `"(effort …, read-only)"`. It asserts a mode the script
does not achieve, and that false assertion is why this survived unnoticed.

## Verifying the fix — and why no guard can be mutation-tested here

The earlier guard passed under its own mutation twice. Its two defects, both now understood:

1. The target was **outside** the workspace, where `workspace-write` also refuses, so the two modes
   were indistinguishable.
2. An unsubstituted `$target` meant the session created a file the check was not looking for.

`run-readonly-test.ps1` fixes both: it writes **inside** the workspace, substitutes the path,
checks for the file *and* the literal `$target`, and requires a denial marker so an unrelated
failure cannot pass as success.

**But the mutation cannot be made to fire from headless, and that is a finding, not a TODO.** I
tried three ways to make a session writable:

| Attempt | Result |
|---|---|
| `mode: workspace-write` via the config patch | accepted, session still read-only |
| `DSH_PERMISSION_MODE=workspace-write` in the environment | ignored; policy reported `read-only` |
| `mode: bogus-mode-value` via the config patch | **config validation error, boot refused** |

The third row is the informative one: it proves the patch **does** land and **is** validated, so the
first two rows were not "the patch did not apply" — `request.mode` or a session override wins over
`defaultMode`, and neither is reachable from the command line. **So there is no way to make a
headless auditor writable, and therefore no way to mutation-test a guard for this property from
headless.** That is stronger than "the fix works": it means a correct guard cannot be shown to fail,
and shipping one that has never failed would be exactly the mistake this repository records in
three other places.

**Consequence: no guard is shipped in this PR.** `run-readonly-test.ps1` is included as a
**diagnostic only**, with that stated at the top of the file, and it must not be treated as a
regression test. Pinning this property requires a way to raise the mode — the UI path, or a
settings-based session override — which is untested.

### Evidence index

The run directories under `%TEMP%\jarvis-ro-test\` and `%TEMP%\jarvis-sandbox-probe\` are
temporary and **will be cleaned up by Windows**. Their contents are transcribed above; the
load-bearing ones are the per-run `relay\*-attempt1.log` files, and the quoted lines are the
session's own words about its mode.

## Consequence

`AGENTS.md` requires reviewer-authored PRs to get *"an independent read-only auditor pass"*. On
this evidence that guarantee is **prose**: the launcher's control does nothing, and one auditor run
wrote a file inside the live deploy checkout (content: the single line `probe`; found and deleted).
Nothing was committed, merged, deployed, or migrated, and no secret was touched.

Still open, and not addressed by this fix:

- **Why the auditor's runs saw `workspace-write` while this harness sees `read-only`.** This is now
  the most important open question, because it decides whether the auditor is actually writable in
  the path that matters.
- **The UI path.** Your session showed a `Full access` picker. The preset disables
  `dsh-permission-presets` to remove the override path; if the picker still works, that half does
  nothing.
- **Whether a session can raise its own mode**, or only be launched at one.

