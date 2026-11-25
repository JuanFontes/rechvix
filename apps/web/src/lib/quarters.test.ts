import assert from "node:assert/strict";
import { test } from "node:test";
import { periodFor, previousQuarter, quarterContaining, quarterOf } from "./quarters.ts";

test("each quarter spans the right days, leap February included", () => {
  assert.deepEqual([quarterOf(2026, 1).start, quarterOf(2026, 1).end], ["2026-01-01", "2026-03-31"]);
  assert.deepEqual([quarterOf(2026, 2).start, quarterOf(2026, 2).end], ["2026-04-01", "2026-06-30"]);
  assert.deepEqual([quarterOf(2026, 3).start, quarterOf(2026, 3).end], ["2026-07-01", "2026-09-30"]);
  assert.deepEqual([quarterOf(2026, 4).start, quarterOf(2026, 4).end], ["2026-10-01", "2026-12-31"]);
  assert.equal(quarterOf(2028, 1).end, "2028-03-31");
  assert.equal(quarterOf(2026, 3).label, "Jul-Sep 2026");
});

test("the current and previous quarter, including across New Year", () => {
  assert.equal(quarterContaining(2026, 11).label, "Oct-Dec 2026");
  assert.equal(quarterContaining(2026, 10).q, 4); assert.equal(quarterContaining(2026, 9).q, 3); assert.equal(quarterContaining(2026, 1).q, 1);
  assert.equal(previousQuarter(2026, 11).label, "Jul-Sep 2026");
  const jan = previousQuarter(2027, 2);
  assert.deepEqual([jan.year, jan.q, jan.start, jan.end], [2026, 4, "2026-10-01", "2026-12-31"]);
});

test("an existing period is found by its calendar days, ignoring the time part", () => {
  const ps = [{ StartDate: "2026-07-01T00:00:00Z", EndDate: "2026-09-30T00:00:00Z", ID: "a" }, { StartDate: "2026-10-01T00:00:00Z", EndDate: "2026-12-30T00:00:00Z", ID: "b" }];
  assert.equal(periodFor(ps, quarterOf(2026, 3))?.ID, "a");
  assert.equal(periodFor(ps, quarterOf(2026, 4)), undefined, "a period ending a day early is not this quarter");
});
