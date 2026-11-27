import { dec, minorToString, mulDec, parseMinor, toMinor } from "../lib/decimal";
import { adjustStock, mapGet } from "./repo";
import type { Db } from "./types";

/** Suppliers, supplier bills (purchases) and money paid to suppliers, all kept on the phone first and uploaded safely (see sync/purchases.ts). */

export interface Supplier { id: string; name: string; phone: string; gstin: string; origin: string; pushed: number; gen: number; created_at: number }
export interface SupplierInput { name: string; phone: string; gstin: string }

export const createSupplier = (db: Db, id: string, s: SupplierInput, now: number): Promise<void> =>
  db.run("INSERT INTO suppliers(id,name,phone,gstin,origin,pushed,gen,created_at) VALUES(?,?,?,?,?,?,?,?)", [id, s.name.trim(), s.phone.trim(), s.gstin.trim().toUpperCase(), "local", 0, 0, now]);
/** A supplier that lives on the server is edited there; one still only on this phone can be changed freely. */
export const updateSupplier = (db: Db, id: string, s: SupplierInput): Promise<void> =>
  db.run("UPDATE suppliers SET name=?, phone=?, gstin=? WHERE id=? AND origin='local' AND pushed=0", [s.name.trim(), s.phone.trim(), s.gstin.trim().toUpperCase(), id]);
export const getSupplier = (db: Db, id: string): Promise<Supplier | null> => db.first<Supplier>("SELECT * FROM suppliers WHERE id=?", [id]);
/** A supplier that has been uploaded is known by its server id from then on, even while the phone still lists its own copy. */
export async function canonicalSupplierId(db: Db, id: string): Promise<string> { return (await mapGet(db, "party", id))?.serverId ?? id; }
export const unpushedSuppliers = (db: Db): Promise<Supplier[]> => db.all<Supplier>("SELECT * FROM suppliers WHERE origin='local' AND pushed=0 ORDER BY created_at");
export const markSupplierPushed = (db: Db, id: string): Promise<void> => db.run("UPDATE suppliers SET pushed=1 WHERE id=?", [id]);

export interface PurchaseLine { variantId: string; unitId: string; name: string; qty: string; cost: string }
export interface PurchasePayload { lines: PurchaseLine[] }
export interface PurchaseProgress { docId?: string; finalized?: boolean }
export type PurchaseState = "pending" | "synced" | "failed";
interface PurchaseRow { id: string; supplier_id: string; bill_no: string; bill_date: number; note: string; payload: string; total: string; state: PurchaseState; progress: string; doc_number: string | null; error: string | null; attempts: number; created_at: number }
export interface Purchase extends Omit<PurchaseRow, "payload" | "progress"> { payload: PurchasePayload; progress: PurchaseProgress }
const parsePurchase = (r: PurchaseRow): Purchase => ({ ...r, payload: JSON.parse(r.payload) as PurchasePayload, progress: JSON.parse(r.progress) as PurchaseProgress });

/** quantity x cost for each line, rounded to whole minor units once per line, like the server. */
export const lineMinor = (l: Pick<PurchaseLine, "qty" | "cost">): bigint => toMinor(mulDec(dec(l.qty), dec(l.cost)));
export const billMinor = (lines: Pick<PurchaseLine, "qty" | "cost">[]): bigint => lines.reduce((n, l) => n + lineMinor(l), 0n);

export interface NewPurchase { id: string; supplierId: string; billNo: string; billDate: number; note: string; lines: PurchaseLine[]; paid?: { amount: string; method: string } | null }

/** Saves a bill and puts its goods on the phone's shelf in one step, so the two can never disagree. Money paid at the counter is saved with it as a
 *  supplier payment that waits for the bill to reach the server. */
export async function savePurchase(db: Db, p0: NewPurchase, now: number): Promise<void> {
  const p = { ...p0, supplierId: await canonicalSupplierId(db, p0.supplierId) };
  if (p.lines.length === 0) throw new Error("Add at least one item to the bill.");
  const total = billMinor(p.lines);
  if (total <= 0n) throw new Error("The bill total must be more than zero.");
  const paid = p.paid ? parseMinor(p.paid.amount) : 0n;
  if (paid > total) throw new Error("You can't pay more than the bill total. Record any extra as a separate payment.");
  await db.tx(async () => {
    await db.run("INSERT INTO purchases(id,supplier_id,bill_no,bill_date,note,payload,total,created_at) VALUES(?,?,?,?,?,?,?,?)",
      [p.id, p.supplierId, p.billNo.trim(), p.billDate, p.note.trim(), JSON.stringify({ lines: p.lines } satisfies PurchasePayload), minorToString(total), now]);
    for (const l of p.lines) await adjustStock(db, l.variantId, Number(l.qty));
    if (paid > 0n && p.paid) {
      await db.run("INSERT INTO supplier_payments(id,supplier_id,purchase_id,amount,method,note,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [`${p.id}:paid`, p.supplierId, p.id, minorToString(paid), p.paid.method, "Paid with the bill", p.billDate, now]);
    }
  });
}

export const listPurchases = async (db: Db, limit = 300): Promise<Purchase[]> => (await db.all<PurchaseRow>("SELECT * FROM purchases ORDER BY bill_date DESC, created_at DESC LIMIT ?", [limit])).map(parsePurchase);
export const purchasesForSupplier = async (db: Db, supplierId: string): Promise<Purchase[]> => (await db.all<PurchaseRow>("SELECT * FROM purchases WHERE supplier_id=? ORDER BY bill_date DESC, created_at DESC", [supplierId])).map(parsePurchase);
export const getPurchase = async (db: Db, id: string): Promise<Purchase | null> => { const r = await db.first<PurchaseRow>("SELECT * FROM purchases WHERE id=?", [id]); return r ? parsePurchase(r) : null; };
export const duePurchases = async (db: Db): Promise<Purchase[]> => (await db.all<PurchaseRow>("SELECT * FROM purchases WHERE state='pending' ORDER BY created_at LIMIT 100")).map(parsePurchase);
export const savePurchaseProgress = (db: Db, id: string, p: PurchaseProgress): Promise<void> => db.run("UPDATE purchases SET progress=? WHERE id=?", [JSON.stringify(p), id]);
export const markPurchaseSynced = (db: Db, id: string, docNumber: string): Promise<void> => db.run("UPDATE purchases SET state='synced', doc_number=?, error=NULL WHERE id=?", [docNumber, id]);
export const markPurchaseFailed = (db: Db, id: string, error: string, attempts: number): Promise<void> => db.run("UPDATE purchases SET state='failed', error=?, attempts=? WHERE id=?", [error, attempts, id]);
export const notePurchaseAttempt = (db: Db, id: string, error: string, attempts: number): Promise<void> => db.run("UPDATE purchases SET error=?, attempts=? WHERE id=?", [error, attempts, id]);
export const retryPurchase = (db: Db, id: string): Promise<void> => db.run("UPDATE purchases SET state='pending', error=NULL, attempts=0 WHERE id=? AND state='failed'", [id]);

/** A bill can be removed only while the server has never heard of it (no draft made there). The goods come back off the shelf and any "paid with the bill" amount goes too. */
export const canDeletePurchase = (p: Pick<Purchase, "state" | "progress">): boolean => p.state !== "synced" && !p.progress.docId;
export async function deletePurchase(db: Db, id: string): Promise<void> {
  await db.tx(async () => {
    const p = await getPurchase(db, id);
    if (!p) return;
    if (!canDeletePurchase(p)) throw new Error("This bill has already started uploading, so it can't be deleted from the phone.");
    for (const l of p.payload.lines) await adjustStock(db, l.variantId, -Number(l.qty));
    await db.run("DELETE FROM supplier_payments WHERE purchase_id=? AND state<>'synced'", [id]);
    await db.run("DELETE FROM purchases WHERE id=?", [id]);
  });
}

/** After a pull replaced stock with the server's figures, put back the goods of bills the server hasn't received yet, so the shelf never shows less than was bought. */
export async function reapplyPendingPurchaseStock(db: Db): Promise<void> {
  for (const p of await duePurchases(db)) {
    if (p.progress.finalized) continue;   // the server already counted it, and the pull included it
    for (const l of p.payload.lines) {
      const m = await mapGet(db, "item", l.variantId);
      await adjustStock(db, m?.serverId ?? l.variantId, Number(l.qty), true);
    }
  }
}

// ---------------------------------------------------------------- money paid to suppliers
export type SupplierPaymentState = "pending" | "synced" | "failed";
export interface SupplierPayment { id: string; supplier_id: string; purchase_id: string | null; amount: string; method: string; note: string; paid_at: number; state: SupplierPaymentState; server_payment_id: string | null; error: string | null; attempts: number; created_at: number }
export const addSupplierPayment = async (db: Db, p: { id: string; supplierId: string; amount: string; method: string; note: string; paidAt: number }, now: number): Promise<void> =>
  db.run("INSERT INTO supplier_payments(id,supplier_id,purchase_id,amount,method,note,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?)", [p.id, await canonicalSupplierId(db, p.supplierId), null, p.amount, p.method, p.note.trim(), p.paidAt, now]);
export const paymentsForSupplier = (db: Db, supplierId: string): Promise<SupplierPayment[]> => db.all<SupplierPayment>("SELECT * FROM supplier_payments WHERE supplier_id=? ORDER BY paid_at DESC, created_at DESC", [supplierId]);
export const pendingSupplierPayments = (db: Db): Promise<SupplierPayment[]> => db.all<SupplierPayment>("SELECT * FROM supplier_payments WHERE state='pending' ORDER BY paid_at, created_at LIMIT 200");
export const markSupplierPaymentPosted = (db: Db, id: string, serverId: string): Promise<void> => db.run("UPDATE supplier_payments SET state='synced', server_payment_id=?, error=NULL WHERE id=?", [serverId, id]);
export const markSupplierPaymentFailed = (db: Db, id: string, error: string, attempts: number): Promise<void> => db.run("UPDATE supplier_payments SET state='failed', error=?, attempts=? WHERE id=?", [error, attempts, id]);
export const retrySupplierPayment = (db: Db, id: string): Promise<void> => db.run("UPDATE supplier_payments SET state='pending', error=NULL, attempts=0 WHERE id=? AND state='failed'", [id]);
/** Only a payment the server has not booked can be removed; once booked it is corrected on the web. */
export const deleteUnsyncedSupplierPayment = (db: Db, id: string): Promise<void> => db.run("DELETE FROM supplier_payments WHERE id=? AND state<>'synced' AND purchase_id IS NULL", [id]);

// ---------------------------------------------------------------- what the business owes
export interface SupplierRow extends Supplier { owed: bigint; waiting: boolean }

/** Owed to a supplier = what the server says + bills not yet on the server - payments not yet on the server. The server's figure already includes
 *  everything it has seen (made on the web or another phone too), so only the phone's not-yet-uploaded part is added. */
export async function suppliersWithOwed(db: Db, q = "", limit = 300): Promise<SupplierRow[]> {
  const like = `%${q.trim().replace(/[%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db.all<Supplier & { server_owed: string | null }>(
    `SELECT s.*, (SELECT owed FROM supplier_balances b WHERE b.party_id = s.id) AS server_owed FROM suppliers s
     WHERE s.name LIKE ? ESCAPE '\\' OR s.phone LIKE ? ESCAPE '\\' ORDER BY s.name COLLATE NOCASE LIMIT ?`, [like, like, limit]);
  const bills = await db.all<PurchaseRow>("SELECT * FROM purchases WHERE state<>'synced'");
  const pays = await db.all<SupplierPayment>("SELECT * FROM supplier_payments WHERE state<>'synced'");
  return rows.map(({ server_owed, ...s }) => {
    const myBills = bills.filter((b) => b.supplier_id === s.id && !(JSON.parse(b.progress) as PurchaseProgress).finalized);
    const myPays = pays.filter((p) => p.supplier_id === s.id);
    let owed = server_owed ? parseMinor(server_owed) : 0n;
    for (const b of myBills) owed += parseMinor(b.total);
    for (const p of myPays) owed -= parseMinor(p.amount);
    return { ...s, owed, waiting: myBills.length > 0 || myPays.length > 0 };
  });
}
export const totalOwed = (rows: { owed: bigint }[]): bigint => rows.reduce((n, r) => n + (r.owed > 0n ? r.owed : 0n), 0n);
