import { formatMinor } from "./money";

/** A day book: everything that happened in a period, in time order. Pure functions over minor units; no clock reads. */
export type Period = "today" | "week" | "month" | "quarter" | "year" | "custom";
export const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" }, { key: "week", label: "This week" }, { key: "month", label: "This month" },
  { key: "quarter", label: "This quarter" }, { key: "year", label: "This year" }, { key: "custom", label: "Pick dates" },
];

export interface Range { from: number; to: number }   // [from, to) in ms, device-local midnight boundaries

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The [from, to) range for a preset. Weeks start on Monday. "This year" is the financial year starting in `fyStartMonth` (1-12; 4 for India, 1 otherwise). */
export function periodRange(p: Exclude<Period, "custom">, now: number, fyStartMonth = 1): Range {
  const n = new Date(now), y = n.getFullYear(), m = n.getMonth();
  switch (p) {
    case "today": return { from: startOfDay(n), to: new Date(y, m, n.getDate() + 1).getTime() };
    case "week": { const back = (n.getDay() + 6) % 7; return { from: new Date(y, m, n.getDate() - back).getTime(), to: new Date(y, m, n.getDate() - back + 7).getTime() }; }
    case "month": return { from: new Date(y, m, 1).getTime(), to: new Date(y, m + 1, 1).getTime() };
    case "quarter": { const q = Math.floor(m / 3) * 3; return { from: new Date(y, q, 1).getTime(), to: new Date(y, q + 3, 1).getTime() }; }
    case "year": { const fy = fyStartMonth - 1, sy = m >= fy ? y : y - 1; return { from: new Date(sy, fy, 1).getTime(), to: new Date(sy + 1, fy, 1).getTime() }; }
  }
}

/** A custom range from two "YYYY-MM-DD" strings, inclusive of the end day. Null when either is not a real date or the end is before the start. */
export function customRange(from: string, to: string): Range | null {
  const parse = (s: string): number | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]) ? d.getTime() : null;
  };
  const a = parse(from), b = parse(to);
  if (a === null || b === null || b < a) return null;
  const e = new Date(b); return { from: a, to: new Date(e.getFullYear(), e.getMonth(), e.getDate() + 1).getTime() };
}

export type EntryKind = "sale" | "payment" | "credit";
export interface DayBookEntry {
  id: string; kind: EntryKind; at: number; party: string; partyId?: string;
  /** Invoice or credit note number. */
  ref: string; amountMinor: bigint; detail?: string;
  /** The invoice this row belongs to, to open it. */
  saleId?: string;
  /** Shown but left out of every total (a cancelled invoice). */
  void?: boolean;
}

export interface DayBookInput {
  sales: { id: string; number: string; at: number; party: string; partyId: string; totalMinor: bigint; cancelled: boolean }[];
  payments: { id: string; at: number; party: string; partyId: string; amountMinor: bigint; method: string; invoiceNumber?: string; saleId?: string }[];
  credits: { id: string; number: string; at: number; party: string; partyId: string; totalMinor: bigint; against?: string; saleId?: string }[];
}

export interface DayBook {
  entries: DayBookEntry[];
  /** Invoices billed (cancelled ones excluded). */
  billedMinor: bigint; billedCount: number;
  /** Money received from customers. */
  receivedMinor: bigint; receivedCount: number;
  /** Credit notes issued. */
  creditedMinor: bigint; creditCount: number;
}

export type KindFilter = "all" | EntryKind;

/** Everything in the range, newest first, with totals that always add up from exactly the rows listed (a text filter or kind filter narrows both). */
export function buildDayBook(i: DayBookInput, r: Range, kind: KindFilter = "all", text = ""): DayBook {
  const needle = text.trim().toLowerCase();
  const inR = (at: number) => at >= r.from && at < r.to;
  const rows: DayBookEntry[] = [
    ...i.sales.filter((s) => inR(s.at)).map((s): DayBookEntry => ({ id: `s:${s.id}`, kind: "sale", at: s.at, party: s.party, partyId: s.partyId, ref: s.number, amountMinor: s.totalMinor, saleId: s.id, void: s.cancelled })),
    ...i.payments.filter((p) => inR(p.at)).map((p): DayBookEntry => ({ id: `p:${p.id}`, kind: "payment", at: p.at, party: p.party, partyId: p.partyId, ref: p.invoiceNumber ?? "Advance", amountMinor: p.amountMinor, detail: p.method.replace(/_/g, " ").toLowerCase(), saleId: p.saleId })),
    ...i.credits.filter((c) => inR(c.at)).map((c): DayBookEntry => ({ id: `c:${c.id}`, kind: "credit", at: c.at, party: c.party, partyId: c.partyId, ref: c.number, amountMinor: c.totalMinor, detail: c.against ? `against ${c.against}` : undefined, saleId: c.saleId })),
  ]
    .filter((e) => kind === "all" || e.kind === kind)
    .filter((e) => !needle || e.party.toLowerCase().includes(needle) || e.ref.toLowerCase().includes(needle))
    .sort((a, z) => z.at - a.at || (a.id < z.id ? -1 : 1));
  const live = rows.filter((e) => !e.void);
  const sum = (k: EntryKind) => live.filter((e) => e.kind === k).reduce((n, e) => n + e.amountMinor, 0n);
  return {
    entries: rows,
    billedMinor: sum("sale"), billedCount: live.filter((e) => e.kind === "sale").length,
    receivedMinor: sum("payment"), receivedCount: live.filter((e) => e.kind === "payment").length,
    creditedMinor: sum("credit"), creditCount: live.filter((e) => e.kind === "credit").length,
  };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const LABEL: Record<EntryKind, string> = { sale: "Invoice", payment: "Payment received", credit: "Credit note" };

/** A printable day book for the chosen range. */
export function dayBookHtml(b: DayBook, r: Range, business: string, currency: string, periodLabel: string): string {
  const m = (x: bigint) => esc(formatMinor(x, currency));
  const d = (ms: number) => esc(new Date(ms).toLocaleDateString());
  const rows = b.entries.map((e) => `<tr${e.void ? ' class="void"' : ""}><td>${esc(new Date(e.at).toLocaleString())}</td><td>${LABEL[e.kind]}${e.void ? " (cancelled)" : ""}</td><td>${esc(e.party)}</td><td>${esc(e.ref)}${e.detail ? ` <span class="muted">${esc(e.detail)}</span>` : ""}</td><td class="r">${e.kind === "credit" ? "-" : ""}${m(e.amountMinor)}</td></tr>`).join("");
  return `<style>body{font-family:Roboto,Helvetica,Arial,sans-serif;color:#16211c;margin:26px;font-size:12px}h1{font-size:20px;margin:0}.muted{color:#5b6b62}
table{width:100%;border-collapse:collapse;margin-top:12px}th,td{padding:6px 8px;border-bottom:1px solid #dbdfd8;text-align:left}th{background:#eef0ec;font-size:11px}.r{text-align:right;font-variant-numeric:tabular-nums}.void{color:#8a948e;text-decoration:line-through}
.sum{display:flex;gap:12px;margin-top:12px}.sum div{flex:1;border:1px solid #c3cac0;border-radius:6px;padding:8px}.k{font-size:10px;color:#5b6b62;text-transform:uppercase}.big{font-size:15px;font-weight:700}</style>
<h1>Day book</h1><div class="muted">${esc(business)} · ${esc(periodLabel)} (${d(r.from)} to ${d(r.to - 1)})</div>
<div class="sum"><div><div class="k">Billed (${b.billedCount})</div><div class="big">${m(b.billedMinor)}</div></div><div><div class="k">Money received (${b.receivedCount})</div><div class="big">${m(b.receivedMinor)}</div></div><div><div class="k">Credit notes (${b.creditCount})</div><div class="big">${m(b.creditedMinor)}</div></div></div>
<table><thead><tr><th>When</th><th>Type</th><th>Customer</th><th>Reference</th><th class="r">Amount</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">Nothing in this period.</td></tr>`}</tbody></table>
<p class="muted" style="margin-top:16px">Billed is the invoice total at the time it was made. Cancelled invoices are listed struck through and are not counted.</p>`;
}
