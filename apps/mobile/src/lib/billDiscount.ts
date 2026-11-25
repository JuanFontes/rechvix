import { dec, minorToString, toMinor } from "./decimal";
import { calcInvoice, type PricingMode, type TaxLineIn } from "./tax";

/** A discount on the whole bill, typed once instead of on every item. It is spread over the items in proportion to what each costs, and
 *  stored as ordinary per-item discounts, so GST is worked out on the discounted amounts exactly as for any item discount, the invoice
 *  prints the same way, and the server receives nothing it does not already understand. */
export interface BillDiscount { kind: "amount" | "percent"; text: string }

export type BillDiscountResult =
  | { ok: true; discounts: string[]; totalMinor: bigint }
  | { ok: false; error: string };

/** Spreads `spec` over the lines. The pieces add up to exactly the discount (largest remainder, so no paisa is lost or invented), and no
 *  item is ever discounted below zero. `lines` carry their own item discounts already; the bill discount comes on top of them. */
export function allocateBillDiscount(lines: TaxLineIn[], mode: PricingMode, spec: BillDiscount | null | undefined): BillDiscountResult {
  const base = lines.map((l) => l.discount || "0");
  const text = (spec?.text ?? "").trim();
  if (!spec || text === "" || /^0*\.?0*$/.test(text)) return { ok: true, discounts: base, totalMinor: 0n };
  if (!/^\d*\.?\d+$|^\d+\.?$/.test(text)) return { ok: false, error: "Type the discount as a number." };
  const calc = calcInvoice(lines, mode, false);
  if (calc.lines.some((l) => l.invalid)) return { ok: false, error: "Fix the item amounts first." };
  const gross = calc.lines.map((l) => l.grossMinor);
  const total = gross.reduce((a, b) => a + b, 0n);
  if (total <= 0n) return { ok: false, error: "Add priced items before a discount." };

  let want: bigint;
  if (spec.kind === "percent") {
    if (Number(text) > 100) return { ok: false, error: "A percentage discount can't be more than 100%." };
    // total x pct / 100, rounded half up, in minor units (pct has at most 2 decimals worth keeping)
    const bp = BigInt(Math.round(Number(text) * 100));            // basis points: 12.5% -> 1250
    want = (total * bp + 5000n) / 10000n;
  } else {
    want = toMinor(dec(text));
  }
  if (want <= 0n) return { ok: true, discounts: base, totalMinor: 0n };
  if (want > total) return { ok: false, error: "The discount can't be more than the bill." };

  // Floor share for each line, then hand the leftover minor units to the lines with the biggest remainders.
  const share = gross.map((g) => (want * g) / total);
  const rem = gross.map((g, i) => ({ i, r: (want * g) % total }));
  let left = want - share.reduce((a, b) => a + b, 0n);
  rem.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of rem) { if (left === 0n) break; if (share[i]! < gross[i]!) { share[i]! += 1n; left -= 1n; } }
  if (left !== 0n) return { ok: false, error: "The discount could not be shared across the items." };
  const discounts = lines.map((l, i) => minorToString(toMinor(dec(l.discount || "0")) + share[i]!));
  return { ok: true, discounts, totalMinor: want };
}
