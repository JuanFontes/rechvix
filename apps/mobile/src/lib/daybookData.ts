import type { CreditNote, Payment, Sale } from "../db/repo";
import type { DayBookInput } from "./daybook";
import { parseMinor } from "./decimal";
import type { CustomerLedger } from "./receivables";
import { livePayments, saleTotalMinor } from "./sale";
import { statementPayments } from "./statement";

/** Turns the phone's records into day book rows. Money taken at the till (an invoice paid when made, with no payment row of its own) is
 *  money received at the invoice time, so "Money received" agrees with what customers actually paid. Reversed payments never appear. */
export function dayBookInput(sales: Sale[], payments: Payment[], credits: CreditNote[], ledgers: CustomerLedger[], names: Map<string, string>): DayBookInput {
  const saleById = new Map(sales.map((s) => [s.local_id, s]));
  const nameOf = (partyId: string) => names.get(partyId) ?? ledgers.find((l) => l.partyId === partyId)?.name ?? "Customer";
  const numberOf = (s: Sale) => s.doc_number ?? s.local_number ?? s.local_id.slice(0, 8);
  const cancelled = new Set(sales.filter((s) => s.cancelled).map((s) => s.local_id));
  const paid = livePayments(payments).filter((p) => !(p.sale_local_id && cancelled.has(p.sale_local_id)));
  const till = ledgers.flatMap((l) =>
    statementPayments(l.invoices, []).map((p, k) => {
      const inv = l.invoices.find((i) => i.number === p.invoiceNumber);
      return { id: `till:${inv?.id ?? k}`, at: p.at, party: l.name, partyId: l.partyId, amountMinor: p.amountMinor, method: "paid at sale", invoiceNumber: p.invoiceNumber, saleId: inv?.id };
    }));
  // Only the part not already covered by real payment rows counts as taken at the till.
  const listed = new Map<string, bigint>();
  for (const p of paid) if (p.sale_local_id) listed.set(p.sale_local_id, (listed.get(p.sale_local_id) ?? 0n) + parseMinor(p.amount));
  const tillOnly = till.flatMap((t) => {
    const gap = t.amountMinor - (t.saleId ? listed.get(t.saleId) ?? 0n : 0n);
    return gap > 0n ? [{ ...t, amountMinor: gap }] : [];
  });
  return {
    sales: sales.map((s) => ({ id: s.local_id, number: numberOf(s), at: s.created_at, party: s.payload.customerName, partyId: s.payload.customerId, totalMinor: saleTotalMinor(s), cancelled: !!s.cancelled })),
    payments: [
      ...paid.map((p) => ({ id: p.id, at: p.paid_at, party: nameOf(p.party_id), partyId: p.party_id, amountMinor: parseMinor(p.amount), method: p.method, invoiceNumber: p.sale_local_id ? (saleById.get(p.sale_local_id) ? numberOf(saleById.get(p.sale_local_id)!) : undefined) : undefined, saleId: p.sale_local_id ?? undefined })),
      ...tillOnly,
    ],
    credits: credits.map((c) => ({ id: c.local_id, number: c.number ?? "Credit note", at: c.created_at, party: c.payload.customerName, partyId: c.payload.customerId, totalMinor: parseMinor(c.total ?? "0"), against: saleById.get(c.sale_local_id) ? numberOf(saleById.get(c.sale_local_id)!) : undefined, saleId: c.sale_local_id })),
  };
}
