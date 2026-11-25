/** Calendar quarters, for the one-click "close last quarter" on the Accounting page. Dates are plain YYYY-MM-DD (no time zone), so a
 *  quarter is the same days for everyone. Quarters are labelled by their months ("Jul-Sep 2026"), which reads the same under a January
 *  or an April financial year. */
export interface Quarter { year: number; q: 1 | 2 | 3 | 4; start: string; end: string; label: string }

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function quarterOf(year: number, q: 1 | 2 | 3 | 4): Quarter {
  const m1 = (q - 1) * 3 + 1, m3 = m1 + 2;
  return { year, q, start: `${year}-${pad(m1)}-01`, end: `${year}-${pad(m3)}-${pad(lastDay(year, m3))}`, label: `${MONTHS[m1 - 1]}-${MONTHS[m3 - 1]} ${year}` };
}

/** The quarter containing the given date (month 1-12). */
export function quarterContaining(year: number, month: number): Quarter {
  return quarterOf(year, (Math.floor((month - 1) / 3) + 1) as 1 | 2 | 3 | 4);
}

/** The quarter before the one containing the given date. */
export function previousQuarter(year: number, month: number): Quarter {
  const cur = quarterContaining(year, month);
  return cur.q === 1 ? quarterOf(year - 1, 4) : quarterOf(year, (cur.q - 1) as 1 | 2 | 3 | 4);
}

/** The period that covers exactly this quarter, if one was already created (compared by calendar day, ignoring the time part). */
export function periodFor<T extends { StartDate: string; EndDate: string }>(periods: T[], q: Quarter): T | undefined {
  return periods.find((p) => p.StartDate.slice(0, 10) === q.start && p.EndDate.slice(0, 10) === q.end);
}
