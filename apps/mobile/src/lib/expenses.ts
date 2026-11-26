import { parseMinor } from "./decimal";

/** "1,250.5" -> 125050n (minor units). null for anything that is not a positive amount with at most two decimals. */
export function parseExpenseAmount(text: string): bigint | null {
  const t = text.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const minor = parseMinor(t);
  return minor > 0n ? minor : null;
}

/** What was spent in the calendar month of `now`, from the stored amounts. */
export function monthTotalMinor(rows: { at: number; amount: string }[], now: number): bigint {
  const d = new Date(now); const y = d.getFullYear(), m = d.getMonth();
  let sum = 0n;
  for (const r of rows) { const x = new Date(r.at); if (x.getFullYear() === y && x.getMonth() === m) sum += parseMinor(r.amount); }
  return sum;
}

/** The two journal lines the server needs: debit the category, credit Cash (1000) or Bank (1010). */
export function journalFor(e: { category_code: string; amount: string; method: string; note: string; category_name: string }) {
  const description = e.note.trim() || e.category_name;
  return [
    { account_code: e.category_code, debit: e.amount, credit: "0", description },
    { account_code: e.method === "BANK" ? "1010" : "1000", debit: "0", credit: e.amount, description },
  ];
}
