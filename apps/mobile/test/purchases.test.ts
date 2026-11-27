import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, NetworkError, type Api } from "../src/api/client";
import {
  addSupplierPayment, billMinor, canDeletePurchase, createSupplier, deletePurchase, getPurchase, listPurchases, paymentsForSupplier, purchasesForSupplier, reapplyPendingPurchaseStock,
  retryPurchase, savePurchase, suppliersWithOwed, totalOwed, type PurchaseLine,
} from "../src/db/purchases";
import { createItem, mapSet, type Org } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import { pushPurchases, pushSuppliers } from "../src/sync/purchases";
import { memoryDb } from "./nodedb";

const org: Org = { organisationId: "o", legalEntityId: "le", legalName: "Demo", country: "IN", currency: "INR", gstStateCode: "20", branchId: "b", warehouseId: "w", priceListId: "p", walkInPartyId: "walk" };
const NOW = Date.UTC(2026, 10, 27, 10);

/** A stand-in for the purchases and payments API that behaves like the real one where it matters: client_ref returns what already exists,
 *  lines only on drafts, finalize once. `crashAt` simulates the connection dying AFTER the server did the work. */
class PurchaseServer {
  docs = new Map<string, { ID: string; Status: string; DocumentNumber: string; ref: string; supplier: string; lines: { q: string; price: string }[] }>();
  payments = new Map<string, { ID: string; ref: string; party: string; doc?: string; amount: string }>();
  parties: { ID: string; LegalName: string; PartyType: string; Phone?: string }[] = [];
  crashAt: string | null = null;
  reject: { path: RegExp; status: number; message: string } | null = null;
  finalizeCount = 0;
  calls: string[] = [];
  private crash(step: string) { if (this.crashAt === step) { this.crashAt = null; throw new NetworkError(); } }

  async get<T>(path: string): Promise<T> {
    this.calls.push(`GET ${path}`);
    let m = /^\/purchases\/documents\/([^/]+)$/.exec(path);
    if (m) { const d = this.docs.get(m[1]!)!; return { document: { ID: d.ID, Status: d.Status, DocumentNumber: d.DocumentNumber }, lines: d.lines.map((_, i) => ({ ID: `l${i}` })) } as T; }
    m = /^\/contacts\/parties\?q=(.*)$/.exec(path);
    if (m) { const q = decodeURIComponent(m[1]!).toLowerCase(); return { parties: this.parties.filter((p) => p.LegalName.toLowerCase().includes(q) || (p.Phone ?? "").includes(q)) } as T; }
    throw new Error(`fake: unhandled GET ${path}`);
  }
  async post<T>(path: string, body?: unknown): Promise<T> {
    this.calls.push(`POST ${path}`);
    if (this.reject?.path.test(path)) throw new ApiError(this.reject.status, "REFUSED", this.reject.message);
    const b = (body ?? {}) as Record<string, string>;
    if (path === "/purchases/documents") {
      let d = [...this.docs.values()].find((x) => x.ref === b.client_ref);
      if (!d) { d = { ID: `pd-${this.docs.size + 1}`, Status: "DRAFT", DocumentNumber: `PINV-00000${this.docs.size + 1}`, ref: b.client_ref!, supplier: b.supplier_party_id!, lines: [] }; this.docs.set(d.ID, d); }
      this.crash("create");
      return { ID: d.ID } as T;
    }
    let m = /^\/purchases\/documents\/([^/]+)\/lines$/.exec(path);
    if (m) { const d = this.docs.get(m[1]!)!; if (d.Status !== "DRAFT") throw new ApiError(409, "DOCUMENT_NOT_DRAFT", "not a draft"); d.lines.push({ q: b.quantity!, price: b.unit_price! }); this.crash(`line${d.lines.length}`); return {} as T; }
    m = /^\/purchases\/documents\/([^/]+)\/finalize$/.exec(path);
    if (m) { const d = this.docs.get(m[1]!)!; if (d.Status !== "DRAFT") throw new ApiError(409, "DOCUMENT_NOT_DRAFT", "not a draft"); d.Status = "FINALIZED"; this.finalizeCount++; this.crash("finalize"); return {} as T; }
    if (path === "/accounting/payments") {
      let p = [...this.payments.values()].find((x) => x.ref === b.client_ref);
      if (!p) { p = { ID: `pay-${this.payments.size + 1}`, ref: b.client_ref!, party: b.party_id!, doc: b.purchase_document_id, amount: b.amount! }; this.payments.set(p.ID, p); }
      this.crash("payment");
      return { ID: p.ID } as T;
    }
    if (path === "/contacts/parties") { const p = { ID: `srv-${this.parties.length + 1}`, LegalName: b.legal_name!, PartyType: b.party_type!, Phone: b.phone }; this.parties.push(p); return p as T; }
    if (/^\/contacts\/parties\/[^/]+\/tax-registrations$/.test(path)) return {} as T;
    throw new Error(`fake: unhandled POST ${path}`);
  }
}
const asApi = (s: PurchaseServer): Api => s as unknown as Api;

const lines: PurchaseLine[] = [
  { variantId: "v1", unitId: "u", name: "Bolt", qty: "10", cost: "12.50" },
  { variantId: "v2", unitId: "u", name: "Wire", qty: "2.5", cost: "400" },
];

async function setup() {
  const db = memoryDb(); await migrate(db);
  await db.run("INSERT INTO products(variant_id,product_id,name,unit_id,price,stock,origin,pushed) VALUES('v1','p1','Bolt','u','20','5','server',1),('v2','p2','Wire','u','500','1','server',1)");
  await db.run("INSERT INTO suppliers(id,name,phone) VALUES('sup-1','Metro Traders','')");
  return db;
}
const stock = async (db: Awaited<ReturnType<typeof setup>>, v: string) => (await db.first<{ stock: string }>("SELECT stock FROM products WHERE variant_id=?", [v]))!.stock;

test("the bill total is the sum of each line rounded to paise", () => {
  assert.equal(billMinor(lines), 12500n + 100000n);
  assert.equal(billMinor([{ qty: "3", cost: "0.335" }]), 101n);   // 1.005 -> 1.01, rounded half up once
});

test("saving a bill puts the goods on the shelf at once and records the amount paid with it", async () => {
  const db = await setup();
  await savePurchase(db, { id: "b1", supplierId: "sup-1", billNo: "MT/114", billDate: NOW, note: "", lines, paid: { amount: "500", method: "CASH" } }, NOW);
  assert.equal(await stock(db, "v1"), "15"); assert.equal(await stock(db, "v2"), "3.5");
  const b = (await listPurchases(db))[0]!;
  assert.equal(b.total, "1125.00"); assert.equal(b.state, "pending");
  assert.deepEqual((await paymentsForSupplier(db, "sup-1")).map((p) => [p.amount, p.purchase_id, p.state]), [["500.00", "b1", "pending"]]);
  await assert.rejects(() => savePurchase(db, { id: "b2", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines, paid: { amount: "1125.01", method: "CASH" } }, NOW), /more than the bill total/);
  await assert.rejects(() => savePurchase(db, { id: "b3", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines: [], paid: null }, NOW), /at least one item/);
  assert.equal(await stock(db, "v1"), "15", "a refused bill must not touch stock");
});

for (const step of ["create", "line1", "line2", "finalize", "payment"]) {
  test(`a connection that dies right after the server did "${step}" never duplicates the bill, its lines or the payment`, async () => {
    const db = await setup(); const srv = new PurchaseServer();
    await savePurchase(db, { id: "b1", supplierId: "sup-1", billNo: "MT/114", billDate: NOW, note: "", lines, paid: { amount: "500", method: "UPI" } }, NOW);
    srv.crashAt = step;
    await assert.rejects(() => pushPurchases(asApi(srv), db, org), NetworkError);
    // The bill finishes before its payment starts, so a crash during the payment leaves the bill done and only the payment waiting.
    assert.equal((await getPurchase(db, "b1"))!.state, step === "payment" ? "synced" : "pending", "waiting after the crash");
    const r = await pushPurchases(asApi(srv), db, org);                       // the retry
    assert.equal(srv.docs.size, 1, "one draft only");
    const d = [...srv.docs.values()][0]!;
    assert.equal(d.lines.length, 2, "each line once"); assert.equal(d.Status, "FINALIZED"); assert.equal(srv.finalizeCount, 1);
    assert.equal(srv.payments.size, 1, "the money booked once");
    assert.equal([...srv.payments.values()][0]!.doc, d.ID, "the payment is against this bill");
    assert.equal((await getPurchase(db, "b1"))!.state, "synced"); assert.equal((await getPurchase(db, "b1"))!.doc_number, d.DocumentNumber);
    assert.equal((await paymentsForSupplier(db, "sup-1"))[0]!.state, "synced");
    assert.ok(r.posted >= 1);
    const again = await pushPurchases(asApi(srv), db, org);                   // nothing left to send
    assert.deepEqual(again, { posted: 0, failed: 0, waiting: 0 });
    assert.equal(srv.docs.size, 1); assert.equal(srv.payments.size, 1);
  });
}

test("a payment made with the bill waits until the bill is on the server, and a later payment goes straight up", async () => {
  const db = await setup(); const srv = new PurchaseServer();
  await savePurchase(db, { id: "b1", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines, paid: { amount: "100", method: "CASH" } }, NOW);
  await db.run("UPDATE purchases SET state='failed' WHERE id='b1'");          // the bill is stuck: its payment must not run ahead of it
  await addSupplierPayment(db, { id: "p-extra", supplierId: "sup-1", amount: "250.00", method: "UPI", note: "advance", paidAt: NOW }, NOW);
  const r = await pushPurchases(asApi(srv), db, org);
  assert.deepEqual(r, { posted: 1, failed: 0, waiting: 1 });
  assert.equal(srv.payments.size, 1); assert.equal([...srv.payments.values()][0]!.doc, undefined, "the standalone payment is not tied to a bill");
  await retryPurchase(db, "b1");
  assert.deepEqual(await pushPurchases(asApi(srv), db, org), { posted: 2, failed: 0, waiting: 0 });
  assert.equal(srv.payments.size, 2);
});

test("a refused bill is marked failed with the server's words, nothing else is blocked, and it can be tried again", async () => {
  const db = await setup(); const srv = new PurchaseServer();
  await savePurchase(db, { id: "b1", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines, paid: null }, NOW);
  srv.reject = { path: /\/finalize$/, status: 400, message: "This purchase can't be taxed yet." };
  const r = await pushPurchases(asApi(srv), db, org);
  assert.equal(r.failed, 1);
  const b = (await getPurchase(db, "b1"))!;
  assert.equal(b.state, "failed"); assert.match(b.error!, /can't be taxed/);
  assert.equal(canDeletePurchase(b), false, "a draft already exists on the server, so the bill can't just vanish from the phone");
  srv.reject = null; await retryPurchase(db, "b1");
  assert.equal((await pushPurchases(asApi(srv), db, org)).posted, 1);
  assert.equal(srv.docs.size, 1, "the retry reused the draft");
});

test("a bill for a supplier or item made on the phone waits for them, then uses their server ids", async () => {
  const db = await setup(); const srv = new PurchaseServer();
  await createSupplier(db, "sup-local", { name: "New Agency", phone: "9000000001", gstin: "" }, NOW);
  await createItem(db, "item-local", { name: "Gasket", sku: "G1", barcode: "", hsn: "", price: "10", gstRate: "", stock: "0", unitLabel: "pcs" }, NOW);
  await savePurchase(db, { id: "b1", supplierId: "sup-local", billNo: "", billDate: NOW, note: "", lines: [{ variantId: "item-local", unitId: "", name: "Gasket", qty: "4", cost: "7" }], paid: { amount: "28", method: "CASH" } }, NOW);
  assert.deepEqual(await pushPurchases(asApi(srv), db, org), { posted: 0, failed: 0, waiting: 2 }, "bill and payment both wait");
  assert.equal(srv.docs.size, 0);
  await pushSuppliers(asApi(srv), db, org);
  assert.equal(srv.parties[0]!.PartyType, "SUPPLIER");
  assert.equal((await purchasesForSupplier(db, "srv-1")).length, 1, "the bill now points at the supplier's server id");
  assert.equal((await paymentsForSupplier(db, "srv-1")).length, 1);
  assert.equal((await pushPurchases(asApi(srv), db, org)).waiting, 2, "the supplier is up but the item still isn't");
  await mapSet(db, "item", "item-local", "srv-variant", { productId: "x", unitId: "srv-unit" });
  assert.deepEqual(await pushPurchases(asApi(srv), db, org), { posted: 2, failed: 0, waiting: 0 });
  assert.equal([...srv.docs.values()][0]!.supplier, "srv-1");
});

test("uploading a supplier that already exists on the server reuses it instead of making a twin", async () => {
  const db = await setup(); const srv = new PurchaseServer();
  srv.parties.push({ ID: "existing-1", LegalName: "new agency", PartyType: "SUPPLIER" });
  await createSupplier(db, "sup-local", { name: "New Agency", phone: "", gstin: "" }, NOW);
  await pushSuppliers(asApi(srv), db, org);
  assert.equal(srv.parties.length, 1);
  await savePurchase(db, { id: "b1", supplierId: "sup-local", billNo: "", billDate: NOW, note: "", lines: [lines[0]!], paid: null }, NOW);
  assert.equal((await purchasesForSupplier(db, "existing-1")).length, 1);
});

test("what is owed counts the server's figure plus bills not yet uploaded, minus payments not yet uploaded, and never twice", async () => {
  const db = await setup(); const srv = new PurchaseServer();
  await db.run("INSERT INTO supplier_balances(party_id,name,owed) VALUES('sup-1','Metro Traders','2000.00')");
  assert.equal((await suppliersWithOwed(db))[0]!.owed, 200000n);
  await savePurchase(db, { id: "b1", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines, paid: { amount: "125", method: "CASH" } }, NOW);
  const mid = (await suppliersWithOwed(db))[0]!;
  assert.equal(mid.owed, 200000n + 112500n - 12500n); assert.equal(mid.waiting, true);
  await pushPurchases(asApi(srv), db, org);                                 // uploaded: the next pull will carry them in the server's figure
  const after = (await suppliersWithOwed(db))[0]!;
  assert.equal(after.owed, 200000n, "uploaded work is not added on top of the server figure");
  assert.equal(totalOwed([{ owed: 500n }, { owed: -200n }, { owed: 100n }]), 600n, "an overpaid supplier does not reduce what is owed to others");
});

test("deleting a bill that never reached the server takes the goods and its payment back; one that has a draft there cannot be deleted", async () => {
  const db = await setup();
  await savePurchase(db, { id: "b1", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines, paid: { amount: "10", method: "CASH" } }, NOW);
  await deletePurchase(db, "b1");
  assert.equal(await stock(db, "v1"), "5"); assert.equal(await stock(db, "v2"), "1");
  assert.equal((await listPurchases(db)).length, 0); assert.equal((await paymentsForSupplier(db, "sup-1")).length, 0);
  await savePurchase(db, { id: "b2", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines, paid: null }, NOW);
  await db.run("UPDATE purchases SET progress='{\"docId\":\"pd-1\"}' WHERE id='b2'");
  await assert.rejects(() => deletePurchase(db, "b2"), /already started uploading/);
});

test("after a pull replaces stock with the server's figure, bills the server hasn't received are added back", async () => {
  const db = await setup();
  await savePurchase(db, { id: "b1", supplierId: "sup-1", billNo: "", billDate: NOW, note: "", lines, paid: null }, NOW);
  await db.run("UPDATE products SET stock='5' WHERE variant_id='v1'");        // what a pull does: the server's number, without the bill
  await reapplyPendingPurchaseStock(db);
  assert.equal(await stock(db, "v1"), "15");
  await db.run("UPDATE purchases SET progress='{\"docId\":\"pd-1\",\"finalized\":true}' WHERE id='b1'");
  await db.run("UPDATE products SET stock='15' WHERE variant_id='v1'");        // the server already counted it
  await reapplyPendingPurchaseStock(db);
  assert.equal(await stock(db, "v1"), "15", "not counted twice");
});
