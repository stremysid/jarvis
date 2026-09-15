// Reviewer probe (PR #49 S1): each passes when one odd entry fails the whole feed.
import { describe, expect, it } from "vitest";
import { parseBrightspaceCalendar } from "../../src/deadlines/brightspace-ical-client.js";

const good = ["BEGIN:VEVENT", "UID:good-1", "SUMMARY:Essay draft", "CATEGORIES:English", "DTSTART:20260920T160000Z", "END:VEVENT"];
const feed = (odd: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...good, ...odd, "END:VCALENDAR", ""].join("\r\n");
const cases: Record<string, string[]> = {
  S1a_unknown_escape: ["BEGIN:VEVENT", "UID:odd-1", "SUMMARY:Unit 3\: quiz", "DTSTART:20260921T160000Z", "END:VEVENT"],
  S1b_windows_tzid: ["BEGIN:VEVENT", "UID:odd-2", "SUMMARY:Lab", "DTSTART;TZID=Eastern Standard Time:20260921T090000", "END:VEVENT"],
  S1c_underscore_property: ["BEGIN:VEVENT", "UID:odd-3", "SUMMARY:Test", "X-MS_OLK-FLAG:1", "DTSTART:20260921T160000Z", "END:VEVENT"],
  S1d_dst_gap: ["BEGIN:VEVENT", "UID:odd-4", "SUMMARY:Night task", "DTSTART;TZID=America/Toronto:20270314T023000", "END:VEVENT"],
  S1e_duplicate_uid: ["BEGIN:VEVENT", "UID:good-1", "SUMMARY:Copy", "DTSTART:20260922T160000Z", "END:VEVENT"],
};

describe("zz reviewer pr49 strict", () => {
  it("S1-base the good event alone parses", () => {
    expect(parseBrightspaceCalendar(feed([]), "America/Toronto")).toHaveLength(1);
  });
  for (const [name, odd] of Object.entries(cases)) {
    it(`${name} fails the whole feed`, () => {
      expect(() => parseBrightspaceCalendar(feed(odd), "America/Toronto")).toThrow("brightspace_feed_invalid");
    });
  }
});
