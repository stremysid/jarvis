import { expect, it } from "vitest";
import type { JsonValue } from "../../../../packages/contracts/src/index.js";
import { mapSchoolCourse } from "../../src/school/collector-mapping.js";
import { parseSchoolBatch } from "../../src/school/collector-protocol.js";

const at = "2026-09-24T00:00:00.000Z";
const prefix = "/d2l/api/le/1.82/101/";

function mappedFailures(routes: readonly { route: string; status?: number; body: JsonValue }[]): readonly string[] {
  const batch = parseSchoolBatch({ schemaVersion: "1.0", host: "ldsb.elearningontario.ca", readId: "synthetic-pages", startedAt: at,
    courseIds: ["101"], enrollmentComplete: true, course: { id: "101", name: "Synthetic course" },
    routes: routes.map((row) => ({ ...row, status: row.status ?? 200, complete: true, fetchedAt: at })) }, new Date(at));
  if (batch.course === null) throw new Error("course fixture required");
  return mapSchoolCourse(batch).failures;
}

it("does not count a different tool response as the next myItems page", () => {
  expect(mappedFailures([
    { route: prefix + "dropbox/folders/", body: [] },
    { route: prefix + "content/toc", body: { Modules: [] } },
    { route: prefix + "grades/values/myGradeValues/", body: [] },
    { route: "/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=101", body: { Objects: [], Next: prefix + "grades/values/myGradeValues/" } },
  ])).toContain("/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=101:paging_incomplete");
});

it("marks a next page with status 403 as incomplete", () => {
  const route = "/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=101";
  const next = route + "&bookmark=next";
  expect(mappedFailures([
    { route, body: { Objects: [], Next: next } },
    { route: next, status: 403, body: { Errors: [] } },
  ])).toContain(`${route}:paging_incomplete`);
});

it("marks quiz paging information with more items as incomplete", () => {
  const route = prefix + "quizzes/";
  expect(mappedFailures([{ route, body: { Objects: [], PagingInfo: { HasMoreItems: true } } }]))
    .toContain(`${route}:paging_incomplete`);
});

it("marks a numeric next page as incomplete", () => {
  const route = prefix + "quizzes/";
  expect(mappedFailures([{ route, body: { Objects: [], Next: 5 } }])).toContain(`${route}:paging_incomplete`);
});
