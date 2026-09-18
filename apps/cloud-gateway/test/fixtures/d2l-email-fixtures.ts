export type D2lFixtureKind =
  | "assignment_due"
  | "assignment_updated"
  | "feedback_released"
  | "grade_released"
  | "new_content"
  | "announcement"
  | "address_verification";

export interface D2lEmailFixture {
  readonly name: string;
  readonly kind: D2lFixtureKind;
  readonly format: "text" | "html";
  readonly raw: string;
}

const FROM = "D2L Notifications <no-reply@notifications.minds-online.example>";

function message(
  name: string,
  kind: D2lFixtureKind,
  format: "text" | "html",
  subject: string,
  body: string,
): D2lEmailFixture {
  const contentType = format === "html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
  return Object.freeze({
    name,
    kind,
    format,
    raw: `From: ${FROM}\r\nSubject: ${subject}\r\nMessage-ID: <${name}@notifications.minds-online.example>\r\nDate: Thu, 17 Sep 2026 20:00:00 -0400\r\nMIME-Version: 1.0\r\nContent-Type: ${contentType}\r\n\r\n${body}\r\n`,
  });
}

const bodies: Readonly<Record<D2lFixtureKind, Readonly<{
  subject: string;
  text: string;
  html: string;
}>>> = Object.freeze({
  assignment_due: Object.freeze({
    subject: "Assignment due soon",
    text: "Course: Grade 12 Chemistry\nAssignment: Titration lab\nAssignment ID: chemistry-lab-4\nDue Date: September 25, 2026 at 11:59 PM",
    html: "<html><body><p>Course: Grade 12 Chemistry</p><p>Assignment: Titration lab</p><p>Assignment ID: chemistry-lab-4</p><p>Due Date: September 25, 2026 at 11:59 PM</p></body></html>",
  }),
  assignment_updated: Object.freeze({
    subject: "Assignment due date updated",
    text: "Course: Advanced Functions\nAssignment: Polynomial investigation\nAssignment ID: functions-7\nDue Date: 2026-09-28 15:30",
    html: "<html><body><p>Course: Advanced Functions</p><p>Assignment: Polynomial investigation</p><p>Assignment ID: functions-7</p><p>Due Date: 2026-09-28 15:30</p></body></html>",
  }),
  feedback_released: Object.freeze({
    subject: "Feedback released for an assignment",
    text: "Course: English\nAssignment: Hamlet paragraph\nAssignment ID: english-hamlet-2",
    html: "<html><body><p>Course: English</p><p>Assignment: Hamlet paragraph</p><p>Assignment ID: english-hamlet-2</p></body></html>",
  }),
  grade_released: Object.freeze({
    subject: "Grade released",
    text: "Course: Calculus\nAssignment: Limits quiz\nAssignment ID: calculus-quiz-1\nGrade: 18 / 20",
    html: "<html><body><p>Course: Calculus</p><p>Assignment: Limits quiz</p><p>Assignment ID: calculus-quiz-1</p><p>Grade: 18 / 20</p></body></html>",
  }),
  new_content: Object.freeze({
    subject: "New content available",
    text: "Course: Biology\nContent: Genetics review\nContent ID: biology-content-8",
    html: "<html><body><p>Course: Biology</p><p>Content: Genetics review</p><p>Content ID: biology-content-8</p></body></html>",
  }),
  announcement: Object.freeze({
    subject: "New announcement",
    text: "Course: Physics\nTitle: Lab room change\nItem ID: physics-announcement-3",
    html: "<html><body><p>Course: Physics</p><p>Title: Lab room change</p><p>Item ID: physics-announcement-3</p></body></html>",
  }),
  address_verification: Object.freeze({
    subject: "Confirm your email address",
    text: "Verify email address\nCode: D2L-482917",
    html: "<html><body><img src=\"https://images.minds-online.example/logo.png\"><p>Verify your email address.</p><p><a href=\"https://notifications.minds-online.example/verify?token=test-token\">Verify email</a></p></body></html>",
  }),
});

export const D2L_EMAIL_FIXTURES: readonly D2lEmailFixture[] = Object.freeze(
  (Object.keys(bodies) as D2lFixtureKind[]).flatMap((kind) => {
    const fixture = bodies[kind];
    return [
      message(`${kind}-text`, kind, "text", fixture.subject, fixture.text),
      message(`${kind}-html`, kind, "html", fixture.subject, fixture.html),
    ];
  }),
);
