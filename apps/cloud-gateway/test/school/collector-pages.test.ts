import { expect, it } from "vitest";
import { mapSchoolCourse } from "../../src/school/collector-mapping.js";
import { parseSchoolBatch } from "../../src/school/collector-protocol.js";

it("does not count a different tool response as the next myItems page", () => {
  const at = "2026-09-24T00:00:00.000Z";
  const prefix = "/d2l/api/le/1.82/101/";
  const batch = parseSchoolBatch({ schemaVersion: "1.0", host: "ldsb.elearningontario.ca", readId: "synthetic-pages", startedAt: at,
    courseIds: ["101"], enrollmentComplete: true, course: { id: "101", name: "Synthetic course" }, routes: [
      { route: prefix + "dropbox/folders/", body: [] },
      { route: prefix + "content/toc", body: { Modules: [] } },
      { route: prefix + "grades/values/myGradeValues/", body: {} },
      { route: "/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=101", body: { Objects: [], Next: prefix + "grades/values/myGradeValues/" } },
    ].map((row) => ({ ...row, status: 200, complete: true, fetchedAt: at })) }, new Date(at));
  if (batch.course === null) throw new Error("course fixture required");
  expect(mapSchoolCourse(batch).failures).toContain("/d2l/api/le/1.82/content/myItems/?orgUnitIdsCSV=101:paging_incomplete");
});
