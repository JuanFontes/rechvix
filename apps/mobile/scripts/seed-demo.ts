/** Seeds a running Rechvix server with a small FICTIONAL business, through the phone app's own sync code (so what ends up on the server is
 *  exactly what the app would have uploaded): customers, items with stock, invoices, partial and full payments and reminders.
 *
 *    RECHVIX_URL=http://localhost:8099 RECHVIX_EMAIL=owner@example.test RECHVIX_PASSWORD=... npx tsx scripts/seed-demo.ts
 *
 *  Run it against a throwaway server. It never touches anything but the server it is pointed at, and every name below is made up. */
import { Api } from "../src/api/client";
import { addReminder, createItem, createParty, insertPayments, insertSale, takeInvoiceNumber } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import { calcInvoice, snapshot } from "../src/lib/tax";
import { SyncEngine } from "../src/sync/engine";
import { memoryDb } from "../test/nodedb";

const URL = process.env.RECHVIX_URL, EMAIL = process.env.RECHVIX_EMAIL, PASSWORD = process.env.RECHVIX_PASSWORD;
if (!URL || !EMAIL || !PASSWORD) { console.error("Set RECHVIX_URL, RECHVIX_EMAIL and RECHVIX_PASSWORD."); process.exit(2); }

const DAY = 86_400_000;
const now = Date.now();
const ago = (days: number) => now - days * DAY;

const items = [
  { id: "cement", name: "Cement OPC 50 Kg bag", sku: "CEM-50", hsn: "2523", price: "385", gst: "18", stock: "120" },
  { id: "drill", name: "Cordless Drill 18V", sku: "DRL-18V", hsn: "8467", price: "5490", gst: "18", stock: "14" },
  { id: "led", name: "LED bulb 12W", sku: "LED-12W", hsn: "8539", price: "145", gst: "12", stock: "200" },
  { id: "pvc", name: "PVC Pipe 1 inch 3 m", sku: "PVC-1IN", hsn: "3917", price: "310", gst: "18", stock: "60" },
  { id: "gloves", name: "Safety gloves pair", sku: "GLV-01", hsn: "6116", price: "95", gst: "12", stock: "33" },
  { id: "bolt", name: "Steel bolt M8 box of 100", sku: "BLT-M8", hsn: "7318", price: "420", gst: "18", stock: "80" },
  { id: "pump", name: "Industrial centrifugal pump", sku: "PMP-IC", hsn: "8413", price: "3500", gst: "18", stock: "19" },
  { id: "seal", name: "Mechanical seal kit", sku: "SEAL-KIT", hsn: "8484", price: "850", gst: "18", stock: "40" },
];
const customers = [
  { id: "kulkarni", name: "Kulkarni Constructions", phone: "9820011111", gstin: "27AAAAA0000A1Z5" },
  { id: "sunrise", name: "Sunrise Electricals", phone: "9820022222", gstin: "" },
  { id: "deshmukh", name: "Deshmukh Traders", phone: "9820044444", gstin: "" },
  { id: "patil", name: "Patil Plumbing Works", phone: "9820055555", gstin: "" },
  { id: "gupta", name: "Gupta Engineering", phone: "9820066666", gstin: "27BBBBB1111B1Z9" },
];

// [customer, daysAgo, due in days, [[item, qty]...], payments as [daysAgo, method, fraction of the total]]
type Plan = [string, number, number, [string, string][], [number, string, number][]];
const sales: Plan[] = [
  ["kulkarni", 150, 15, [["cement", "20"], ["pvc", "6"]], [[148, "BANK_TRANSFER", 1]]],
  ["sunrise", 130, 30, [["led", "40"], ["drill", "1"]], [[110, "UPI", 1]]],
  ["gupta", 120, 15, [["pump", "2"], ["seal", "4"]], [[100, "BANK_TRANSFER", 1]]],
  ["deshmukh", 95, 30, [["bolt", "10"]], [[70, "CASH", 1]]],
  ["kulkarni", 80, 30, [["cement", "30"]], [[60, "UPI", 1]]],
  ["patil", 70, 15, [["pvc", "10"], ["gloves", "12"]], [[65, "CASH", 1]]],
  ["gupta", 62, 30, [["pump", "1"], ["bolt", "5"]], [[40, "BANK_TRANSFER", 1]]],
  ["sunrise", 55, 15, [["led", "60"]], [[35, "UPI", 1]]],
  ["kulkarni", 45, 30, [["drill", "2"], ["gloves", "10"]], [[20, "BANK_TRANSFER", 0.5]]],
  ["deshmukh", 40, 15, [["cement", "10"]], []],
  ["sunrise", 35, 15, [["pump", "1"], ["seal", "2"]], [[20, "UPI", 0.4]]],
  ["patil", 28, 15, [["pvc", "4"], ["seal", "3"]], []],
  ["gupta", 20, 30, [["bolt", "8"], ["gloves", "6"]], [[8, "CASH", 1]]],
  ["kulkarni", 12, 30, [["pump", "1"], ["seal", "2"]], [[4, "UPI", 0.5]]],
  ["sunrise", 6, 30, [["drill", "1"], ["led", "20"]], []],
  ["deshmukh", 3, 30, [["bolt", "6"]], [[1, "CASH", 1]]],
];

async function main() {
  let cookie: string | null = null;
  const api = new Api({ baseUrl: () => URL!, cookie: () => cookie, onCookie: (c) => (cookie = c), onUnauthorized: () => {} });
  await api.post("/auth/login", { email: EMAIL, password: PASSWORD, mfa_code: "" });
  const db = memoryDb(); await migrate(db);

  await createParty(db, "walk-in", { name: "Walk-in Customer", phone: "", gstin: "", address: "" }, ago(200), true);
  for (const c of customers) await createParty(db, c.id, { name: c.name, phone: c.phone, gstin: c.gstin, address: "14 Market Road, Pune 411001" }, ago(200));
  for (const i of items) await createItem(db, i.id, { name: i.name, sku: i.sku, barcode: "", hsn: i.hsn, price: i.price, gstRate: i.gst, stock: i.stock, unitLabel: "pcs", priceBasis: "INCL" }, ago(200));

  let n = 0, k = 0;
  for (const [cust, daysAgo, due, lines, pays] of sales) {
    const c = customers.find((x) => x.id === cust)!;
    const ls = lines.map(([id, qty]) => { const it = items.find((x) => x.id === id)!; return { variantId: id, name: it.name, unitId: "", qty, price: it.price, discount: "0", gstRate: it.gst, hsn: it.hsn }; });
    const calc = calcInvoice(ls.map((l) => ({ qty: l.qty, price: l.price, discount: l.discount, gstRate: l.gstRate })), "INCLUSIVE", true);
    const id = `sale-${++n}`;
    await insertSale(db, id, { customerId: cust, customerName: c.name, paymentMethod: null, lines: ls, pricingMode: "INCLUSIVE", sellerState: "27", customerState: "27", calc: snapshot(calc), dueDate: ago(daysAgo) + due * DAY }, ago(daysAgo), await takeInvoiceNumber(db, "INV-"));
    for (const [pd, method, fraction] of pays) {
      const minor = (calc.totalMinor * BigInt(Math.round(fraction * 100))) / 100n;
      const amount = `${minor / 100n}.${String(minor % 100n).padStart(2, "0")}`;
      await insertPayments(db, { groupId: `g${++k}`, partyId: cust, method, reference: "", note: "", paidAt: ago(pd), parts: [{ id: `pay${k}`, saleLocalId: id, amount }] }, ago(pd));
    }
  }
  // Two reminders, so the history path is exercised: one opened in WhatsApp with the statement, one marked as sent by hand.
  await addReminder(db, "deshmukh", ago(5), "whatsapp", { status: "share_opened", withPdf: true, outstanding: "1650.00" });
  await addReminder(db, "patil", ago(3), "manual", { status: "marked_sent", withPdf: false, outstanding: "1052.50" });

  const eng = new SyncEngine(api, db);
  for (let round = 0; round < 3; round++) {
    const r = await eng.syncNow();
    console.log(`sync ${round + 1}:`, JSON.stringify(r));
    if (!r.pushed && !r.paymentsPosted) break;
  }
  const states = await db.all<{ state: string; n: number }>("SELECT state, COUNT(*) AS n FROM sales GROUP BY state");
  console.log("sales by state:", JSON.stringify(states));
  const act = await api.get<{ activity: unknown[] }>("/reminders/activity");
  console.log("reminder history rows on the server:", act.activity.length);
}
main().catch((e) => { console.error(e); process.exit(1); });
