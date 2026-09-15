# School and university plan

Status: proposed R5 scope. This document changes no runtime, account, secret,
migration or deployment.

Sid is in Grade 12 in Ontario, has an owner-reported two-week absence to catch
up from, and expects to begin university applications soon. School and
university support is therefore the next product priority alongside the active
R1 calling and R2 memory work. R5 starts from the already-built deadline store
and digest; it does not wait for R3 PC control or R4 St. Remy.

## Outcomes

R5 is complete when Jarvis can:

1. build and keep current a catch-up plan for every course;
2. show verified Google Classroom and Brightspace work in the morning digest,
   with source-health, reminders, grades and missing-work alerts;
3. act as a proactive study coach that learns weak areas from evidence and
   produces quizzes, flashcards and optional spoken practice;
4. manage the whole university-application track without inventing a date or
   silently treating an estimate as an admission requirement; and
5. feed school and application commitments into the personal calendar added
   across R6 and R7, rather than creating a second calendar product.

Anything that spends money, creates an account, accepts terms, submits an
application, contacts another person or releases a transcript remains behind
Sid's explicit tap. A model conclusion, high confidence or a looming deadline
never bypasses that rule.

## Conversation, not homework forms

Jarvis gathers the plan through an ordinary conversation and asks only the
next useful question. It starts with courses and which platform each course
uses, then asks what was missed, what is currently due, what feels weak, and
which programs Sid is considering. It reuses owner-confirmed answers from R2
memory when available and asks again when a remembered fact is stale or
uncertain.

There is no onboarding form, spreadsheet for Sid to fill out, or demand that
he transcribe every assignment. Platform data supplies what it can. Sid can
answer with rough statements such as "chemistry is caught up except the lab";
Jarvis records that as owner-reported and keeps it visibly distinct from a
platform-confirmed submission or grade.

The conversation never asks Sid to paste a password, OAuth token, recovery
code or MFA code into chat. Owner OAuth is an attended setup described in a
runbook, and secrets go straight to the configured secret store.

## Course catch-up

Jarvis maintains one private course card per active course:

- course label and source platform;
- the units and lessons missed during the absence;
- overdue, due-soon and not-yet-posted work;
- the current grade evidence that is actually available;
- prerequisites or concepts blocking later work;
- the next concrete study action and an owner-adjustable effort estimate;
- evidence source, retrieval time and freshness for every platform-derived
  claim.

The first pass is recovery triage, not a perfect semester plan. Jarvis orders
work by hard due date, missing/overdue state, admission-course impact and
dependency on later lessons. It proposes a realistic daily sequence, asks Sid
to correct teacher-specific or offline work the platforms cannot see, and
replans after each check-in. It never marks work complete merely because a due
date passed or an assignment disappeared from a scrape.

The morning digest contains a short school section: today's commitments,
overdue or missing work, the next few verified deadlines, the catch-up action
for each course, and an explicit health line for Classroom and Brightspace.
"No work due" and "source could not be read" must remain different states.

## Deadline, grade and missing-work ingestion

Google Classroom runs in the always-on Cloudflare gateway. The existing
`classroom-client.ts` and `deadline-ingestion.ts` are wired behind explicit
configuration. The API describes `dueDate` and `dueTime` as UTC; ingestion
stores an RFC 3339 UTC instant and presentation converts it to the configured
`DIGEST_TIMEZONE`. Date-only work keeps date-only semantics rather than
inventing midnight. One owner-observed assignment is still required to confirm
that the school's Classroom UI and the API agree before the times are called
live-accepted.

Classroom submission data supplies turned-in, returned, late and assigned
state where the owner's granted scopes expose it. Brightspace supplies the
same outcomes only through the access route Sid selects below. A lower grade or
new missing-work observation produces a same-day alert; routine deadline
reminders stay in the digest unless their configured urgency threshold is
crossed. Thresholds and reminder lead time are learned by conversation and can
be changed or snoozed in conversation.

All platform titles and course content are untrusted text. They may be quoted,
summarized or used to make study material, but never treated as instructions to
Jarvis or as authority for an external action.

## Where Brightspace access runs: Sid chooses the outcome

The Brightspace OAuth documentation requires application registration in the
administrator's Manage Extensibility tool. That makes school-approved API
access the best outcome but not something Jarvis can assume is available.

| Option | Outcome for Sid | What must be true | Cost and limits |
|---|---|---|---|
| **A. School-approved Brightspace OAuth API in Cloudflare — recommended** | Deadlines, submissions and grades refresh overnight with every PC off. The morning digest uses a stable, scoped API rather than page selectors. | The school board enables a least-privilege application and the necessary read scopes. Contacting the school or accepting registration terms requires Sid's tap. | No new host. Availability and fields depend on the board's Brightspace configuration. Until the board confirms it, this outcome is **unverified**. |
| **B. Cloudflare Browser Run session** | The gateway can read UI-only Brightspace data overnight even when both Windows PCs are off. | A security review approves storing a revocable school session in the cloud; the school's terms permit automation; SSO and MFA can be completed through an attended, owner-tapped flow. | More brittle than an API and exposes the school session to a cloud browser. Browser Run has included usage and paid overage; enabling any possible charge requires Sid's tap. |
| **C. Existing Windows browser session** | No school session is moved to a cloud browser. Jarvis reads Brightspace only while the selected PC and its normal browser profile are available, then uploads sanitized deadline observations. | Sid chooses the PC and completes MFA when requested. | Nothing refreshes overnight. The digest uses the last successful snapshot with its age and catches up when the PC is next on. |

Recommendation: try A first because it gives the reliable all-PCs-off outcome
with the narrowest interface. If the school will not enable it, begin with C so
catch-up work can proceed without putting a school login into a new cloud
browser. Consider B only after a separate policy/security review and an
owner-approved cost ceiling. Jarvis asks Sid to choose in conversation; this
plan does not make the choice for him.

## Proactive study coach

The coach has a small regular loop whose cadence and quiet hours are set by
conversation:

1. check what changed in deadlines, submissions and grades;
2. ask a short check-in when progress, a weak area or a new conflict makes one
   useful;
3. update each course's next action and the catch-up sequence;
4. generate practice from the exact course material or owner-provided topic;
5. record what Sid found easy, uncertain or wrong as evidence, not as a fixed
   trait.

Weak-area inference uses grade components, repeated quiz errors and Sid's own
statements. It shows the evidence and confidence, allows correction, and never
turns one low mark into a durable judgment. Generated quizzes and flashcards
cite the source lesson, assignment or owner instruction. Unsupported answers
are labeled uncertain rather than supplied as fact.

Jarvis can create built-in question sets and flashcards without another
account. When an outside tool would materially help, it searches current
official product pages for free or school-provided options, states what is free
and what is unverified, and asks before any sign-up, subscription, spending or
school-data transfer. "Free trial" is not treated as free if it can roll into a
charge.

After R1 calling is live, Sid may start an optional spoken quiz on a call.
Jarvis reads one question at a time, accepts interruption and speech errors,
explains the answer, and feeds the result into the same evidence record. Audio
is not retained. Spoken practice is an additional channel, not a dependency
for the text coach or R5 release.

## University applications

Jarvis creates this tracker by conversation, starting from target subjects and
programs rather than asking Sid to complete a questionnaire.

### Program and marks track

For every candidate program, store:

- university, campus, program name and current OUAC code;
- required Grade 12 courses and any minimum course marks;
- published minimum average separately from a competitive range or historical
  estimate;
- supplementary application, portfolio, interview or audition requirements;
- current source URL, admission cycle, retrieval time and verification state;
- Sid's current and projected admission average using only the verified course
  set.

OUInfo is a starting index, but a requirement becomes verified only against
the current official university program/admissions page. Competitive ranges
that a university does not guarantee remain estimates. Jarvis must say which
marks are mathematically needed to reach a target average, which published
minimums are hard requirements, and which admission outcomes remain uncertain.

### Application and document track

Track the OUAC application, university portals, supplementary forms,
scholarships and awards, essays and personal statements, references,
transcripts, offers, conditions and response steps. Each item has an owner,
status, exact source, due instant or date-only deadline, timezone where
applicable, and last-verified time.

Jarvis may research, outline, critique and revise essays with Sid. It may draft
a reference request or admissions question, but it cannot contact the referee,
teacher, guidance office or university without a tap. It cannot attest that
AI-assisted writing complies with a university's rules until the current rule
is verified. Submitting an application, ordering a paid transcript, accepting
an offer or paying any fee always requires a tap and a final read-back.

### Date-verification rule

No remembered date, search snippet, prior-cycle page or model answer enters the
deadline store as verified. The source must be the current OUAC application,
OUAC's current-cycle guide, the relevant university's official page or an
owner-provided official notice. Every exact date carries `cycle`, `source_url`
and `verified_at`. If the page has not published the current date, Jarvis stores
"unverified — awaiting current-cycle source" and reminds Sid to verify without
inventing a placeholder.

As checked on 2026-09-15, OUAC's official key-dates page says the 2027
application will be available in late September but still presents exact 2026
Group A dates. Those 2026 dates must not be copied into Sid's 2027 tracker.
OUInfo says its current data covers the 2027–2028 cycle, but each selected
program's requirements and deadlines still require the official university
source.

For a current Ontario high-school applicant in OUAC Group A, the official OUAC
guide says the high school provides academic information and grades to OUAC.
Jarvis still tracks whether the expected marks appear and escalates a mismatch
to Sid; it does not contact guidance or release a transcript on its own.

## Personal calendar in R6 and R7

R5 writes verified school and application commitments to the existing deadline
model. R6 adds the read side of Sid's personal calendar: one combined agenda,
travel/departure reminders, school events and application commitments, without
automatic external writes. R7 adds managed calendar writes, protected focus
blocks and profile-aware scheduling as reversible tier-2 actions after shadow
mode. Anything inviting or notifying another person remains tier 3.

This split keeps one source of truth. R5 does not build a separate school
calendar that later has to be merged.

## Build sequence

1. **Conversation and recovery plan.** Gather courses, platform coverage,
   missed work and target programs; produce the first per-course catch-up plan.
2. **Classroom deadlines.** Wire the existing client into the hourly job behind
   configuration, use UTC due fields, render in local time and add digest tests
   plus the owner OAuth runbook.
3. **Status and coaching.** Add submission/grade observations, missing-work
   transitions, reminders, check-ins, quizzes and flashcards.
4. **Brightspace path.** Record Sid's choice among A–C, build only that route,
   and prove source-failure versus no-work behavior.
5. **University tracker.** Add current-source verification, mark projection,
   supplements, scholarships and controlled document/reference workflows.
6. **Calendar bridge.** Define the shared read model for R6 and the reversible
   write boundary for R7.

Each implementation slice gets a separate reviewed PR. No live account setup,
OAuth consent, school contact, payment, application submission, migration or
deployment is part of a code review.

## Exit

Through conversation alone, Jarvis has a current catch-up action for every
course and a program shortlist with sourced requirements. The morning digest
lists one real, live-accepted Google Classroom deadline and one real
Brightspace deadline through Sid's chosen route, at the correct Toronto time,
while naming stale or failed sources. A test grade or submission change drives
the missing-work/weak-area flow; Jarvis creates a cited quiz and flashcard set,
and the spoken form works once R1 calls are available. The tracker distinguishes
verified current-cycle application, supplementary and scholarship dates from
unverified ones and computes the required marks from verified prerequisites.
No spend, sign-up, submission, transcript release or contact occurs without
Sid's tap.

## Official sources checked for this plan

- [OUAC Undergraduate — Key Dates](https://www.ouac.on.ca/guide/undergrad-dates/)
- [OUAC Undergraduate — How to Apply](https://www.ouac.on.ca/guide/undergrad-how-to-apply/)
- [OUAC Undergraduate — Academic Information for Group A](https://www.ouac.on.ca/guide/undergrad-academic-information/)
- [OUInfo program index](https://ouinfo.ca/) and [OUInfo scholarships](https://ouinfo.ca/scholarships/)
- [Google Classroom `CourseWork` resource](https://developers.google.com/workspace/classroom/reference/rest/v1/courses.courseWork)
- [Brightspace OAuth 2 authentication](https://docs.valence.desire2learn.com/basic/oauth2.html)
- [Cloudflare Browser Run overview](https://developers.cloudflare.com/browser-run/get-started/) and [pricing](https://developers.cloudflare.com/browser-run/pricing/)

The OUAC and university pages are live sources. Jarvis rechecks them for the
active application cycle instead of treating this document's 2026-09-15 source
review as permanent truth.
