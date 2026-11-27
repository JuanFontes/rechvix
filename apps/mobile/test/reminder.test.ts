import assert from "node:assert/strict";
import { test } from "node:test";
import { addReminder, remindersFor, remindersForSale, setReminderStatus } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import type { LedgerInvoice } from "../src/lib/ledger";
import { agingOf, bucketPercent, composeMessage, planReminder, stalePlan, statusOf, whatsappNumber } from "../src/lib/reminder";
import { statementEntries, statementHtml, statementPayments } from "../src/lib/statement";
import { DEFAULT_PROFILE } from "../src/db/repo";
import { memoryDb } from "./nodedb";

const DAY = 86_400_000, NOW = Date.UTC(2026, 10, 25, 12);
const inv = (id: string, total: number, paid: number, dueDays: number | null, extra: Partial<LedgerInvoice> = {}): LedgerInvoice =>
  ({ id, number: `INV-${id}`, issuedAt: NOW - 40 * DAY, totalMinor: BigInt(total * 100), paidMinor: BigInt(paid * 100), dueAt: dueDays == null ? null : NOW + dueDays * DAY, ...extra });
const money = (x: bigint) => `Rs ${(Number(x) / 100).toFixed(2)}`;
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

test("a partly paid invoice is reminded for what is left, never the original total", () => {
  const p = planReminder([inv("1", 1000, 400, -5)], NOW, "1");
  assert.equal(p.eligible, true); assert.equal(p.outstandingMinor, 60000n); assert.equal(p.paidMinor, 40000n); assert.equal(p.overdueMinor, 60000n); assert.equal(p.daysOverdue, 5);
  const text = composeMessage({ customer: "Asha", business: "Shop", plan: p, money, date, withPdf: false });
  assert.match(text, /outstanding balance of Rs 600\.00/); assert.match(text, /already paid Rs 400\.00 of Rs 1000\.00/); assert.match(text, /which was due on/);
  assert.doesNotMatch(text, /Rs 1000\.00 has/);
});

test("paid, cancelled and unknown invoices are not remindable and say why", () => {
  assert.match(planReminder([inv("1", 500, 500, -3)], NOW, "1").reason!, /already paid in full/);
  assert.match(planReminder([inv("1", 500, 0, -3, { cancelled: true })], NOW, "1").reason!, /cancelled/);
  assert.match(planReminder([inv("1", 500, 0, -3)], NOW, "nope").reason!, /could not be found/);
  assert.equal(planReminder([inv("1", 500, 500, null)], NOW).eligible, false);
});

test("a customer reminder covers every open invoice and ignores settled and cancelled ones", () => {
  const p = planReminder([inv("1", 100, 0, -2), inv("2", 200, 50, 10), inv("3", 300, 300, -9), inv("4", 400, 0, -9, { cancelled: true })], NOW);
  assert.deepEqual(p.invoices.map((i) => i.id), ["1", "2"]); assert.equal(p.outstandingMinor, 25000n); assert.equal(p.overdueMinor, 10000n);
  assert.match(composeMessage({ customer: "A", business: "B", plan: p, money, date, withPdf: false }), /your 2 unpaid invoices \(INV-1, INV-2\)/);
});

test("the PDF sentence appears only when the user chose to include the PDF", () => {
  const p = planReminder([inv("1", 100, 0, 3)], NOW, "1");
  assert.doesNotMatch(composeMessage({ customer: "A", business: "B", plan: p, money, date, withPdf: false }), /PDF/);
  assert.match(composeMessage({ customer: "A", business: "B", plan: p, money, date, withPdf: true }), /PDF/);
  assert.match(composeMessage({ customer: "A", business: "B", plan: p, money, date, withPdf: true }), /, due on 2026-11-28/);
});

test("a change in the balance since the composer opened is flagged", () => {
  const before = planReminder([inv("1", 100, 0, 3)], NOW, "1");
  assert.match(stalePlan(before, planReminder([inv("1", 100, 100, 3)], NOW, "1"))!, /already paid/);
  assert.match(stalePlan(before, planReminder([inv("1", 100, 30, 3)], NOW, "1"))!, /changed/);
  assert.equal(stalePlan(before, before), null);
});

test("WhatsApp numbers: digits only, bare 10-digit numbers get +91, junk is refused", () => {
  assert.equal(whatsappNumber("98765 43210"), "919876543210"); assert.equal(whatsappNumber("+44 7700 900123"), "447700900123");
  assert.equal(whatsappNumber("123"), null); assert.equal(whatsappNumber(""), null); assert.equal(whatsappNumber(undefined), null);
});

test("aging puts each open amount in exactly one bucket and the buckets add up", () => {
  const a = agingOf([inv("1", 100, 0, 5), inv("2", 100, 0, -10), inv("3", 100, 0, -45), inv("4", 100, 0, -75), inv("5", 100, 0, -200), inv("6", 100, 0, null), inv("7", 100, 100, -9), inv("8", 100, 0, -9, { cancelled: true })], NOW);
  assert.deepEqual(a.totals, { current: 20000n, "1-30": 10000n, "31-60": 10000n, "61-90": 10000n, "90+": 10000n });
  assert.equal(a.totalMinor, 60000n); assert.equal(Object.values(a.totals).reduce((x, y) => x + y, 0n), a.totalMinor);
  assert.equal(bucketPercent(20000n, 60000n), 33); assert.equal(bucketPercent(0n, 0n), 0); assert.equal(bucketPercent(5n, 1n), 100);
});

test("statement: running balance, cancelled invoices skipped, closing balance matches what is due", () => {
  const invs = [inv("1", 1000, 300, -5, { issuedAt: NOW - 30 * DAY }), inv("2", 500, 0, 5, { issuedAt: NOW - 10 * DAY }), inv("3", 999, 0, 5, { cancelled: true, issuedAt: NOW - 9 * DAY })];
  const e = statementEntries(invs, [{ at: NOW - 20 * DAY, amountMinor: 30000n, method: "UPI", invoiceNumber: "INV-1" }]);
  assert.deepEqual(e.map((x) => x.balanceMinor), [100000n, 70000n, 120000n]);
  assert.equal(e.length, 3);
  const html = statementHtml({ business: { ...DEFAULT_PROFILE, name: "Shop <b>" }, customer: "Asha & Co", currency: "INR", invoices: invs, payments: [{ at: NOW - 20 * DAY, amountMinor: 30000n, method: "UPI" }], now: NOW });
  assert.match(html, /Asha &amp; Co/); assert.match(html, /Shop &lt;b&gt;/); assert.doesNotMatch(html, /Shop <b>/);
});

test("reminder history is stored per invoice with an honest status, and old rows read as 'share opened'", async () => {
  const fresh = memoryDb(); await migrate(fresh);
  assert.equal((await fresh.first<{ user_version: number }>("PRAGMA user_version"))!.user_version, 9);
  await fresh.run("INSERT INTO reminders(party_id,at,channel) VALUES('c1', 5, 'whatsapp')");
  assert.equal(statusOf((await remindersFor(fresh, "c1"))[0]!.status), "share_opened", "a pre-v6 style row defaults to share_opened");
  const id = await addReminder(fresh, "c1", 10, "pdf", { saleLocalId: "s1", status: "cancelled", withPdf: true, outstanding: "600.00", message: "hi" });
  await setReminderStatus(fresh, id, "marked_sent");
  const r = await remindersForSale(fresh, "s1");
  assert.equal(r.length, 1); assert.equal(r[0]!.status, "marked_sent"); assert.equal(r[0]!.with_pdf, 1); assert.equal(r[0]!.outstanding, "600.00");
  assert.equal((await remindersFor(fresh, "c1")).length, 2);
  assert.equal(statusOf("garbage"), "share_opened");
});

test("statement closing balance equals the app's own balance, including money taken at the till and reversed payments", () => {
  const invs = [inv("1", 1000, 1000, -5, { issuedAt: NOW - 30 * DAY }), inv("2", 500, 200, 5, { issuedAt: NOW - 10 * DAY })];
  const pay = (id: string, sale: string | null, amt: string, extra: object = {}) => ({ id, group_id: id, party_id: "c1", sale_local_id: sale, server_doc_id: null, amount: amt, method: "UPI", reference: "", note: "", paid_at: NOW - 5 * DAY, state: "synced", server_receipt_id: null, error: null, attempts: 0, reversed_at: null, reversal_reason: null, reversal_state: null, created_at: 1, ...extra }) as never;
  // invoice 1 was paid at the till (no payment row); invoice 2 has a 200 payment, and a 50 payment that was reversed.
  const sp = statementPayments(invs, [pay("a", "2", "200.00"), pay("b", "2", "50.00", { reversed_at: 9, reversal_reason: "bounced" })]);
  assert.equal(sp.length, 2); assert.ok(sp.some((p) => p.method === "paid at sale" && p.amountMinor === 100000n && p.invoiceNumber === "INV-1"));
  const e = statementEntries(invs, sp);
  assert.equal(e[e.length - 1]!.balanceMinor, 30000n, "1500 billed - 1000 till - 200 paid = 300, which is what the invoices still owe");
});
