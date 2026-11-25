import { formatMinor } from "./money";
import { dueOf, type LedgerInvoice } from "./ledger";
import type { Payment, Profile } from "../db/repo";
import { parseMinor } from "./decimal";
import { agingOf, BUCKETS } from "./reminder";
import { livePayments } from "./sale";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface StatementPayment { at: number; amountMinor: bigint; method: string; reference?: string; invoiceNumber?: string }
export interface StatementEntry { at: number; kind: "invoice" | "payment"; text: string; debitMinor: bigint; creditMinor: bigint; balanceMinor: bigint }

/** The account as a running ledger: invoices add to what is owed, payments take it down. Cancelled invoices are left out (they never counted).
 *  Reversed payments are not passed in. The closing balance equals the sum of what is still due on the open invoices plus any advance. */
export function statementEntries(invoices: LedgerInvoice[], payments: StatementPayment[]): StatementEntry[] {
  const raw: Omit<StatementEntry, "balanceMinor">[] = [];
  for (const i of invoices) if (!i.cancelled) raw.push({ at: i.issuedAt, kind: "invoice", text: `Invoice ${i.number}`, debitMinor: i.totalMinor, creditMinor: 0n });
  for (const p of payments) raw.push({ at: p.at, kind: "payment", text: `Payment${p.invoiceNumber ? ` for ${p.invoiceNumber}` : " (advance)"} · ${p.method.replace(/_/g, " ").toLowerCase()}${p.reference ? ` · ${p.reference}` : ""}`, debitMinor: 0n, creditMinor: p.amountMinor });
  raw.sort((a, z) => a.at - z.at || (a.kind === z.kind ? 0 : a.kind === "invoice" ? -1 : 1));
  let bal = 0n;
  return raw.map((e) => { bal += e.debitMinor - e.creditMinor; return { ...e, balanceMinor: bal }; });
}

export interface StatementInput { business: Profile; customer: string; phone?: string; currency: string; invoices: LedgerInvoice[]; payments: StatementPayment[]; now: number }

/** A printable account statement. Same figures the app shows; a neutral A4 layout. */
export function statementHtml(s: StatementInput): string {
  const m = (x: bigint) => esc(formatMinor(x, s.currency));
  const entries = statementEntries(s.invoices, s.payments);
  const closing = entries.length ? entries[entries.length - 1]!.balanceMinor : 0n;
  const ag = agingOf(s.invoices.filter((i) => !i.cancelled), s.now);
  const rows = entries.map((e) => `<tr><td>${esc(new Date(e.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }))}</td><td>${esc(e.text)}</td><td class="r">${e.debitMinor ? m(e.debitMinor) : ""}</td><td class="r">${e.creditMinor ? m(e.creditMinor) : ""}</td><td class="r">${m(e.balanceMinor)}</td></tr>`).join("");
  const aging = BUCKETS.map((b) => `<td class="r"><div class="k">${b.label}</div>${m(ag.totals[b.key])}</td>`).join("");
  const open = s.invoices.filter((i) => dueOf(i) > 0n).length;
  return `<style>
 body{font-family:Roboto,Helvetica,Arial,sans-serif;color:#16211c;margin:26px;font-size:12px}
 h1{font-size:20px;margin:0 0 2px} .muted{color:#5b6b62} .k{font-size:10px;color:#5b6b62;text-transform:uppercase;letter-spacing:.04em}
 table{width:100%;border-collapse:collapse;margin-top:14px} th,td{padding:7px 8px;border-bottom:1px solid #dbdfd8;text-align:left} th{background:#eef0ec;font-size:11px}
 .r{text-align:right;font-variant-numeric:tabular-nums} .box{border:1px solid #c3cac0;border-radius:6px;padding:10px;margin-top:14px} .big{font-size:16px;font-weight:700}
</style>
<h1>Statement of account</h1>
<div class="muted">${esc(s.business.name)}${s.business.address ? `<br>${esc(s.business.address).replace(/\n/g, "<br>")}` : ""}${s.business.phone ? `<br>Phone ${esc(s.business.phone)}` : ""}${s.business.gstin ? `<br>GSTIN ${esc(s.business.gstin)}` : ""}</div>
<div class="box"><div class="k">Customer</div><div class="big">${esc(s.customer)}</div>${s.phone ? `<div>${esc(s.phone)}</div>` : ""}<div class="muted">As of ${esc(new Date(s.now).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }))} · ${open} open invoice${open === 1 ? "" : "s"}</div></div>
<table><thead><tr><th>Date</th><th>Details</th><th class="r">Billed</th><th class="r">Received</th><th class="r">Balance</th></tr></thead><tbody>${rows || `<tr><td colspan="5" class="muted">No activity yet.</td></tr>`}</tbody></table>
<div class="box"><div class="k">${closing >= 0n ? "Balance owed to us" : "Advance held for the customer"}</div><div class="big">${m(closing >= 0n ? closing : -closing)}</div></div>
<table><thead><tr>${BUCKETS.map((b) => `<th class="r">${b.label}</th>`).join("")}</tr></thead><tbody><tr>${aging}</tr></tbody></table>
<p class="muted" style="margin-top:18px">Overdue is counted from each invoice's due date. This statement lists what is recorded in Rechvix at the time it was made.</p>`;
}

/** Turns a customer's ledger into statement rows. Money that was taken at the till when the invoice was made has no payment row of its own
 *  (the invoice just records how it was paid), so it is shown as a payment on the invoice date: otherwise the statement would say the
 *  customer still owes it, and would disagree with the To collect screen. Reversed payments never appear. */
export function statementPayments(invoices: LedgerInvoice[], payments: Payment[]): StatementPayment[] {
  const live = livePayments(payments);
  const numberOf = new Map(invoices.map((i) => [i.id, i.number]));
  const out: StatementPayment[] = live.map((p) => ({ at: p.paid_at, amountMinor: parseMinor(p.amount), method: p.method, reference: p.reference || undefined, invoiceNumber: p.sale_local_id ? numberOf.get(p.sale_local_id) : undefined }));
  const listed = new Map<string, bigint>();
  for (const p of live) if (p.sale_local_id) listed.set(p.sale_local_id, (listed.get(p.sale_local_id) ?? 0n) + parseMinor(p.amount));
  for (const i of invoices) {
    if (i.cancelled) continue;
    const gap = (i.paidMinor > i.totalMinor ? i.totalMinor : i.paidMinor) - (listed.get(i.id) ?? 0n);
    if (gap > 0n) out.push({ at: i.issuedAt, amountMinor: gap, method: "paid at sale", invoiceNumber: i.number });
  }
  return out;
}
