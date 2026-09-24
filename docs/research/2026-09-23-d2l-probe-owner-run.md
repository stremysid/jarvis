<!-- Provenance: Sid ran the GET-only shape probe (apps/d2l-extension at 295fadc, in-tab mode) on his own LDSB account on 2026-09-23 at about 8:25 PM EDT and pasted its shape-only summary to the reviewer session, which recorded it verbatim the same evening. Course names are replaced by A/B/C; only statuses, shapes and counts are kept. The tabs-closed (background service worker) pass was not run. -->

# D2L probe results: Sid's real account, 2026-09-23 about 8:25 PM EDT (shapes only)

Probe v0.1.0 at 295fadc, in-tab (content-script) mode. Background mode: **not run**, so a service-worker read without a tab is still UNTESTED.

**Account-wide results:**
- `/d2l/api/versions/` returns 200, a list of 15.
- `lp/1.43/enrollments/myenrollments/` returns 200 with 50 org units in Items.
  - PagingInfo has a Bookmark and HasMoreItems set, so **there may be more pages: the collector must paginate.**
  - Items carry Name, Code, Type, Access, CanAccess, IsActive, and StartDate/EndDate (12 of 50 set).
- **Most org units are NOT courses a student can read.** For each of those, toc returns 403 (non-JSON), myGradeValues returns 403 (non-JSON), dropbox/folders returns 403 `{Errors:[{Message}]}`, and myItems / myItems/due / overdueItems return `{Objects:[]}`. **Filter to real course offerings** (by Type, and to units where CanAccess and IsActive) before reading, to cut about 300 wasted requests per run.

**One large unit** (probably not a normal course; unverified which): dropbox/folders returns 200, a list of 140.
- DueDate is null on 140 of 140, Availability null on 140, GradeItemId null on 140, ScoreDenominator null on 140.
- 140 mysubmissions calls all returned 200 `[]`.

**The readable courses** (toc 200); 3 courses have content:

| | Course A | Course B | Course C |
|---|---|---|---|
| myItems | `{Objects}` of 5; DueDate, EndDate, StartDate all null | of 60; all dates null | of 12; all dates null |
| toc | 5 topics; EndDateTime and StartDateTime null on all | 50 topics; EndDateTime null on all | 12 topics; EndDateTime null on all |
| myGradeValues | **200 `[]`** (an ARRAY, not `{}`) | **200 `[]`** | **200 `[]`** |
| dropbox/folders | **200 `[]`**, no assignments | **list of 42: DueDate SET on 13, null on 29**; ScoreDenominator set on 17; GradeItemId set on 6; Availability set on 2 | list of 3; DueDate null on all 3 |
| mysubmissions | none | 41 × 200 `[]` and 1 × 403 `{Errors}` | 3 × 200 `[]` |

- myItems/due returned `{Objects:[]}` for every course.
- overdueItems/myItems returned `{Objects:[]}` for every course.

**What this settles:**
1. **mysubmissions (the student route) returns a JSON ARRAY.** An empty `[]` on a 200 is consistent with "nothing submitted", which matches Sid: 0 assignments done. A positive case is still needed to confirm the populated shape. A 403 on a single folder means a refusal: record it, never treat it as "not submitted".
2. **Grades return `[]` arrays** in real courses, and 403 non-JSON in non-course units. No grades are posted yet.
3. **Due dates are SPARSE.** Only the folder DueDate carries dates (13 folders in one course). Topic EndDateTime, myItems dates, myItems/due and overdueItems are all empty. #161's claim that the dates live on modules does NOT hold for this account.
   - **Jarvis must treat most work as "exists, no date in D2L"**, and get dates from Sid or teachers.
   - The mapper uses the folder DueDate first; module or topic dates are just a fallback, and are empty here.
4. **D2L's overdue and due lists are useless here,** because they depend on dates teachers didn't set.
5. **The request volume was high** (about 500 requests). The real collector must filter to course offerings, throttle to about 1 request per second, and cache folder lists.
