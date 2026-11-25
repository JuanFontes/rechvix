/** A read-only calendar of periodic tax filings. It only says WHEN a return is normally due: it does not file anything and does not know
 *  whether a return has been filed. Deadlines are the standard national ones; special regimes (regional tax authorities, QRMP, large
 *  filers, extensions) differ, so the screen always tells the user to confirm with the authority. */

export interface CalDate { y: number; m: number; d: number }   // m = 1..12
export type PeriodKind = "quarter" | "month" | "year";
export interface FilingItem {
  /** Stable key: form + period. */
  id: string;
  form: string;
  /** i18n key (under tax.filing.form.*) for what the return is. */
  nameKey: string;
  period: { kind: PeriodKind; year: number; n: number };
  /** The first day it can be filed and the last day it is normally due. */
  opens: CalDate;
  due: CalDate;
  /** Days from today to the due date (0 = due today). */
  daysLeft: number;
  state: "open" | "upcoming";
}

const utc = (c: CalDate) => Date.UTC(c.y, c.m - 1, c.d);
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const daysBetween = (from: CalDate, to: CalDate): number => Math.round((utc(to) - utc(from)) / 86_400_000);
export const toIso = (c: CalDate): string => `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;

interface Rule {
  form: string; nameKey: string;
  /** Candidate windows for a given calendar year Y: each says which period it covers and when it opens and falls due. */
  windows(y: number): { period: FilingItem["period"]; opens: CalDate; due: CalDate }[];
}

/** Spain (AEAT). Quarterly returns fall due 1-20 of April, July and October for the previous quarter; the fourth quarter is filed in January. */
const esQuarterly = (form: string, nameKey: string, q4DueDay: number): Rule => ({
  form, nameKey,
  windows: (y) => [
    { period: { kind: "quarter", year: y, n: 1 }, opens: { y, m: 4, d: 1 }, due: { y, m: 4, d: 20 } },
    { period: { kind: "quarter", year: y, n: 2 }, opens: { y, m: 7, d: 1 }, due: { y, m: 7, d: 20 } },
    { period: { kind: "quarter", year: y, n: 3 }, opens: { y, m: 10, d: 1 }, due: { y, m: 10, d: 20 } },
    { period: { kind: "quarter", year: y - 1, n: 4 }, opens: { y, m: 1, d: 1 }, due: { y, m: 1, d: q4DueDay } },
  ],
});
const esAnnual = (form: string, nameKey: string, opens: CalDate, due: (y: number) => CalDate): Rule => ({
  form, nameKey, windows: (y) => [{ period: { kind: "year", year: y - 1, n: 1 }, opens: { ...opens, y }, due: due(y) }],
});

const RULES: Record<string, Rule[]> = {
  ES: [
    esQuarterly("303", "tax.filing.form.es303", 30),
    esQuarterly("130", "tax.filing.form.es130", 30),
    esQuarterly("111", "tax.filing.form.es111", 20),
    esQuarterly("115", "tax.filing.form.es115", 20),
    esQuarterly("349", "tax.filing.form.es349", 30),
    esAnnual("390", "tax.filing.form.es390", { y: 0, m: 1, d: 1 }, (y) => ({ y, m: 1, d: 30 })),
    esAnnual("190", "tax.filing.form.es190", { y: 0, m: 1, d: 1 }, (y) => ({ y, m: 1, d: 31 })),
    esAnnual("180", "tax.filing.form.es180", { y: 0, m: 1, d: 1 }, (y) => ({ y, m: 1, d: 31 })),
    esAnnual("347", "tax.filing.form.es347", { y: 0, m: 2, d: 1 }, (y) => ({ y, m: 2, d: lastDay(y, 2) })),
  ],
  // India GST, monthly filers: GSTR-1 by the 11th and GSTR-3B by the 20th of the following month. QRMP (quarterly) filers differ.
  IN: [
    { form: "GSTR-1", nameKey: "tax.filing.form.ingstr1", windows: (y) => monthly(y, 11) },
    { form: "GSTR-3B", nameKey: "tax.filing.form.ingstr3b", windows: (y) => monthly(y, 20) },
  ],
};

/** The return for each month of year y-1..y is filed in the following month: opens on the 1st, due on `day`. */
function monthly(y: number, day: number) {
  const out: ReturnType<Rule["windows"]> = [];
  for (let m = 1; m <= 12; m++) {
    // Period month m of year y is filed in month m+1 (January of y+1 for December).
    const fy = m === 12 ? y + 1 : y, fm = m === 12 ? 1 : m + 1;
    out.push({ period: { kind: "month", year: y, n: m }, opens: { y: fy, m: fm, d: 1 }, due: { y: fy, m: fm, d: day } });
  }
  return out;
}

export const hasFilingCalendar = (country: string): boolean => country in RULES;

/** Returns returns that are open to file now or fall due within `horizonDays`, soonest due date first. Past-due returns are not listed:
 *  the app cannot know whether they were filed. */
export function upcomingFilings(country: string, today: CalDate, horizonDays = 120): FilingItem[] {
  const rules = RULES[country.toUpperCase()] ?? [];
  const out: FilingItem[] = [];
  for (const r of rules) {
    for (const y of [today.y - 1, today.y, today.y + 1]) {
      for (const w of r.windows(y)) {
        const daysLeft = daysBetween(today, w.due);
        if (daysLeft < 0 || daysLeft > horizonDays) continue;
        const id = `${r.form}:${w.period.kind}:${w.period.year}:${w.period.n}`;
        if (out.some((o) => o.id === id)) continue;
        out.push({ id, form: r.form, nameKey: r.nameKey, period: w.period, opens: w.opens, due: w.due, daysLeft, state: daysBetween(today, w.opens) <= 0 ? "open" : "upcoming" });
      }
    }
  }
  return out.sort((a, z) => daysBetween(z.due, a.due) || a.form.localeCompare(z.form, "en", { numeric: true }));
}
