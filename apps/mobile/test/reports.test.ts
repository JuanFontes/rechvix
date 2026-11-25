import assert from "node:assert/strict";
import { test } from "node:test";
import { createItem, createParty, insertSale, listSales, searchProducts, setLowAt, type SalePayload } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import { collectionsByMethod, saleReport, stockReport } from "../src/lib/reports";
import { calcInvoice, snapshot } from "../src/lib/tax";
import { cancelLocalSale } from "../src/db/repo";
import { memoryDb } from "./nodedb";

const R = { from: 0, to: 10_000 };
const payload = (cust: string, name: string, lines: { id: string; name: string; qty: string; price: string; discount?: string }[]): SalePayload => {
  const ls = lines.map((l) => ({ variantId: l.id, name: l.name, unitId: "", qty: l.qty, price: l.price, discount: l.discount ?? "0", gstRate: "18" }));
  return { customerId: cust, customerName: name, lines: ls, paymentMethod: null, pricingMode: "INCLUSIVE", calc: snapshot(calcInvoice(ls.map((l) => ({ qty: l.qty, price: l.price, discount: l.discount, gstRate: l.gstRate })), "INCLUSIVE")) };
};

test("sale report: cancelled and out-of-range invoices are left out; customers and items are ranked by what was billed; item discounts are respected", async () => {
  const db = memoryDb(); await migrate(db);
  await insertSale(db, "s1", payload("a", "Asha", [{ id: "bolt", name: "Bolt", qty: "2", price: "100" }, { id: "nut", name: "Nut", qty: "1.5", price: "40", discount: "10" }]), 100, "INV-1");   // 200 + (60-10)=50
  await insertSale(db, "s2", payload("b", "Ben", [{ id: "bolt", name: "Bolt", qty: "1", price: "100" }]), 200, "INV-2");
  await insertSale(db, "s3", payload("a", "Asha", [{ id: "bolt", name: "Bolt", qty: "5", price: "100" }]), 300, "INV-3");
  await insertSale(db, "s4", payload("c", "Cara", [{ id: "bolt", name: "Bolt", qty: "9", price: "100" }]), 400, "INV-4");
  await cancelLocalSale(db, "s4", "mistake", 450);
  await insertSale(db, "s5", payload("d", "Dev", [{ id: "bolt", name: "Bolt", qty: "9", price: "100" }]), 99_999, "INV-5");   // outside the range
  const r = saleReport(await listSales(db, 100), R);
  assert.equal(r.count, 3); assert.equal(r.billedMinor, 85000n, "250 + 100 + 500");
  assert.deepEqual(r.byCustomer.map((c) => [c.name, c.count, c.billedMinor]), [["Asha", 2, 75000n], ["Ben", 1, 10000n]]);
  assert.deepEqual(r.byItem.map((i) => [i.name, i.qty, i.amountMinor]), [["Bolt", "8", 80000n], ["Nut", "1.5", 5000n]]);
  assert.equal(r.averageMinor, 28333n);
  assert.equal(saleReport([], R).count, 0);
});

test("money received by method counts each payment once and respects the range", () => {
  const c = collectionsByMethod([
    { at: 10, amountMinor: 10000n, method: "UPI" }, { at: 20, amountMinor: 5000n, method: "CASH" }, { at: 30, amountMinor: 2500n, method: "UPI" },
    { at: 40, amountMinor: 700n, method: "BANK_TRANSFER" }, { at: 20_000, amountMinor: 9999n, method: "CASH" },
  ], R);
  assert.equal(c.totalMinor, 18200n);
  assert.deepEqual(c.methods.map((m) => [m.method, m.amountMinor, m.count]), [["upi", 12500n, 2], ["cash", 5000n, 1], ["bank transfer", 700n, 1]]);
});

test("stock report: out and low items come first, untracked items are counted not listed, value is stock x price", async () => {
  const db = memoryDb(); await migrate(db);
  const mk = (id: string, name: string, stock: string, price: string) => createItem(db, id, { name, sku: id.toUpperCase(), barcode: "", hsn: "", price, gstRate: "0", stock, unitLabel: "pcs" }, 1);
  await mk("a", "Alpha", "100", "2.50"); await mk("b", "Bravo", "3", "10"); await mk("c", "Charlie", "0", "50"); await mk("d", "Delta", "", "9"); await mk("e", "Echo", "8", "1");
  await setLowAt(db, "E", "10");   // Echo's own level is 10, so 8 is low
  const r = stockReport(await searchProducts(db, "", 100));
  assert.deepEqual(r.rows.map((x) => [x.name, x.state]), [["Charlie", "out"], ["Bravo", "low"], ["Echo", "low"], ["Alpha", "ok"]]);
  assert.equal(r.untracked, 1); assert.equal(r.out, 1); assert.equal(r.low, 2); assert.equal(r.tracked, 4);
  assert.equal(r.valueMinor, 25000n + 3000n + 0n + 800n, "250 + 30 + 0 + 8");
});
