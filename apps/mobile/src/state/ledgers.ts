import { allCreditNotes, allPayments, listSales, type CreditNote, type Payment } from "../db/repo";
import { useLocal, useNow } from "../lib/hooks";
import { buildLedgers, type CustomerLedger } from "../lib/receivables";
import { creditsBySale } from "../lib/sale";

/** Every customer's account, rebuilt whenever local data changes. */
export function useLedgers(): CustomerLedger[] {
  const sales = useLocal((db) => listSales(db, 5000), []);
  const pays = useLocal((db) => allPayments(db), [] as Payment[]);
  const credits = useLocal((db) => allCreditNotes(db), [] as CreditNote[]);
  const now = useNow();
  return buildLedgers(sales.filter((s) => !s.cancelled), pays, now, creditsBySale(credits));
}
