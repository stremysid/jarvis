# Jarvis D2L collector — Opera GX, Windows 11

**Code review can proceed; complete school ingestion still needs receiver changes.**
The gateway is pinned. Current full batches are retained locally because #169
does not yet accept Durham or news/quizzes. Resolve [the receiver findings](../research/2026-09-23-d2l-collector-contract-gaps.md)
before the owner rollout below. A green local suite is not live acceptance.
This round replaces the shape probe with the collector. Sid approved the account
reads and D2L terms risk on 2026-09-23. Builders never load it or access his account.

## Get the reviewed revision on the PC and laptop

Repeat on **each Windows device**, in **PowerShell 7 (`pwsh`)**. Use the complete
commit SHA cleared by the independent reviewer. This creates a fixed checkout
outside `C:\javis`; no build, package installation, elevation, permissions,
registry or service changes are needed. If the path already exists, stop and
keep it rather than overwriting an existing checkout.

```powershell
cd C:\
$reviewedSha = Read-Host 'Paste the reviewer-approved 40-character collector commit SHA'
if ($reviewedSha -notmatch '^[0-9a-f]{40}$') { throw 'Expected a complete commit SHA' }
if (Test-Path -LiteralPath 'C:\w\jarvis-d2l-collector') { throw 'Destination already exists; keep the existing checkout' }
New-Item -ItemType Directory -Path 'C:\w' -Force | Out-Null
git clone --no-checkout https://github.com/stremysid/jarvis.git C:\w\jarvis-d2l-collector
if ($LASTEXITCODE -ne 0) { throw 'Clone failed' }
cd C:\w\jarvis-d2l-collector
git fetch origin $reviewedSha
if ($LASTEXITCODE -ne 0) { throw 'Reviewed commit fetch failed' }
git checkout --detach $reviewedSha
if ($LASTEXITCODE -ne 0) { throw 'Reviewed commit checkout failed' }
if ((git rev-parse HEAD) -ne $reviewedSha) { throw 'Checkout does not match the reviewed revision' }
```

1. In Opera GX, open `opera://extensions`, enable **Developer mode**, choose
   **Load unpacked**, and select `C:\w\jarvis-d2l-collector\apps\d2l-extension`.
   Remove the old probe if it is still installed; do not run both extensions.
2. Sign in on LDSB yourself. For Durham, follow the course under the LDSB homepage's
   **My Courses in Other Boards**. There is no separate Durham login step.
3. Open the collector popup's **Setup / pairing**. Name this device (Home PC or
   Laptop). Paste the Durham hop URL once, then select **Save and pair**. The URL
   is stored locally, never in the repository or a batch. Setup accepts an HTTPS
   URL starting on either of the two approved D2L hosts, without URL credentials.
4. Match the popup's pairing code to Jarvis's Telegram approval request and
   approve it there. Select **Check pairing and retry push** until it says active.
   Each device has its own non-extractable key and pairing. The receiver's pairing
   window is ten minutes; an expired request needs a new pairing.
5. Select **Sync now**. Check both hosts, the last good read time, course read/refusal
   counts and queued batches. The popup shows course names and fixed status only;
   it never shows grades, assignment text or announcement text. A refused tool does
   not stop the remaining tools. Failure and zero assignments are different states.
   `receiver-contract-incompatible` means queued evidence was withheld because the
   receiver cannot accept it yet; it does not mean the school read was empty.
6. Close every D2L tab without signing out, then select **Test background read**.
   This tests enrollments on both hosts with fallback disabled, so it cannot hide
   a failed background read behind a tab. Report its statuses to the reviewer.
7. Keep the collector enabled for hourly sync and browser-start sync. To stop,
   disable it in `opera://extensions`. Uninstalling removes its local key and
   queue; reinstalling requires pairing again. Neither device can sync while its
   browser is closed. No overnight PC service is installed.

If Durham expires, the collector checks LDSB first, uses an isolated LDSB tab if
needed, then opens the saved hop in a background tab and retries Durham once.
If that fails, sign in on LDSB and click the course link on its homepage once.
Directly opening a Durham course URL restoring federation remains unverified.
The popup and pushed course failures report the failed renewal. If no course has
ever been discovered, the current receiver cannot accept a host-only failure;
that limitation is a blocker in the findings document, not a successful empty read.

## What is collected

LP 1.43 enrollments are paginated. API versions are checked once per host per sync;
missing LP 1.43 or LE 1.82 fails loudly. Only `CanAccess && IsActive` course
offerings are read. The preloaded **DCE D2L BrightSpace Orientation** unit is skipped.
Per course, LE 1.82 reads myItems with orgUnitIdsCSV, toc, dropbox/folders, each
folder's student `submissions/mysubmissions/`, myGradeValues, news and quizzes.
Empty due/overdue routes are not used. API requests are spaced about one second
apart. Each API body is evidence, not an academic judgment.

Null DueDate is **no date known**. A JSON submission 403 is **refused**, never
unsubmitted; its body is retained with `complete:true`. That flag means the response
was fully received, not that permission was granted. Any redirect or non-JSON response, including a 200 login page, is a
session failure. A successful empty JSON list stays an empty list. Another tool
page is marked incomplete instead of silently claiming completeness.

The manifest has only alarms and storage plus the two D2L origins and
`https://jarvis-cloud-gateway.twilight-tree-70b1.workers.dev`. The D2L transport
hard-codes GET with manual redirects. The gateway
transport hard-codes POST with ambient credentials omitted. There is one fetch
call site for either D2L origin and one for the gateway, including all popup assets
in the static check. No cookies, password stores or page DOM are read. No remote
code or evaluation is used. Only the extension popup accesses its own DOM.

Keys and queued canonical batches persist in extension-origin IndexedDB; raw API
bodies never enter popup storage. Retries preserve the exact body bytes and use a
fresh signature/nonce. A refused batch stays queued while other courses are tried.
Course bodies at or above 64 KiB, or exceeding the receiver's structure limits,
become explicit compact failure batches, never truncated successes. There is no
chunking contract to invent. A storage failure is surfaced; no quota-increasing
permission is requested. There is no automatic deletion of undelivered evidence.

## Local verification

Use PowerShell 7 and Node 24.19.0 or later in the Node 24 line:

```powershell
cd C:\w\jarvis-d2l-collector
node --test apps/d2l-extension/test/*.test.js
node apps/d2l-extension/test/mutate.js
node scripts/check-state.mjs
```

Tests use mocked fetch and browser APIs. The mutation runner requires one exact
source match, a passing named baseline, two named fault failures and a passing
byte-exact restoration. Missing matches are NOT APPLIED, never survived.

API shapes were checked against the official [D2L version reference](https://docs.valence.desire2learn.com/res/apiprop.html)
and the supplied probe notes. [Chrome host permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs)
allow matching-tab access without a broad tabs permission. [Extension storage](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)
supports IndexedDB in the service worker. These references do not prove Opera GX
account behavior, key persistence across actual restarts, or live receiver ingestion.
