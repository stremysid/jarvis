# PR #41 fact-check and requirements review (school and university plan)

Branch `codex/r5-school-university-plan`, head `607bbf8` (plan commit `c522e8d`), base `0d659bf` (main, PR #39 merged).
Checked 2026-09-15. Read-only; nothing in any repo was changed.

Note on sources: `www.ouac.on.ca/guide/undergrad-dates/` and `guidance.ouac.on.ca/resources/schedule-of-dates/` return HTTP 403 to automated fetches. The OUAC "How to Apply" page (last updated September 14, 2026) loaded. The OUAC Group A page and the guidance schedule could only be read as cached copies, which are older (2024 and the 2024-25 cycle). D2L community KB pages render in JavaScript, so D2L facts are backed by D2L-quoted search snippets plus several universities' Brightspace help pages. Each is marked below.

---

## 1. Fact-check

| # | Claim in PR | Verdict | Source |
|---|---|---|---|
| F1 | OUAC key-dates page says the 2027 application is available "in late September" | **Correct.** The exact banner is on the live How-to-Apply page (updated 2026-09-14): "The 2027 application will be available in late September." | https://www.ouac.on.ca/guide/undergrad-how-to-apply/ |
| F2 | The key-dates page "still presents exact 2026 Group A dates" | **Unverifiable directly (403). Likely correct.** A search snippet of that page shows 2026-cycle dates (e.g. "June 1, 2026" earliest response date). | https://www.ouac.on.ca/guide/undergrad-dates/ |
| F3 | Those 2026 dates must not be copied into the 2027 tracker | **Correct and important.** Third-party sites already publish "OUAC opens Sept 17, 2026" and "Jan 15, 2027 deadline" and attribute them to OUAC. I found no official OUAC page with those dates, so they are **unverified** and must not enter the store. | stellaradvisers.com, cutoffs.ca (not official) |
| F4 | OUInfo's current data covers the 2027–2028 cycle | **Correct.** "valid for Ontario high school students who will enter university in the 2027-2028 application cycle." | https://ouinfo.ca/ |
| F5 | For Group A, the high school provides academic information and grades to OUAC | **Correct** (cached page, last updated 2024-09-18): "your current high school provides your academic information, including grades, to the OUAC". Grades auto-match after submission. Check 1–2 business days later and tell guidance about errors. | https://www.ouac.on.ca/guide/undergrad-academic-information/ |
| F6 | OUInfo is a starting index; the official university page is authoritative | **Correct.** OUAC: "Refer to the application and the university's website for up-to-date program details." | OUAC How to Apply |
| F7 | Brightspace OAuth needs app registration in the admin "Manage Extensibility" tool | **Correct.** Registration happens in "the Manage Extensibility admin tool". Access token lifetime is 1800–72000 s. Refresh tokens are optional per app. Students have no self-registration path. | https://docs.valence.desire2learn.com/basic/oauth2.html |
| F8 | Classroom `dueDate`/`dueTime` are UTC | **Correct.** "Optional date, in UTC…" / "Optional time of day, in UTC…" | https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork |
| F9 | Classroom submissions supply "turned-in, returned, late and assigned" state | **Mostly correct; wording is loose.** The states are NEW, CREATED, TURNED_IN, RETURNED, RECLAIMED_BY_STUDENT (plus STUDENT_EDITED_AFTER_TURN_IN in the doc summary), and `late` is a read-only boolean. There is **no "assigned" or "missing" state**, so missing-work has to be derived (due passed, not turned in). Students "may only view their own work". The scopes are `classroom.coursework.me(.readonly)`. `draftGrade` is teacher-only. `assignedGrade` exists, but the docs I read do not say when a student can see it (unverified). | https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork.studentSubmissions and `.../studentSubmissions/list` |
| F10 | Cloudflare Browser Run has included usage and paid overage | **Correct, but incomplete.** Workers Free: 10 min/day, 3 concurrent browsers, no overage. Workers Paid: 10 browser-hours/month then $0.09/h, and 10 concurrent browsers (monthly average) then $2.00 each. The plan does not say whether Jarvis's account is on Workers Paid. | https://developers.cloudflare.com/browser-run/pricing/ |
| F11 | The existing deadline store can keep "date-only work" without inventing midnight | **Wrong as an implicit claim about existing code.** `0011_deadlines.sql` has `due_at TEXT NOT NULL` (a canonical UTC instant) and no date-only field. Date-only semantics need a schema change or migration, which the plan does not mention. The store does already allow `kind='manual'` sources and `status` open/submitted/missed/cancelled. | repo `apps/cloud-gateway/src/persistence/migrations/0011_deadlines.sql`, `deadlines/deadline-types.ts` |
| F12 | Roadmap status: "R2 active; 0016 schema merged, not applied" | **Correct.** PR #39 merged at `0d659bf`, and 0016/0017 are on main. I did not check PR #40's draft state. | `git log origin/main` |
| F13 | Top-six / U-M / OSSD / scholarships / references / transcripts | **The plan makes no specific factual claim**, so there is nothing wrong, but the model is missing (see §3). For reference: universities generally use the **top six 4U/M courses including ENG4U and prerequisites**, and which courses count varies by university. This is from OUInfo FAQ and uOttawa search results; direct page fetches failed (404/402), so it is *not directly verified this session*. OSSD (ontario.ca, verified) requires 30 credits, 40 community-involvement hours, the literacy requirement (OSSLT or alternative) and 2 online-learning credits. | https://www.ontario.ca/page/high-school-graduation-requirements |
| F14 | Invented dates | **None in the plan.** Good. The one date-bearing statement (F1/F2) is correctly hedged. | |

### Facts the plan omits that change the design (all verified unless marked)

- **G1. The Classroom API can be switched off for students by the school.** A Workspace admin can "choose whether or not users in your domain can grant access to their Classroom data to other applications via OAuth". — https://support.google.com/edu/classroom/answer/6250906
- **G2. Under-18 accounts are blocked from unconfigured third-party apps.** If Sid's account is designated under 18, he sees "Access blocked: Your institution's administrator needs to review [app]", and only an admin can allow it. — https://developers.google.com/workspace/classroom/best-practices/access-control-enhancements , https://support.google.com/a/answer/13288950
- **G3. Google OAuth apps in "Testing" with external user type get refresh tokens that expire in 7 days.** A personal Jarvis OAuth client left in Testing would force Sid to re-consent weekly, which is homework. Moving to production with Classroom scopes triggers Google's app-verification process (the "unverified app" warning, and possibly weeks of review). The exact sensitivity class of each Classroom scope was not verified. — https://developers.google.com/identity/protocols/oauth2 , https://developers.google.com/workspace/classroom/guides/auth
- **G4. D2L's Brightspace EULA, Section 6, restricts automated extraction:** "use any robot, spider or other automatic program or device, or manual process to monitor, copy, summarize, or otherwise extract information from the Product or Service". Whether that binds a student directly, or only through the school board's licence and acceptable-use policy, is **unverified**. Either way, options B and C are exactly this activity. — https://www.d2l.com/legal/brightspace-eula/
- **G5. Ontario boards get Brightspace through the provincial VLE contract** (Ministry-provided, D2L). A board registering one student's personal OAuth app is therefore an unusual ask of central IT. This is my judgement and unverified for Sid's board. — https://www.d2l.com/k-12-ontario/

---

## 2. Brightspace options check (includes the coordinator's two additions)

### Missing option D: the Brightspace calendar iCal feed (should be tried first for deadlines)

- **It exists and is student-side.** Calendar → Settings → "Enable Calendar Feeds", then **Subscribe** generates an iCal link for all calendars or one course. Brightspace describes the result as syncing an external calendar "without logging in to Brightspace". Sources: D2L-quoted search results (https://community.d2l.com/brightspace/kb/articles/3601-manage-course-events-with-the-calendar-tool, https://community.d2l.com/brightspace/kb/articles/16511-about-calendar) and institution guides (https://blog.citl.mun.ca/resourcesforstudents/desire2learn/how-you-access-desire2learn/subscribe-to-a-calendar/, https://www.pcc.edu/help-desk/student/desire2learn/subscribing-to-a-d2l-class-calendar/).
- **Admin gate:** the org config variable `d2l.Tools.Schedule.AllowCalendarFeeds` is **ON by default** (D2L schedule configuration variables KB 4439, via search snippet; full page not rendered). "Some institutions disable external calendar feeds", so it may be off at Sid's board. Unverified for his board.
- **Contents:** calendar events, including start, end and due dates set on content topics, assignments (dropbox) and quizzes. Due dates appear for the learner role based on assignment permissions (D2L community, via snippet). **No grades and no submission status**; the feed is events only (inferred from what the feature is, not stated by D2L).
- **Cloud fit:** a Worker can fetch the tokenised URL hourly with every PC off. There is no browser, no MFA, no school approval, no Linux and no cost. It is an official export interface built for external calendar apps, so it carries far lower ToS risk than scraping, though polling is still automated (G4).
- **Caveats:** the URL is a bearer secret, so it must go into the secret store and not be pasted in chat (the plan already bans tokens in chat). That needs a one-time attended intake step. The feed only contains dated items teachers put on the calendar.

### Missing option E: Brightspace notification emails

Brightspace can email a daily or weekly **Summary of Activity** and **instant notifications**, including grade releases, new assignments, announcements and upcoming quiz/assignment due dates (sources: https://community.d2l.com/brightspace/kb/articles/4822-notifications-in-brightspace-pulse via snippet; https://www.brightspacehelp.usc.edu/students/course-notifications-for-students/ ; https://it.stonybrook.edu/help/kb/updating-your-notifications-settings-in-brightspace). A Cloudflare Email Worker could ingest them, which gives **grade-release signals without scraping**. Cost: Sid would need a forwarding rule from his school email. That is persistent configuration, so it needs a tap, and boards often block external auto-forwarding (unverified). Availability depends on how the board has configured notifications.

### Assessment of the plan's A / B / C

- **A (school OAuth API): not realistic as step one.** It needs board IT to register an app (F7, G5), and Sid has to contact the school. That breaks the "no contacting people" ideal and adds a burden. It could take weeks or never happen. Making A "try first" delays any Brightspace data. Recommend it as a long shot, not a gate.
- **B (Cloudflare Browser Run):** no Linux. Possible Workers Paid dependency and overage charges (F10). It keeps a school SSO session in a cloud browser, is a clear EULA §6 risk (G4), and MFA will re-prompt. The plan's MFA wording drops "via Telegram".
- **C (Windows browser while PC on):** no overnight updates, which the plan admits. **Hidden dependency:** the repo has no browser-automation code (a grep for playwright/browser/selenium/brightspace finds nothing). Option C needs a new Windows local-agent browser driver, which is R3-style "hands" work, while the plan moves R5 ahead of R3. It carries the same EULA §6 risk.
- **Plain-words risk for Sid:** "Having Jarvis log in as you and read D2L pages automatically is probably against D2L's user terms and may break your board's computer-use rules. The calendar-feed link Brightspace gives you, and its notification emails, are official features and much safer."
- **Process issue:** the plan says "Jarvis asks Sid to choose" among A–C. Sid's standing rule is outcomes, not internals. The reviewer should pick the route (D, then E if grades are needed) and bring Sid only the one-time tap.

---

## 3. Requirements check (Sid's words, 2026-09-15)

| Requirement | Status | Plan section / note |
|---|---|---|
| Desperate catch-up help, 2 weeks behind | **Partial** | "Course catch-up" and build step 1 cover it well. No time-box or ship date. It is sequenced as the first slice of R5, which is itself framed as milestone work behind plan and PR review. Nothing says "usable this week on the live Telegram bot". |
| University is significant infrastructure | **Covered in scope, late in sequence** | "University applications" is thorough, but it is build step **5 of 6**, after coaching and Brightspace, even though the application opens in late September (F1). |
| Coach checks in regularly, knows struggles | **Covered** | "Proactive study coach". The cadence is "set by conversation", which is fine. Check-ins only happen "when useful"; Sid asked for "regularly", so make a default cadence explicit. |
| Automatically makes things / finds tools without asking | **Covered** | Quizzes and flashcards are auto-generated. Tool search is automatic, with a tap only for sign-up or spend. |
| No spending, sign-ups or contacting people without a tap | **Covered, one conflict** | The global rule is stated. **Option A requires contacting the school**, and **the Classroom blockers G1/G2 may need school admin action**. Each is a contact-another-person step that Sid must tap and also do the human part of. |
| Integrated powerful calendar, later | **Covered** | R6 read, R7 writes. Note that R6 still "Depends on R3", so the calendar arrives after hands and St. Remy. That matches "later". |
| School top priority after R1 and R2, ahead of PC control and St. Remy | **Covered, inconsistent wording** | See §4. |
| No homework forms; gathered by conversation | **Covered, with hidden homework** | "Conversation, not homework forms" is good. Hidden homework: a weekly Google re-consent if the OAuth app stays in Testing (G3); the "owner OAuth runbook" in PowerShell; asking the school for API access (A). |
| No commands; memory automatic; "forget that" in plain speech | **Partial** | No commands are introduced. **"Forget that" is never mentioned** for course cards, weak-area evidence or the program tracker, and none of these are said to honour R2's plain-speech deletion. |
| Windows 11 + iPhone only; no Linux/server/NAS/VPS; overnight work in Cloudflare | **Covered** | No Linux. Classroom runs in the Cloudflare gateway. B's paid overage is flagged behind a tap. C's staleness is disclosed. |
| Classroom checked automatically | **Covered, blockers not named** | Hourly cloud job. G1–G3 (admin data-access toggle, under-18 block, 7-day Testing tokens, verification) are not mentioned and could stop it entirely. |
| D2L a few times a day, MFA via Telegram | **Partial / regressed** | The roadmap row still says "MFA via Telegram", but the plan's options table and text drop Telegram ("completes MFA when requested"). §4.6 "a few runs a day" still applies but is not restated. |
| D2L view-only | **Partial** | The plan says "reads". There is **no explicit rule that Jarvis never submits, posts or changes anything in D2L or Classroom**. Add it. |
| "Check D2L now" on request | **Missing** | No on-demand refresh for Brightspace or Classroom anywhere in the plan or the roadmap diff. |
| Flags | — | **Paid:** B (Browser Run overage, possibly Workers Paid). **Account creation:** OUAC account creation is Sid's action (OUAC requires it). The plan correctly keeps submission and payment behind a tap, but should say Jarvis never creates the OUAC account. **Contact:** A (school IT), grade-mismatch escalation (correctly left to Sid). **Linux:** none. **Commands:** none. |

Other gaps worth adding:
- **Top-six model.** The mark projection should compute the per-university top-six 4U/M set, including ENG4U and prerequisites, and label which university rule applies (F13).
- **OEN.** Group A applicants need their Ontario Education Number (from the report card) to apply (OUAC How to Apply, verified). This is a one-line tracker item.
- **OSSD check.** Confirm 40 community hours and the literacy requirement are done, as a one-time conversational question (F13).
- **Model quality.** Quizzes and explanations will run on the live DeepSeek model. The plan's "unsupported answers are labeled uncertain" is good, but add an accuracy check for math and science answers before they are presented as correct.

---

## 4. Priority and order check

- **Order:** the milestone table in the diff is R0, R1, R2, **R5**, R3, R4, R6… R5 is renumbered v1.2, and R3/R4 become v1.3/v1.4. **School sits after R1/R2 and before R3/R4, as Sid asked.** R7 (depends on R2, R5) and R8 (depends on R3, R5, R6) stay consistent.
- **Inconsistent wording:**
  - DECISIONS: "moves directly **after** the active R1 calling and R2 cloud-memory work".
  - Plan intro, roadmap R5 and NEXT_STEPS: "**alongside** R1 and R2" / "R5 starts alongside R1 and R2".
  - Pick one. For urgency, "starts now in parallel, ahead of R3/R4" is the right reading of Sid's need. Say so explicitly, and record that this deliberately relaxes the old "Depends on R0 and R2".
- **Dependency change:**
  - The old R5 said "Depends on R0 and R2." The new R5 has no "Depends on" line. It only says the data slice depends on the deployed R0 gateway and weak-area memory "integrates with R2 as that interface lands".
  - That removes a hard R2 dependency. It contradicts nothing else, but it is a real change and should be recorded in DECISIONS as such.
  - Also add a note that course cards and weak-area evidence stored before R2 must migrate into R2 memory, or "forget that" will miss them.
- **Hidden forward dependency:** option C needs Windows browser automation, which does not exist and is R3-shaped (§2).
- **"Session" estimates removed.** The old R5 said "Two sessions". The new R5 has no size, which makes the timing risk invisible.

---

## 5. What could hurt a grade-12 student in the next 2–4 weeks, and a recommended reorder

**What is already live** (HANDOFF/NEXT_STEPS on main): the Telegram text chat with conversation memory, the DeepSeek model, D1 through 0015 (0016/0017 merged, not applied), gateway deployment `28109492`, and the morning digest firing at 07:30 Toronto. The deadline store is built and empty, supports a `manual` source kind, and has open/submitted/missed status. The Classroom client exists unwired.

**Risks in the current sequence:**
1. **The university tracker is step 5.** The OUAC 2027 application opens in late September (verified), and Sid starts applications in about 2 weeks. Program choices, prerequisite gaps and early supplementary or scholarship deadlines are needed before the coaching and Brightspace work finishes.
2. **Nothing guarantees catch-up help ships this week.** Step 1 is right, but it is framed as milestone work behind review. It has no "live on Telegram by date X".
3. **First-semester marks go to universities early.** In the last official schedule I could read (2024-25), OUAC had to receive available 4U/M midterm or final grades from high schools by **Nov 19** and passed them to universities by **Nov 26**. The equivalent 2026-27 dates were not retrievable (403), so treat them as **unverified**. The pattern still means catch-up in September and October directly affects the marks universities see first. Catch-up should target his U/M prerequisite courses first, and the plan's triage should say so.
4. **Classroom OAuth could silently stall for days** on G1–G3 (admin toggle, under-18 block, 7-day Testing tokens), and Brightspace option A could stall for weeks. Neither should gate help.
5. **Date-only deadlines need a schema change** (F11). If treated as a surprise, it becomes a migration that Sid must apply.

**Recommended reordered sequence** (each step a small reviewed PR; none needs R2):

1. **Days 0–3: catch-up conversation on the live Telegram bot.**
   - Courses, platform per course, missed units, what is due, and weak spots.
   - Writes owner-reported items to the existing deadline store as `manual` source (no new source kind).
   - Produces a per-course next action and a daily plan in the existing morning digest.
   - Prioritises 4U/M prerequisite courses.
   - If course cards need a table, keep it one small migration. Otherwise store notes as owner-reported rows, with a documented later move into R2 memory, and support "forget that".
2. **Days 3–7: minimal university tracker.**
   - Program shortlist by conversation; OUAC code, prerequisites and minimum marks from the official university page (OUInfo as index only).
   - Each deadline stored with `cycle`, `source_url` and `verified_at`, or "unverified".
   - A reminder when OUAC's 2027 application opens.
   - OEN and OSSD one-time checks.
   - A top-six average projection from Sid's stated marks.
3. **Week 2: deadlines in the cloud, in parallel.**
   - (a) Brightspace **iCal feed (option D)** fetched by the Worker, with a one-time secure URL intake.
   - (b) Classroom OAuth, with an explicit preflight for G1–G3 and a production (not Testing) consent status so tokens don't expire weekly.
   - Plus "check D2L/Classroom now" on request, and source-health lines in the digest.
4. **Weeks 2–3: coaching loop.** Default check-in cadence, cited quizzes and flashcards on Telegram, and an evidence-based weak-area record.
5. **Week 3+: grade and missing-work watch.** Classroom submissions (derived missing state). For Brightspace grades, use notification emails (option E) if Sid taps a forwarding rule. Only then consider A, and only after a written EULA/AUP check consider B or C.
6. **Later: full application-document track** (essays, references, scholarships, offers), spoken quizzes once R1 is live, then the R6/R7 calendar bridge.

---

## 6. Top requested changes for PR #41

1. **Reorder the build sequence for urgency.**
   - Catch-up conversation, then the minimal university tracker, then deadlines (iCal plus Classroom), then coaching, then grades.
   - State that slices 1–2 ship on the live Telegram, D1 and digest stack without waiting for R2.
   - Reconcile "after" vs "alongside" and record the relaxed R2 dependency.
2. **Rewrite the Brightspace section.**
   - Add option D (student iCal feed via Worker) as first choice for deadlines and E (notification emails) for grade signals.
   - Demote A to a long shot and do not make it "try first".
   - Put B and C behind an explicit D2L EULA §6 / board AUP check, and note C's missing Windows browser-automation dependency.
   - The reviewer picks the route rather than asking Sid to choose internals.
   - Restore "MFA via Telegram", add "check D2L now", and state that Jarvis is view-only in D2L and Classroom.
3. **Name the Classroom blockers and fix the schema gap.**
   - Add G1 (admin Classroom API data-access toggle), G2 (under-18 unconfigured-app block), G3 (7-day Testing refresh tokens and app verification), each with a preflight and a fallback to owner-reported items.
   - Correct the date-only claim: `deadlines.due_at` is a NOT NULL instant, so date-only needs a schema change.
   - Also add the top-six 4U/M model, the OEN/OSSD one-time checks, and "forget that" coverage for school data.

Minor: submission-state wording (no "assigned" or "missing" state in the API); the Browser Run free-tier vs paid limits; the R5 section lacks a "Depends on" line and size estimate. PR #41 CI did not run because of a GitHub billing/spending-limit gate (per AGENT_LOG). That is a money item for Sid, not a test result.
