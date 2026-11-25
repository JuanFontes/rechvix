import assert from "node:assert/strict";
import { test } from "node:test";
import { allocateBillDiscount } from "../src/lib/billDiscount";
import { calcInvoice } from "../src/lib/tax";

const L = (qty: string, price: string, gstRate: string, discount = "0") => ({ qty, price, gstRate, discount });
const sum = (xs: string[]) => xs.reduce((n, x) => n + BigInt(Math.round(Number(x) * 100)), 0n);

test("the pieces add up to exactly the discount, whatever the split (no paisa lost or invented)", () => {
  const lines = [L("1", "33.33", "18"), L("1", "33.33", "18"), L("1", "33.34", "5")];
  for (const amt of ["10", "0.01", "0.02", "7.77", "99.99", "50.5"]) {
    const r = allocateBillDiscount(lines, "INCLUSIVE", { kind: "amount", text: amt });
    assert.ok(r.ok, amt); if (r.ok) { assert.equal(sum(r.discounts), BigInt(Math.round(Number(amt) * 100)), `amount ${amt}`); assert.equal(r.totalMinor, BigInt(Math.round(Number(amt) * 100))); }
  }
});

test("the invoice total drops by exactly the discount, in both pricing modes", () => {
  const lines = [L("2", "100", "18"), L("1", "250.50", "12"), L("3", "19.99", "0")];
  for (const mode of ["INCLUSIVE", "EXCLUSIVE"] as const) {
    const before = calcInvoice(lines, mode, false).totalMinor;
    const r = allocateBillDiscount(lines, mode, { kind: "amount", text: "30" });
    assert.ok(r.ok); if (!r.ok) return;
    const after = calcInvoice(lines.map((l, i) => ({ ...l, discount: r.discounts[i]! })), mode, false).totalMinor;
    if (mode === "INCLUSIVE") assert.equal(before - after, 3000n, "inclusive: the customer pays exactly 30 less");
    else assert.ok(before > after, "exclusive: tax shrinks with the taxable value");
  }
});

test("percent discounts round half up on the whole bill and never exceed it", () => {
  const lines = [L("1", "100", "0"), L("1", "50", "0")];
  const r = allocateBillDiscount(lines, "INCLUSIVE", { kind: "percent", text: "12.5" });
  assert.ok(r.ok); if (r.ok) { assert.equal(r.totalMinor, 1875n); assert.equal(sum(r.discounts), 1875n); assert.deepEqual(r.discounts, ["12.50", "6.25"]); }
  const all = allocateBillDiscount(lines, "INCLUSIVE", { kind: "percent", text: "100" });
  assert.ok(all.ok); if (all.ok) assert.equal(all.totalMinor, 15000n);
  assert.equal(allocateBillDiscount(lines, "INCLUSIVE", { kind: "percent", text: "100.5" }).ok, false);
});

test("it stacks on item discounts and never pushes an item below zero", () => {
  const lines = [L("1", "100", "0", "40"), L("1", "10", "0")];
  const r = allocateBillDiscount(lines, "INCLUSIVE", { kind: "amount", text: "70" });
  assert.ok(r.ok); if (r.ok) { assert.equal(r.discounts[0], "100.00", "60 left on item 1, all of it taken, plus the earlier 40"); assert.equal(r.discounts[1], "10.00"); assert.equal(sum(r.discounts), 11000n, "40 earlier + 70 now"); }
  const bad = allocateBillDiscount(lines, "INCLUSIVE", { kind: "amount", text: "70.01" });
  assert.equal(bad.ok, false); if (!bad.ok) assert.match(bad.error, /more than the bill/);
});

test("blank, zero, junk and an empty bill are handled without changing anything", () => {
  const lines = [L("1", "100", "18", "5")];
  for (const t of ["", "  ", "0", "0.00"]) { const r = allocateBillDiscount(lines, "INCLUSIVE", { kind: "amount", text: t }); assert.ok(r.ok); if (r.ok) { assert.deepEqual(r.discounts, ["5"]); assert.equal(r.totalMinor, 0n); } }
  assert.equal(allocateBillDiscount(lines, "INCLUSIVE", { kind: "amount", text: "abc" }).ok, false);
  assert.equal(allocateBillDiscount(lines, "INCLUSIVE", null).ok, true);
  assert.equal(allocateBillDiscount([], "INCLUSIVE", { kind: "amount", text: "5" }).ok, false);
});
