import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDayBook, customRange, dayBookHtml, periodRange, type DayBookInput } from "../src/lib/daybook";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 11, 25);   // Wednesday

test("period presets: weeks start Monday, quarters and the financial year follow the start month", () => {
  const w = periodRange("week", NOW); assert.equal(w.from, at(2026, 11, 23, 0)); assert.equal(w.to, at(2026, 11, 30, 0));
  assert.deepEqual(periodRange("today", NOW), { from: at(2026, 11, 25, 0), to: at(2026, 11, 26, 0) });
  assert.deepEqual(periodRange("month", NOW), { from: at(2026, 11, 1, 0), to: at(2026, 12, 1, 0) });
  assert.deepEqual(periodRange("quarter", NOW), { from: at(2026, 10, 1, 0), to: at(2027, 1, 1, 0) });
  assert.deepEqual(periodRange("year", NOW, 4), { from: at(2026, 4, 1, 0), to: at(2027, 4, 1, 0) }, "India: April to March");
  assert.deepEqual(periodRange("year", at(2026, 2, 10), 4), { from: at(2025, 4, 1, 0), to: at(2026, 4, 1, 0) }, "before April belongs to the previous financial year");
  assert.deepEqual(periodRange("year", NOW, 1), { from: at(2026, 1, 1, 0), to: at(2027, 1, 1, 0) });
  assert.deepEqual(periodRange("week", at(2026, 11, 22)), { from: at(2026, 11, 16, 0), to: at(2026, 11, 23, 0) }, "Sunday belongs to the week that began the Monday before");
});

test("custom ranges include the end day and reject impossible or reversed dates", () => {
  assert.deepEqual(customRange("2026-11-01", "2026-11-30"), { from: at(2026, 11, 1, 0), to: at(2026, 12, 1, 0) });
  assert.equal(customRange("2026-02-30", "2026-03-01"), null); assert.equal(customRange("2026-11-10", "2026-11-09"), null); assert.equal(customRange("nope", "2026-11-09"), null);
  assert.deepEqual(customRange("2026-11-10", "2026-11-10"), { from: at(2026, 11, 10, 0), to: at(2026, 11, 11, 0) });
});

const input: DayBookInput = {
  sales: [
    { id: "s1", number: "INV-1", at: at(2026, 11, 25, 10), party: "Asha", partyId: "a", totalMinor: 100000n, cancelled: false },
    { id: "s2", number: "INV-2", at: at(2026, 11, 25, 15), party: "Ben", partyId: "b", totalMinor: 50000n, cancelled: true },
    { id: "s3", number: "INV-3", at: at(2026, 11, 24, 9), party: "Asha", partyId: "a", totalMinor: 70000n, cancelled: false },
  ],
  payments: [
    { id: "p1", at: at(2026, 11, 25, 11), party: "Asha", partyId: "a", amountMinor: 40000n, method: "UPI", invoiceNumber: "INV-1", saleId: "s1" },
    { id: "p2", at: at(2026, 11, 25, 16), party: "Cara", partyId: "c", amountMinor: 5000n, method: "BANK_TRANSFER" },
  ],
  credits: [{ id: "c1", number: "CN-1", at: at(2026, 11, 25, 17), party: "Asha", partyId: "a", totalMinor: 10000n, against: "INV-1", saleId: "s1" }],
};

test("totals come from exactly the rows listed; cancelled invoices show but are not counted", () => {
  const b = buildDayBook(input, periodRange("today", NOW));
  assert.equal(b.entries.length, 5); assert.equal(b.billedMinor, 100000n); assert.equal(b.billedCount, 1);
  assert.equal(b.receivedMinor, 45000n); assert.equal(b.receivedCount, 2); assert.equal(b.creditedMinor, 10000n);
  assert.ok(b.entries.find((e) => e.ref === "INV-2")!.void);
  for (let i = 1; i < b.entries.length; i++) assert.ok(b.entries[i - 1]!.at >= b.entries[i]!.at, "newest first");
  assert.equal(b.entries.find((e) => e.id === "p:p2")!.ref, "Advance", "a payment on no invoice reads as an advance");
});

test("the range is half-open and the filters narrow both the rows and the totals", () => {
  assert.equal(buildDayBook(input, periodRange("week", NOW)).billedMinor, 170000n, "yesterday's invoice is in the week");
  assert.equal(buildDayBook(input, { from: at(2026, 11, 24, 0), to: at(2026, 11, 25, 10) }).billedMinor, 70000n, "an event exactly at `to` is excluded");
  const money = buildDayBook(input, periodRange("today", NOW), "payment");
  assert.equal(money.entries.length, 2); assert.equal(money.billedMinor, 0n); assert.equal(money.receivedMinor, 45000n);
  const asha = buildDayBook(input, periodRange("week", NOW), "all", " asha ");
  assert.ok(asha.entries.every((e) => e.party === "Asha")); assert.equal(asha.billedMinor, 170000n); assert.equal(asha.receivedMinor, 40000n);
  assert.equal(buildDayBook(input, periodRange("week", NOW), "all", "inv-3").entries.length, 1, "searches the reference too");
  assert.equal(buildDayBook(input, periodRange("month", at(2026, 3, 1))).entries.length, 0);
});

test("the printable day book escapes names and states what is counted", () => {
  const b = buildDayBook({ ...input, sales: [{ ...input.sales[0]!, party: "<b>Asha</b> & Co" }] }, periodRange("today", NOW));
  const html = dayBookHtml(b, periodRange("today", NOW), "Shop", "INR", "Today");
  assert.match(html, /&lt;b&gt;Asha&lt;\/b&gt; &amp; Co/); assert.doesNotMatch(html, /<b>Asha/); assert.match(html, /Cancelled invoices are listed struck through/);
});

import { allCreditNotes, allPayments, cancelLocalSale, createItem, insertPayments, insertSale, listSales, type SalePayload } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import { dayBookInput } from "../src/lib/daybookData";
import { buildLedgers } from "../src/lib/receivables";
import { creditsBySale } from "../src/lib/sale";
import { calcInvoice, snapshot } from "../src/lib/tax";
import { memoryDb } from "./nodedb";

test("day book from real records: till money counts once, real payments once, a cancelled invoice's money not at all", async () => {
  const db = memoryDb(); await migrate(db);
  await createItem(db, "i1", { name: "Bolt", sku: "B", barcode: "", hsn: "7318", price: "100", gstRate: "0", stock: "100", unitLabel: "pcs" }, 1);
  const pl = (cust: string, name: string, pay: string | null): SalePayload => {
    const lines = [{ variantId: "i1", name: "Bolt", unitId: "", qty: "1", price: "100", discount: "0", gstRate: "0" }];
    return { customerId: cust, customerName: name, lines, paymentMethod: pay, pricingMode: "INCLUSIVE", calc: snapshot(calcInvoice(lines.map((l) => ({ qty: l.qty, price: l.price, discount: l.discount, gstRate: l.gstRate })), "INCLUSIVE")) };
  };
  const t = at(2026, 11, 25, 10);
  await insertSale(db, "till", pl("a", "Asha", "CASH"), t, "INV-1");          // paid at the till: no payment row
  await insertSale(db, "credit", pl("b", "Ben", null), t + 1, "INV-2");        // on credit, then part paid
  await insertPayments(db, { groupId: "g1", partyId: "b", method: "UPI", reference: "", note: "", paidAt: t + 5, parts: [{ id: "p1", saleLocalId: "credit", amount: "40.00" }] }, t + 5);
  await insertSale(db, "gone", pl("c", "Cara", null), t + 2, "INV-3");         // cancelled with a payment
  await insertPayments(db, { groupId: "g2", partyId: "c", method: "CASH", reference: "", note: "", paidAt: t + 6, parts: [{ id: "p2", saleLocalId: "gone", amount: "100.00" }] }, t + 6);
  await cancelLocalSale(db, "gone", "mistake", t + 7);

  const sales = await listSales(db, 100), pays = await allPayments(db), credits = await allCreditNotes(db);
  const ledgers = buildLedgers(sales.filter((s) => !s.cancelled), pays, t + 100, creditsBySale(credits));
  const b = buildDayBook(dayBookInput(sales, pays, credits, ledgers, new Map()), periodRange("today", NOW));
  assert.equal(b.billedMinor, 20000n, "INV-1 and INV-2 (the cancelled INV-3 is excluded)");
  assert.equal(b.receivedMinor, 14000n, "100 at the till + 40 UPI; the cancelled invoice's 100 is not money received");
  assert.equal(b.receivedCount, 2);
  assert.ok(b.entries.some((e) => e.ref === "INV-3" && e.void));
  assert.ok(!b.entries.some((e) => e.kind === "payment" && e.amountMinor === 10000n && e.party === "Cara"));
  assert.equal(b.entries.filter((e) => e.kind === "payment" && e.party === "Asha").length, 1, "the till payment appears once");
});
