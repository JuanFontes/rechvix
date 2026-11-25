import assert from "node:assert/strict";
import { test } from "node:test";
import { hasFilingCalendar, toIso, upcomingFilings } from "./filingCalendar.ts";

const day = (y: number, m: number, d: number) => ({ y, m, d });

test("Spain: in mid-October the third-quarter returns are open and due on the 20th", () => {
  const r = upcomingFilings("ES", day(2026, 10, 15), 10);
  const f303 = r.find((x) => x.form === "303")!;
  assert.equal(toIso(f303.due), "2026-10-20"); assert.equal(f303.daysLeft, 5); assert.equal(f303.state, "open");
  assert.deepEqual(f303.period, { kind: "quarter", year: 2026, n: 3 });
  assert.equal(toIso(r.find((x) => x.form === "111")!.due), "2026-10-20");
});

test("Spain: the fourth quarter is filed in January of the next year (303 and 130 by the 30th, 111 and 115 by the 20th)", () => {
  const r = upcomingFilings("ES", day(2026, 12, 20), 60);
  const due = (form: string) => toIso(r.find((x) => x.form === form && x.period.kind === "quarter")!.due);
  assert.equal(due("303"), "2027-01-30"); assert.equal(due("130"), "2027-01-30"); assert.equal(due("111"), "2027-01-20"); assert.equal(due("115"), "2027-01-20");
  assert.deepEqual(r.find((x) => x.form === "303")!.period, { kind: "quarter", year: 2026, n: 4 });
  assert.equal(r.find((x) => x.form === "303")!.state, "upcoming");
  assert.equal(toIso(r.find((x) => x.form === "390")!.due), "2027-01-30");
});

test("Spain: the 347 deadline is the last day of February, leap years included", () => {
  assert.equal(toIso(upcomingFilings("ES", day(2027, 2, 1), 30).find((x) => x.form === "347")!.due), "2027-02-28");
  assert.equal(toIso(upcomingFilings("ES", day(2028, 2, 1), 30).find((x) => x.form === "347")!.due), "2028-02-29");
});

test("returns whose deadline has passed are never listed, and the list is soonest first", () => {
  const r = upcomingFilings("ES", day(2026, 10, 21), 400);
  assert.ok(r.every((x) => x.daysLeft >= 0));
  assert.ok(!r.some((x) => x.form === "303" && x.period.n === 3 && x.period.year === 2026));
  for (let i = 1; i < r.length; i++) assert.ok(toIso(r[i - 1]!.due) <= toIso(r[i]!.due));
});

test("India: GSTR-1 on the 11th and GSTR-3B on the 20th of the following month, December rolling into January", () => {
  const r = upcomingFilings("IN", day(2026, 11, 25), 60);
  const dues = r.map((x) => `${x.form} ${toIso(x.due)} ${x.period.year}-${x.period.n}`);
  assert.deepEqual(dues, ["GSTR-1 2026-12-11 2026-11", "GSTR-3B 2026-12-20 2026-11", "GSTR-1 2027-01-11 2026-12", "GSTR-3B 2027-01-20 2026-12"]);
});

test("countries without a built-in calendar get an empty list, not a guess", () => {
  assert.deepEqual(upcomingFilings("US", day(2026, 10, 1)), []);
  assert.equal(hasFilingCalendar("US"), false);
  assert.equal(hasFilingCalendar("ES"), true); assert.equal(hasFilingCalendar("IN"), true);
});
