/** Opt-in end-to-end test of supplier bills against a real Rechvix server (the same sync code the phone runs).
 *    RECHVIX_URL=http://localhost:8099 RECHVIX_EMAIL=... RECHVIX_PASSWORD=... npx tsx --test test/live-purchases.test.ts */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Api } from "../src/api/client";
import { createSupplier, getPurchase, paymentsForSupplier, savePurchase, suppliersWithOwed } from "../src/db/purchases";
import { createItem, getOrg, searchProducts } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import { SyncEngine } from "../src/sync/engine";
import { memoryDb } from "./nodedb";

const URL = process.env.RECHVIX_URL, EMAIL = process.env.RECHVIX_EMAIL, PASSWORD = process.env.RECHVIX_PASSWORD;

test("live: a supplier bill uploads once, adds stock, creates what is owed, and a repeat creates nothing new", { skip: !URL }, async () => {
  let cookie: string | null = null;
  const api = new Api({ baseUrl: () => URL!, cookie: () => cookie, onCookie: (c) => (cookie = c), onUnauthorized: () => {} });
  await api.post("/auth/login", { email: EMAIL, password: PASSWORD, mfa_code: "" });
  const db = memoryDb(); await migrate(db);
  const eng = new SyncEngine(api, db);
  assert.equal((await eng.syncNow()).pulled, true);
  const org = (await getOrg(db))!;
  const items = (await searchProducts(db, "")).filter((p) => p.stock != null).slice(0, 2);
  assert.equal(items.length, 2);
  const before = items.map((p) => Number(p.stock));

  const stamp = Date.now();
  const BILL = `bill-${stamp}`;
  await createSupplier(db, `sup-${stamp}`, { name: `Live Supplier ${stamp}`, phone: "", gstin: "" }, stamp);
  await createItem(db, `item-${stamp}`, { name: `Live Item ${stamp}`, sku: `LIVE-${stamp}`, barcode: "", hsn: "", price: "50", gstRate: "", stock: "0", unitLabel: "pcs" }, stamp);
  await savePurchase(db, {
    id: BILL, supplierId: `sup-${stamp}`, billNo: `LS/${stamp}`, billDate: stamp, note: "live test",
    lines: [
      { variantId: items[0]!.variant_id, unitId: items[0]!.unit_id, name: items[0]!.name, qty: "10", cost: "100" },
      { variantId: items[1]!.variant_id, unitId: items[1]!.unit_id, name: items[1]!.name, qty: "2.5", cost: "200" },
      { variantId: `item-${stamp}`, unitId: "", name: "Live Item", qty: "4", cost: "25" },
    ],
    paid: { amount: "600", method: "UPI" },
  }, stamp);

  const r1 = await eng.syncNow();
  assert.equal(r1.failed, 0, JSON.stringify(r1));
  const bill = (await getPurchase(db, BILL))!;
  assert.equal(bill.state, "synced", `${bill.error}`);
  assert.match(bill.doc_number!, /^PINV-/);
  const docId = bill.progress.docId!;

  const doc = await api.get<{ document: { Status: string; ClientRef: string; SupplierPartyID: string }; lines: unknown[] }>(`/purchases/documents/${docId}`);
  assert.equal(doc.document.Status, "FINALIZED"); assert.equal(doc.lines.length, 3); assert.equal(doc.document.ClientRef, `mobile:pur:${BILL}`);
  const sup = (await api.get<{ parties: { ID: string; PartyType: string }[] }>(`/contacts/parties?q=${encodeURIComponent(`Live Supplier ${stamp}`)}`)).parties.find((p) => p.PartyType === "SUPPLIER");
  assert.ok(sup, "the new supplier exists on the server as a SUPPLIER");
  assert.equal(doc.document.SupplierPartyID, sup!.ID);

  // Stock on the server went up by exactly the bought quantities (the pull in the same sync carried it back).
  const after = (await searchProducts(db, "")).filter((p) => items.some((i) => i.variant_id === p.variant_id));
  for (const [i, p] of items.entries()) assert.equal(Number(after.find((a) => a.variant_id === p.variant_id)!.stock), before[i]! + (i === 0 ? 10 : 2.5));

  // 10x100 + 2.5x200 + 4x25 = 1600; 600 paid -> owes 1000, on the phone and as the server's own figure.
  const payments = (await api.get<{ payments: { Amount: { amount: string } }[] | null }>(`/accounting/purchase-documents/${docId}/payments`)).payments;
  assert.equal(payments?.length, 1); assert.equal(Number(payments![0]!.Amount.amount), 600);
  const owed = (await suppliersWithOwed(db)).find((s) => s.name === `Live Supplier ${stamp}`)!;
  assert.equal(owed.owed, 100000n, "the phone shows 1,000.00 owed");
  const table = await api.get<{ headers: string[]; rows: string[][] }>("/reports/accounting/payables");
  const row = table.rows.find((r) => r[table.headers.indexOf("Party ID")] === sup!.ID)!;
  assert.equal(Number(row[table.headers.indexOf("Total")]), 1000, "the server's payables report agrees");

  // The worst case: the phone loses everything it knew about this bill's progress and asks again. Nothing may be duplicated.
  await db.run("UPDATE purchases SET state='pending', progress='{}', doc_number=NULL WHERE id='bill-live'");
  await db.run("UPDATE supplier_payments SET state='pending', server_payment_id=NULL");
  const r2 = await eng.syncNow();
  assert.equal(r2.failed, 0, JSON.stringify(r2));
  const bill2 = (await getPurchase(db, BILL))!;
  assert.equal(bill2.state, "synced"); assert.equal(bill2.progress.docId, docId, "the same document came back, no second draft");
  const again = (await api.get<{ payments: unknown[] | null }>(`/accounting/purchase-documents/${docId}/payments`)).payments;
  assert.equal(again?.length, 1, "the payment was not booked twice");
  assert.equal((await paymentsForSupplier(db, sup!.ID)).filter((p) => p.state === "synced").length, 1);
  const docs = (await api.get<{ documents: { ID: string }[] }>("/purchases/documents?document_type=PURCHASE_INVOICE")).documents;
  assert.equal(docs.filter((d) => d.ID === docId).length, 1);
  void org;

  // A standalone payment afterwards reduces what is owed.
  const { addSupplierPayment } = await import("../src/db/purchases");
  await addSupplierPayment(db, { id: `pay-${stamp}`, supplierId: sup!.ID, amount: "250.00", method: "CASH", note: "later", paidAt: Date.now() }, Date.now());
  assert.equal((await eng.syncNow()).failed, 0);
  const owed2 = (await suppliersWithOwed(db)).find((s) => s.id === sup!.ID)!;
  assert.equal(owed2.owed, 75000n, "750.00 owed after the later payment");
});
