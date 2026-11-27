import { ApiError, NetworkError, type Api } from "../api/client";
import {
  duePurchases, markPurchaseFailed, markPurchaseSynced, markSupplierPaymentFailed, markSupplierPaymentPosted, markSupplierPushed, notePurchaseAttempt, pendingSupplierPayments,
  getPurchase, savePurchaseProgress, unpushedSuppliers, type Purchase, type PurchaseProgress, type Supplier,
} from "../db/purchases";
import { mapGet, mapSet, type Org } from "../db/repo";
import type { Db } from "../db/types";
import { NotReadyError, type SagaApi } from "./saga";

/** Uploads suppliers, supplier bills and payments to suppliers. Every step is safe to repeat:
 *   - a bill's draft is created with `client_ref = mobile:pur:<id>`, so a lost answer returns the same draft on retry (no stray drafts, no duplicates);
 *   - lines are added in order and the server's own line count says where to carry on;
 *   - finalizing only happens while the document is still a draft;
 *   - a payment carries `client_ref = mobile:spay:<id>`, and the server returns the payment it already booked for that reference.
 *  A payment made with a bill waits until that bill is finalized on the server. */

interface PartyRow { ID: string; LegalName: string; PartyType: string; Phone?: string }
interface DocView { document: { ID: string; Status: string; DocumentNumber: string }; lines: { ID: string }[] | null }

const isRecordProblem = (e: unknown): e is ApiError => e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 408 && e.status !== 429;
const MAX_SERVER_ERROR_ATTEMPTS = 5;

/** A 4xx for one supplier is that supplier's problem; network and auth errors stop everything. Matches by exact name (then by phone) so connecting to a business
 *  that already has the supplier merges instead of duplicating. */
export async function pushSuppliers(api: Api, db: Db, org: Org): Promise<{ done: number; problems: string[] }> {
  let n = 0;
  const problems: string[] = [];
  for (const s of await unpushedSuppliers(db)) {
    try { await pushSupplier(api, db, org, s); n++; } catch (e) {
      if (!isRecordProblem(e)) throw e;
      problems.push(`Supplier "${s.name}": ${e.message}`);
    }
  }
  return { done: n, problems };
}

async function pushSupplier(api: Api, db: Db, org: Org, s: Supplier): Promise<void> {
  if (await mapGet(db, "party", s.id)) { await markSupplierPushed(db, s.id); return; }
  const found = (await api.get<{ parties: PartyRow[] | null }>(`/contacts/parties?q=${encodeURIComponent(s.name)}`)).parties ?? [];
  let server = found.find((x) => x.LegalName.trim().toLowerCase() === s.name.trim().toLowerCase() && x.PartyType === "SUPPLIER");
  if (!server && s.phone) {
    const byPhone = (await api.get<{ parties: PartyRow[] | null }>(`/contacts/parties?q=${encodeURIComponent(s.phone)}`)).parties ?? [];
    server = byPhone.find((x) => (x.Phone ?? "") === s.phone && x.PartyType === "SUPPLIER");
  }
  if (!server) {
    server = await api.post<PartyRow>("/contacts/parties", { party_type: "SUPPLIER", legal_name: s.name, trade_name: "", phone: s.phone, email: "", currency_code: org.currency });
    if (s.gstin) {
      try { await api.post(`/contacts/parties/${server.ID}/tax-registrations`, { country_code: org.country, registration_number: s.gstin, state_code: org.country === "IN" ? s.gstin.slice(0, 2) : "", is_primary: true }); } catch { /* the supplier is saved; a bad GSTIN can be fixed on the web */ }
    }
  }
  await mapSet(db, "party", s.id, server.ID);
  // From now on the supplier is known by its server id, and the server's own copy replaces this one on the next pull; bills and payments follow it.
  await db.run("UPDATE purchases SET supplier_id=? WHERE supplier_id=?", [server.ID, s.id]);
  await db.run("UPDATE supplier_payments SET supplier_id=? WHERE supplier_id=?", [server.ID, s.id]);
  await markSupplierPushed(db, s.id);
}

/** The server id for a supplier made on the phone, or null while it hasn't been uploaded. */
export async function serverSupplierId(db: Db, id: string): Promise<string | null> {
  const m = await mapGet(db, "party", id);
  if (m) return m.serverId;
  return (await db.first("SELECT 1 FROM suppliers WHERE id=? AND origin='local'", [id])) ? null : id;
}

export interface PurchaseResolver { supplier: string; line(localVariantId: string): { variantId: string; unitId: string } | null }

export async function runPurchase(api: SagaApi, org: Org, p: Purchase, resolve: PurchaseResolver, save: (pr: PurchaseProgress) => Promise<void>): Promise<{ progress: PurchaseProgress; docNumber: string }> {
  const lines = p.payload.lines.map((l) => {
    const m = resolve.line(l.variantId);
    if (!m) throw new NotReadyError(`"${l.name}" hasn't been uploaded yet.`);
    return { ...l, variantId: m.variantId, unitId: m.unitId || l.unitId };
  });
  const pr: PurchaseProgress = { ...p.progress };
  if (!pr.docId) {
    const day = new Date(p.bill_date).toISOString();
    const created = await api.post<{ ID: string }>("/purchases/documents", {
      branch_id: org.branchId, warehouse_id: org.warehouseId, supplier_party_id: resolve.supplier, document_type: "PURCHASE_INVOICE",
      ...(p.bill_no ? { supplier_invoice_number: p.bill_no, supplier_invoice_date: day } : {}),
      document_date: day, currency_code: org.currency, notes: p.note, client_ref: `mobile:pur:${p.id}`,
    });
    pr.docId = created.ID;
    await save(pr);
  }
  let view = await api.get<DocView>(`/purchases/documents/${pr.docId}`);
  if (view.document.Status === "DRAFT") {
    for (let i = view.lines?.length ?? 0; i < lines.length; i++) {
      const l = lines[i]!;
      await api.post(`/purchases/documents/${pr.docId}/lines`, { product_variant_id: l.variantId, unit_id: l.unitId, quantity: l.qty, unit_price: l.cost });
    }
    await api.post(`/purchases/documents/${pr.docId}/finalize`);
    pr.finalized = true;
    await save(pr);
    view = await api.get<DocView>(`/purchases/documents/${pr.docId}`);
  } else pr.finalized = true;
  return { progress: pr, docNumber: view.document.DocumentNumber };
}

async function resolver(db: Db, p: Purchase): Promise<PurchaseResolver> {
  const supplier = await serverSupplierId(db, p.supplier_id);
  if (!supplier) throw new NotReadyError("The supplier hasn't been uploaded yet.");
  const items = new Map<string, { variantId: string; unitId: string }>();
  const localItems = new Set((await db.all<{ variant_id: string }>("SELECT variant_id FROM products WHERE origin='local'")).map((r) => r.variant_id));
  for (const l of p.payload.lines) {
    const m = await mapGet(db, "item", l.variantId);
    if (m) items.set(l.variantId, { variantId: m.serverId, unitId: m.extra.unitId });
  }
  return { supplier, line: (id) => items.get(id) ?? (localItems.has(id) ? null : { variantId: id, unitId: "" }) };
}

export interface PurchaseSyncResult { posted: number; failed: number; waiting: number }

/** Bills first (oldest first), then payments. Throws on network/auth problems so the engine can stop and report. */
export async function pushPurchases(api: Api, db: Db, org: Org): Promise<PurchaseSyncResult> {
  const out: PurchaseSyncResult = { posted: 0, failed: 0, waiting: 0 };
  for (const p of await duePurchases(db)) {
    try {
      const r = await runPurchase(api, org, p, await resolver(db, p), (pr) => savePurchaseProgress(db, p.id, pr));
      await savePurchaseProgress(db, p.id, r.progress);
      await markPurchaseSynced(db, p.id, r.docNumber);
      out.posted++;
    } catch (e) {
      if (e instanceof NotReadyError) { out.waiting++; await notePurchaseAttempt(db, p.id, e.message, p.attempts); continue; }
      if (e instanceof NetworkError || (e instanceof ApiError && e.status === 401)) throw e;
      const msg = e instanceof Error ? e.message : "Server error";
      if (isRecordProblem(e) || p.attempts + 1 >= MAX_SERVER_ERROR_ATTEMPTS) { await markPurchaseFailed(db, p.id, msg, p.attempts + 1); out.failed++; }
      else { await notePurchaseAttempt(db, p.id, msg, p.attempts + 1); throw e; }
    }
  }
  for (const pay of await pendingSupplierPayments(db)) {
    let docId: string | null = null;
    if (pay.purchase_id) {
      const bill = await getPurchase(db, pay.purchase_id);
      if (!bill || !bill.progress.finalized || !bill.progress.docId) { out.waiting++; continue; }
      docId = bill.progress.docId;
    }
    const supplier = await serverSupplierId(db, pay.supplier_id);
    if (!supplier) { out.waiting++; continue; }
    try {
      const rec = await api.post<{ ID: string }>("/accounting/payments", {
        party_id: supplier, ...(docId ? { purchase_document_id: docId } : {}), amount: pay.amount, method: pay.method,
        ...(pay.note ? { reference_number: pay.note.slice(0, 80) } : {}), paid_at: new Date(pay.paid_at).toISOString(), client_ref: `mobile:spay:${pay.id}`,
      });
      await markSupplierPaymentPosted(db, pay.id, rec.ID);
      out.posted++;
    } catch (e) {
      if (e instanceof NetworkError || (e instanceof ApiError && e.status === 401)) throw e;
      const msg = e instanceof Error ? e.message : "Server error";
      if (isRecordProblem(e) || pay.attempts + 1 >= MAX_SERVER_ERROR_ATTEMPTS) { await markSupplierPaymentFailed(db, pay.id, msg, pay.attempts + 1); out.failed++; }
      else { await db.run("UPDATE supplier_payments SET attempts=attempts+1, error=? WHERE id=?", [msg, pay.id]); throw e; }
    }
  }
  return out;
}
