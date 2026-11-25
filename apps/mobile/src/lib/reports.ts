import type { Product, Sale } from "../db/repo";
import type { Range } from "./daybook";
import { dec, decToString, mulDec, toMinor } from "./decimal";
import { payloadCalc, saleTotalMinor } from "./sale";
import { stockState } from "./stock";

/** Reports drawn only from this phone's own records, so they work with no signal. Every figure says what it counts. */

export interface SaleReport {
  count: number; billedMinor: bigint; averageMinor: bigint;
  byCustomer: { partyId: string; name: string; count: number; billedMinor: bigint }[];
  byItem: { key: string; name: string; qty: string; amountMinor: bigint }[];
}

/** Billed sales in the range (cancelled invoices left out), ranked by customer and by item, biggest first.
 *  An item's amount is what customers were charged for it after any discount, GST included. */
export function saleReport(sales: Sale[], r: Range): SaleReport {
  const live = sales.filter((s) => !s.cancelled && s.created_at >= r.from && s.created_at < r.to);
  const cust = new Map<string, { partyId: string; name: string; count: number; billedMinor: bigint }>();
  const items = new Map<string, { key: string; name: string; qty: bigint; amountMinor: bigint }>();
  let billed = 0n;
  for (const s of live) {
    const total = saleTotalMinor(s);
    billed += total;
    const c = cust.get(s.payload.customerId) ?? { partyId: s.payload.customerId, name: s.payload.customerName, count: 0, billedMinor: 0n };
    c.count += 1; c.billedMinor += total; cust.set(s.payload.customerId, c);
    const calc = payloadCalc(s.payload);
    s.payload.lines.forEach((l, i) => {
      const k = l.variantId || l.name;
      const it = items.get(k) ?? { key: k, name: l.name, qty: 0n, amountMinor: 0n };
      it.qty += dec(l.qty); it.amountMinor += calc.lines[i]?.grossMinor ?? 0n; items.set(k, it);
    });
  }
  const byBilled = <T extends { billedMinor: bigint; name: string }>(a: T, z: T) => (z.billedMinor > a.billedMinor ? 1 : z.billedMinor < a.billedMinor ? -1 : a.name.localeCompare(z.name));
  return {
    count: live.length, billedMinor: billed, averageMinor: live.length ? (billed + BigInt(live.length) / 2n) / BigInt(live.length) : 0n,
    byCustomer: [...cust.values()].sort(byBilled),
    byItem: [...items.values()].map((i) => ({ key: i.key, name: i.name, qty: decToString(i.qty), amountMinor: i.amountMinor }))
      .sort((a, z) => (z.amountMinor > a.amountMinor ? 1 : z.amountMinor < a.amountMinor ? -1 : a.name.localeCompare(z.name))),
  };
}

export interface MethodTotal { method: string; amountMinor: bigint; count: number }
/** Money received in the range, by how it was paid. Takes the day book's payment rows, so till money and recorded payments both count once. */
export function collectionsByMethod(payments: { at: number; amountMinor: bigint; method: string }[], r: Range): { totalMinor: bigint; methods: MethodTotal[] } {
  const by = new Map<string, MethodTotal>();
  let total = 0n;
  for (const p of payments) {
    if (p.at < r.from || p.at >= r.to) continue;
    const key = p.method.replace(/_/g, " ").toLowerCase();
    const m = by.get(key) ?? { method: key, amountMinor: 0n, count: 0 };
    m.amountMinor += p.amountMinor; m.count += 1; by.set(key, m); total += p.amountMinor;
  }
  return { totalMinor: total, methods: [...by.values()].sort((a, z) => (z.amountMinor > a.amountMinor ? 1 : z.amountMinor < a.amountMinor ? -1 : a.method.localeCompare(z.method))) };
}

export interface StockRow { id: string; name: string; sku: string; unit: string; stock: string; state: "out" | "low" | "ok"; valueMinor: bigint }
export interface StockReport { tracked: number; untracked: number; out: number; low: number; valueMinor: bigint; rows: StockRow[] }

/** Items with a stock figure, the ones to reorder first (out, then low), and the stock's value at each item's selling price (GST excluded
 *  from nothing: it is simply stock x the price stored on the item, so treat it as a guide, not a book value). */
export function stockReport(products: Product[]): StockReport {
  const rows: StockRow[] = [];
  let untracked = 0, out = 0, low = 0, value = 0n;
  for (const p of products) {
    if (p.archived || p.is_custom) continue;
    const st = stockState(p.stock, p.low_at);
    if (st === "untracked") { untracked += 1; continue; }
    const have = dec(p.stock);
    const v = have > 0n && p.price ? toMinor(mulDec(have, dec(p.price))) : 0n;
    value += v;
    if (st === "out") out += 1; else if (st === "low") low += 1;
    rows.push({ id: p.variant_id, name: p.name, sku: p.sku, unit: p.unit_label, stock: decToString(have), state: st, valueMinor: v });
  }
  const rank = { out: 0, low: 1, ok: 2 } as const;
  rows.sort((a, z) => rank[a.state] - rank[z.state] || a.name.localeCompare(z.name));
  return { tracked: rows.length, untracked, out, low, valueMinor: value, rows };
}
