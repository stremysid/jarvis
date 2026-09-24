# D2L extension probe (Opera GX)

This is a read-only diagnostic, not the school collector. Sid approved this probe
and accepted the D2L terms risk on 2026-09-23. Only Sid loads it or runs it against
his account. No key, signing, push, periodic polling or Jarvis receiver is wired.

## Load and run

1. Obtain the reviewed `codex/d2l-probe-run` branch (or `main` after merge) in an
   ordinary checkout or downloaded ZIP. Keep the extracted files at a stable path
   outside `C:\javis`. No install or build command is needed.
2. In **Opera GX**, open `opera://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select **`apps/d2l-extension`**, the folder containing
   `manifest.json`. Pin its popup if useful.
3. Sign into LDSB yourself if necessary, then **close every tab on
   `ldsb.elearningontario.ca`** without signing out. Open the extension popup and
   click **Run probe**. This is the **background** pass. Wait for the pass to end;
   reopening the popup preserves progress. Do not open D2L during this pass.
4. Open a D2L tab in that same browser profile and refresh it once so the static
   content script is present. Click **Run probe** again. This is the **content**
   pass. Keep that tab open until the pass ends. With multiple matching tabs, the
   active matching tab is used, otherwise the first one returned by the browser.
5. Click **Copy summary**, then paste that summary to the reviewer. If clipboard
   access is unavailable, the popup selects the report for **Ctrl+C**.

There is **one click per context**. A no-tab background experiment and an open-tab
content experiment cannot happen simultaneously. The extension never opens,
closes, navigates or reads a web page. It samples matching-tab presence before
and after each background request and interrupts if a tab is detected. This is
not a continuous attestation that a tab never briefly opened between samples.

Reports survive popup closure and worker restart in `chrome.storage.session`;
closing the browser clears them. A new run replaces only that context's report.
An `incomplete` report after a worker termination is not a successful pass: run
again. `interrupted` also covers a closed/navigated tab or a content script that
needs a refresh. Raw error messages are never displayed.

## What is probed

Each context reads versions first, then LP **1.43** `myenrollments`, following
enrollment bookmarks. It probes each distinct enrollment whose `CanAccess` is
true, **without filtering by org-unit type or `IsActive`**. #161 observed readable
gradebooks for Groups, so Course Offering-only discovery would miss school work.
Access eligibility is a transport constraint, not a relevance judgment.

For each discovered org unit it GETs, with LE **1.82**:

- `content/myItems/` and `content/myItems/due/`, each with `orgUnitIdsCSV`;
- `<course>/content/toc`;
- `<course>/grades/values/myGradeValues/`;
- `overdueItems/myItems`, with `orgUnitIdsCSV`;
- `<course>/dropbox/folders/`, then every returned folder's
  `submissions/mysubmissions/` (**the current student route**).

The versions response is recorded as a shape, not used to silently change the
owner-requested versions. `whoami` is not an authentication gate. A refusal on
one route does not prevent testing unrelated routes. Enrollment or folder errors
cannot supply traversal identifiers. Invalid identifiers stop the pass with an
interruption rather than allowing response data to construct arbitrary URLs.

This first probe reads the first scheduled/overdue page per route. It records
whether `Next` is null or set but **does not follow `Next` URLs**, download content
files or infer backlog completeness. Enrollment pagination is followed because
it is necessary to discover every accessible course. A repeated, empty or
non-string bookmark is an explicit pagination stop, not a successful empty list.

## Reading the summary

Each row contains a **fixed route template** (no actual identifiers), HTTP status,
and `[]`, `{}`, `list of N`, `{Objects:[...]} of N, `object`, `null`, or a redacted
scalar label. Fields are aggregated across all nested objects and arrays; `set N`
means present and non-null, and `null N` means present with a null value.

The formatter emits only allowlisted schema field names. Unknown keys, including
dictionaries keyed by identifiers or names, collapse to `<other field>`; they
cannot leak via property names. It never prints scalar values: no names, course
IDs, titles, grade values, dates, descriptions, API error text or URLs from bodies.
Those omissions also mean the probe **cannot** establish that a status value
means submitted, `-1` means a particular denial, or an end date means a deadline.
It reports shapes, not academic judgments.

`finished` means traversal ended, not that every request succeeded. Compare HTTP
statuses per route between contexts. `200 {}` is different from `403 {…}`, and
`non-json`, `invalid-json`, `redirect-blocked`, and `network-or-timeout` are failures,
not empty results. The network label deliberately does not guess whether the cause
was session policy, timeout, CORS, connectivity or something else.

## Boundaries and collector seam

The manifest grants exactly `alarms`, `storage` and the single LDSB HTTPS host.
Alarms is reserved for the approved collector skeleton; no alarm is scheduled.
No cookie, scripting, tabs, clipboard or password permission is requested.
The browser attaches its existing session to GET requests; extension code never
reads cookies or credentials. JSON API bodies exist transiently in memory. For
the content pass they cross the internal extension message channel to the worker;
only the shape projection reaches session storage, the popup or the clipboard.

**A manifest cannot restrict requests to GET.** The only fetch call in `probe.js`
hard-codes `method: "GET"`; callers can supply a fixed route key and validated
numeric identifiers, never a URL, method or request body. Redirects are manual
and refused; non-JSON responses are not read. Requests have a 15-second timeout.
The isolated content script has no page-world messaging or DOM access.

`read(route, args, fetchImpl)` is the reusable transport. `collect(readRoute,
publish)` is the traversal and shape sink. A later collector can consume the
transport behind its own reviewed projection/signing/push adapter without
weakening this probe's shape-only sink. No key material or receiver URL belongs
in this version, and no migration is introduced.

## Evidence and unverified premises

- Read [PR #161](https://github.com/stremysid/jarvis/pull/161) at
  `63ae51d2ebfe18470d5a36a7fc9ec9e1a11b3618`. It records the host, working LP/LE
  reads, null assignment dates, module dates, folder counts, whoami refusal and
  the **different** `/submissions/` route. None was rechecked on Sid's account by
  this builder. Its broad claim that OAuth registration is absent is not needed
  by this probe and was not independently established here.
- **Prompt/source mismatch:** that revision does not contain the prompt's
  `overdueItems/myItems` empty-envelope observation or the `content/myItems/due/`
  400 without `orgUnitIdsCSV`. Those are owner-supplied observations in this task,
  not findings independently verified here or present in that research revision.
- The [D2L content reference](https://docs.valence.desire2learn.com/res/content.html)
  requires the org-unit list for scheduled items. The
  [dropbox reference](https://docs.valence.desire2learn.com/res/dropbox.html)
  documents GET `submissions/mysubmissions/` for the current user's submissions.
  Both were checked on 2026-09-23 without contacting the LDSB tenant.
- [Chrome's tabs reference](https://developer.chrome.com/docs/extensions/reference/api/tabs)
  explicitly allows matching-tab queries using host permission; a broad `tabs`
  permission is unnecessary. Its
  [network documentation](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)
  distinguishes extension-worker and content-script request origins. Opera GX's
  actual session behaviour in each context remains the experiment, not a claim.
- The requested PC-incident file was absent at
  `C:\Users\Sid\Downloads\jarvis-profile-incident.md`. No permission-changing code,
  services, scheduled tasks, registry, protected Jarvis data or local-agent tests
  were run. The prompt's conflicting `0039` reservations do not affect this work,
  which adds no migration and touches none of the parallel sync-builder files.

## Local checks

From a checkout, using PowerShell and Node 24.19.0:

```powershell
cd C:\path\to\jarvis
pnpm --filter @jarvis/d2l-extension test
pnpm --filter @jarvis/d2l-extension test:mutations
node scripts/check-state.mjs
```

Tests use mocked fetch and extension APIs. The package has no dependencies and
needs no bundler. A separate Windows CI job runs its tests. The mutation runner
requires a single literal match, tests a named passing baseline, observes that
named test fail twice with the fault installed, restores byte-for-byte, then
observes it pass. A missing match is `NOT APPLIED`, never a survived mutation.

No browser was loaded, no D2L request made, and no actual account response, Opera
GX installation, clipboard behaviour or worker lifetime was verified locally.
