# LDSB Brightspace API: what a student session can actually read

**Observed:** 2026-09-23, on Sid's home PC, from a browser session already logged
in as himself. He loaded URLs; nobody logged in on his behalf, and no API client
was written.

**Status:** the reads below are **observed**, not inferred. Every `200` in this
document came back from the real board. Where something is unproven it says so
in the finding itself.

**Why this exists.** The P2 brief and PR #160 both assume the school data is only
reachable by driving a browser and parsing HTML, and PR #160 records that
student endpoint permissions were unverified. This document replaces that
assumption with evidence, and records two traps that would have produced a
silently-empty result.

---

## 1. Method, and what it does not prove

Sid opened these URLs in a browser where he was already signed in. **The
authorisation in every case was his own session cookie**, which is how the web
app talks to the API.

That matters for reading this document:

* It proves the **data exists and his account may read it**.
* It proves **nothing** about whether an OAuth token can read the same routes.
  A token is issued to a *client* with a fixed scope list, and access is checked
  per route — which is demonstrated by §2.7, where his own valid session is
  refused on one route and allowed on its neighbours.

No credential was entered, no certificate was installed, and no proxy was used.
Nothing here required acceptance of any terms beyond using LDSB's own web
interface as a student.

---

## 2. Findings

Board: `https://ldsb.elearningontario.ca` (Limestone DSB, "Minds Online"), tenant
on `*.elearningontario.ca`. API versions used: **LP 1.43**, **LE 1.82**. The P2
plan's `1.30`/`1.51` are stale — the September 2026 reference lists `1.74-` as
obsolete and `1.82+` as current.

### 2.1 Course and org-unit list — readable

```
GET /d2l/api/lp/1.43/enrollments/myenrollments/
→ 200, JSON
```

Returns a paged object: `PagingInfo` (`Bookmark`, `HasMoreItems`) and `Items`,
each with `OrgUnit` (`Id`, `Type{Id,Code,Name}`, `Name`, `Code`, `HomeUrl`,
`ImageUrl`) and `Access` (`IsActive`, `StartDate`, `EndDate`, `CanAccess`,
`ClasslistRoleName`, `LISRoles`, `LastAccessed`).

Observed org-unit types: `1 Organization`, `3 Course Offering`, `4 Group`,
`467 School`.

**Two things a reader would get wrong from this alone:**

* **An org-unit's `Type` does not predict whether it has a gradebook.** The
  currently-enrolled sections appear as `Type.Id: 4` (Group) — but the board's
  own gradebook serves one of them (`/d2l/lms/grades/my_grades/main.d2l?ou=…`).
  Concluding "a Group has no gradebook, so the grades route must want a Course
  Offering id" is wrong, and a first pass at this report made exactly that error.
* **`CanAccess` is per-row, and inactive courses are still listed.** A sync that
  filters on `IsActive` alone will attempt courses it cannot open.

### 2.2 Assignment definitions and rubrics — readable

```
GET /d2l/api/le/1.82/<orgUnitId>/dropbox/folders/
→ 200, JSON array of DropboxFolder
```

Per assignment: `Id`, `Name`, `CustomInstructions{Text,Html}`, `Attachments[]`,
`Assessment{ScoreDenominator,Rubrics[]}`, `DropboxType`, `SubmissionType`,
`CompletionType`, `DueDate`, `Availability`, `GradeItemId`, `ActivityId`.

Full rubric trees come back too — criteria groups, criteria, levels, and the
per-cell descriptor text. That is far more than a deadline reader needs.

### 2.3 TRAP — assignment `DueDate` is null; dates live on the module

In the observed payload **every assignment's `DueDate` was `null`**, including
ones that plainly had deadlines, while the enclosing **module** carried
`StartDateTime` / `EndDateTime`.

A deadline reader keyed on the obvious field reports almost nothing, and does so
*silently* — an empty list is indistinguishable from "nothing is due". This is
precisely the class of failure the P2 brief's "a page whose shape you did not
expect is a failure, not 'no assignments'" rule exists to prevent.

**Unproven:** whether `DueDate` is null board-wide or only for the folders
observed. Either way it cannot be assumed non-null.

### 2.4 TRAP — submission counts are denied to a student

Every `TotalUsersWithSubmissions` observed was **`-1`**, along with
`TotalFiles`, `UnreadFiles`, `FlaggedFiles`, and `TotalUsers`.

D2L's dropbox reference defines `-1` for these fields as *"the number of users
enrolled in the corresponding org unit is too large to performant calculation
… **or the requesting user does not have permission to access this
information**"*.

**Consequence:** the folder list cannot answer "what have I not submitted". Any
design that reads submission state from it produces an empty backlog that looks
like good news.

### 2.5 Grades — route reachable, empty

```
GET /d2l/api/le/1.82/<orgUnitId>/grades/values/myGradeValues/
→ 200, {}
```

**The empty object is not a failure.** It is distinguishable from a refusal:

| Response | Meaning |
|---|---|
| `200 {}` | permitted; this student has no grade values yet |
| `403 {"Errors":[{"Message":"Not Authorized"}]}` | refused — see §2.7 |

Sid had no grades at that point, and said so independently of the response.
**Unproven:** the populated shape has not been seen. A first real grade will
show it.

### 2.6 Per-entity submission status — readable, semantics unproven

```
GET /d2l/api/le/1.82/<orgUnitId>/dropbox/folders/<folderId>/submissions/
→ 200, {}
```

Returns `{}` rather than an array or `[]`.

D2L's reference describes `EntityDropbox` (which carries `Status`, with
`0 Unsubmitted / 1 Submitted / 2 Draft / 3 Published`) as existing *"once they've
made a submission"*. Read literally, an entity that has never submitted is
**absent from the response**, so an empty result means "unsubmitted" — which
would be exactly the signal a missing-work feature needs, and matches Sid having
submitted nothing.

**This is unproven.** It needs one positive case: a folder where the entity *has*
submitted, returning a `Status`. Sid has no submissions this year, and his
past-semester courses report `CanAccess: false`, so the confirming case may not
be available at all. **Do not build on the empty-means-unsubmitted reading until
it is confirmed.**

### 2.7 Content tree — readable

```
GET /d2l/api/le/1.82/<orgUnitId>/content/toc
→ 200, JSON
```

Nested `Modules[]` → `Topics[]`, each topic with `TopicId`, `Title`, `Url`,
`TypeIdentifier`, `CompletionType`, `Unread`, `LastModifiedDate`,
`ActivityId`. Topic entries point at the assignment (`ToolItemId` matches the
dropbox `Id`) and the topic `Description` repeats the assignment instructions.

### 2.8 CONTROL — a valid session is refused, per route

```
GET /d2l/api/lp/1.43/users/whoami
→ 403, {"Errors":[{"Message":"Not Authorized"}]}
```

Same session, same host, same moment as the `200`s above.

**This is the most important single result in the document.** It establishes
that a valid, fully authenticated identity is not sufficient — authorisation is
checked **per route**. It also supplies the exact error shape a refusal takes,
which is what makes §2.5's "empty is not refused" reading possible.

Its practical consequence: a borrowed OAuth token getting `403` on
`dropbox/folders/` is a live possibility, not a theoretical one.

### 2.9 No self-service OAuth client on this tenant

```
GET /d2l/lms/manage/oauth2/                                    → 404
GET /.well-known/openid-configuration                          → 404
GET /d2l/lp/auth/oauth2/.well-known/openid-configuration       → 404
```

The D2L OAuth client-registration tool is a separate deployment component and
is **not present on LDSB**. The discovery endpoints are not served either.

**Consequence:** there is no supported route by which this student can obtain a
first-party `client_id`. The design document's "school-approved narrow OAuth
remains the best conditional unattended transport, but it is unavailable now"
is confirmed unavailable.

---

## 3. What this means

### 3.1 It changes the recommended architecture

PR #160 recommends an in-page collector, which implies reading the board's HTML.
**That is no longer necessary.** The data is already structured JSON on stable,
versioned routes. A collector can `fetch()` these paths in-page with the
session already present and parse typed fields.

The P2 brief frames the PC implementation as "writing a parser for HTML you
cannot see" and demands loud, named failures for unexpected page shapes. That
framing is now the wrong risk: the endpoints are stable and versioned, while
HTML structure is neither. **Parsing HTML would be choosing the more brittle of
two available sources.**

### 3.2 What survives, what changes, what dies

| P2 / #160 element | Verdict |
|---|---|
| PC reads D2L while logged in | **Survives** — and is now easier |
| In-page collector, session-first | **Survives**, but should read the API not the DOM |
| Deadlines from D2L | **Survives**, with §2.3's caveat — module dates, not assignment `DueDate` |
| Missing-work from the folder list | **Dies** — §2.4 |
| Missing-work from per-folder submission reads | **Conditional** — §2.6, unproven |
| Grades | **Survives** — §2.5 |
| Course content for the study coach | **Survives** — §2.7 |
| Borrowed Pulse OAuth token | **Dead end** — §2.9 plus §2.8 |
| School-approved OAuth client | **Unavailable** — §2.9 |

### 3.3 Why the token route should be dropped

Not only because the `client_id` is unobtainable without intercepting the phone's
TLS. Even if obtained:

* §2.8 shows authorisation is per route, so a borrowed client's scopes may not
  cover `dropbox/folders/` at all; and
* §2.9 removed the legitimate alternative.

The token route costs an evening of proxy and certificate work and may return
nothing. The session route is proven, needs no new credential, and works while
the PC is awake — which is the window the plan already builds for.

### 3.4 A non-technical constraint worth recording

An ENG4UE assignment's own instructions state that submitted work *"must be
created by you and only you"*, under the course's ethics agreement. Separately,
D2L records the submitter's identity.

Therefore: Jarvis may read, summarise, remind and organise. **It must not author
work for submission, and must not submit.** A record that Jarvis submitted
something under Sid's identity would be a misrepresentation to his school, and
would put his standing at risk. The plan's own prompts already aim at "tell him
which one to start right now", which is inside the line; anything producing
submittable text is outside it.

---

## 4. What is still unknown

| Question | Why it matters | What would settle it |
|---|---|---|
| Does an empty `submissions/` result mean "unsubmitted"? | The whole missing-work feature rests on it | One folder where the entity has submitted, returning a `Status` |
| Is `DueDate` null board-wide? | Determines whether deadlines come from modules or assignments | A folder on another board, or a term with populated dates |
| What does a populated `myGradeValues` look like? | Field names for a grades display | One real grade |
| Do any of these routes accept an OAuth token? | Only relevant if the token route is revived | A token, which §2.9 makes unobtainable |
| Does the in-page fetch work from an extension context? | The recommended transport | PR #160's own unrun experiments |

---

## 5. How to reproduce

Open each URL below in a browser already signed in to
`https://ldsb.elearningontario.ca`. Substitute an org-unit id from §2.1.

```
/d2l/api/lp/1.43/enrollments/myenrollments/
/d2l/api/lp/1.43/users/whoami                                   ← the 403 control
/d2l/api/le/1.82/<orgUnitId>/dropbox/folders/
/d2l/api/le/1.82/<orgUnitId>/grades/values/myGradeValues/
/d2l/api/le/1.82/<orgUnitId>/content/toc
/d2l/api/le/1.82/<orgUnitId>/dropbox/folders/<folderId>/submissions/
```

Read only. Nothing here writes to D2L, and no request body is needed.

**Do not paste response bodies into a chat, a repo file, or a log.** They contain
course names, instructor names and assignment text. Record status codes and
field names only.

---

## 6. Provenance and limits

* Observed by Sid loading URLs in his own browser and reporting status codes and
  response shapes. The author of this document did not log in, did not contact
  LDSB, and received no credential or session cookie.
* The verbatim payloads from these calls are **not** retained in the repository;
  they contained personal and academic third-party content.
* D2L's own semantics for `-1` in §2.4 and for `EntityDropbox` in §2.6 come from
  the dropbox reference at <https://docs.valence.desire2learn.com/res/dropbox.html>
  (September 2026 edition).
* Every conclusion above is bounded by what was actually observed. §2.3, §2.5
  and §2.6 each carry an explicit unproven clause; do not build on them without
  the confirming observation named in §4.
