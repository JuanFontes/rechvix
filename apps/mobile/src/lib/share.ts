import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { buildBackup } from "./backup";
import { creditNotesForSale, getCreditNote, getOrg, getParty, getQuote, getSale, paymentsForSale, type Profile } from "../db/repo";
import type { Db } from "../db/types";
import { invoiceHtml, invoiceTitle, paperFor, paymentSummary, type InvoiceData, type InvoiceTemplate } from "./invoice";
import { parseMinor } from "./decimal";
import { statementHtml, type StatementInput } from "./statement";
import { creditsBySale, livePayments, payloadCalc, salePaidMinor, saleTotalMinor } from "./sale";

/** Everything an invoice needs, drawn from the stored sale (never recomputed), so a shared PDF matches what was issued. */
export async function buildInvoiceData(db: Db, localId: string, business: Profile, currency: string): Promise<InvoiceData | null> {
  const s = await getSale(db, localId);
  if (!s) return null;
  const party = await getParty(db, s.payload.customerId);
  const ps = await paymentsForSale(db, localId);
  const total = saleTotalMinor(s);
  const registered = !!(await getOrg(db))?.gstStateCode;
  const notes = (await creditNotesForSale(db, localId)).filter((n) => n.state === "issued");
  const credited = creditsBySale(notes).get(localId) ?? 0n;
  return {
    number: s.doc_number ?? s.local_number ?? localId.slice(0, 8), date: s.created_at, business, gstRegistered: registered,
    customerName: s.payload.customerName, customerGstin: party?.gstin || undefined, customerPhone: party?.phone || undefined,
    placeOfSupply: s.payload.customerState ? `State code ${s.payload.customerState}` : undefined,
    lines: s.payload.lines, calc: payloadCalc(s.payload), currency, payment: paymentSummary(total, salePaidMinor(s, ps), credited),
    credits: notes.map((n) => ({ number: n.number ?? "", totalMinor: parseMinor(n.total) })),
    payments: livePayments(ps).map((p) => ({ at: p.paid_at, amountMinor: parseMinor(p.amount), method: p.method, reference: p.reference || undefined })),
    cancelled: !!s.cancelled, corrects: s.payload.corrects ?? null, note: s.payload.note,
  };
}

/** A quotation drawn with the invoice designs: same figures as saved, no payment block, never counted as a sale. */
export async function buildQuoteData(db: Db, quoteId: string, business: Profile, currency: string): Promise<InvoiceData | null> {
  const q = await getQuote(db, quoteId);
  if (!q) return null;
  const party = await getParty(db, q.payload.customerId);
  const total = parseMinor(q.total);
  return {
    number: q.number, date: q.created_at, business, kind: "quotation", validUntil: q.valid_until,
    customerName: q.payload.customerName, customerGstin: party?.gstin || undefined, customerPhone: party?.phone || undefined,
    placeOfSupply: q.payload.customerState ? `State code ${q.payload.customerState}` : undefined,
    lines: q.payload.lines, calc: payloadCalc(q.payload), currency, payment: paymentSummary(total, 0n), note: q.payload.note,
  };
}

/** A credit note: the returned lines at the prices of the original invoice, as issued by the server. */
export async function buildCreditData(db: Db, creditId: string, business: Profile, currency: string): Promise<InvoiceData | null> {
  const n = await getCreditNote(db, creditId);
  if (!n) return null;
  const sale = await getSale(db, n.sale_local_id);
  const party = await getParty(db, n.payload.customerId);
  return {
    number: n.number ?? "Credit note", date: n.created_at, business, kind: "credit", against: sale?.doc_number ?? sale?.local_number ?? undefined,
    customerName: n.payload.customerName, customerGstin: party?.gstin || undefined, customerPhone: party?.phone || undefined,
    placeOfSupply: n.payload.customerState ? `State code ${n.payload.customerState}` : undefined,
    lines: n.payload.lines, calc: payloadCalc(n.payload), currency, payment: paymentSummary(0n, 0n), note: n.reason ? `Reason: ${n.reason}` : undefined,
  };
}

/** A delivery note for an invoice: the same items and quantities, no prices. Printing it changes nothing (no stock, no balance). */
export async function shareDeliveryNote(db: Db, localId: string, business: Profile, currency: string): Promise<void> {
  const d = await buildInvoiceData(db, localId, business, currency);
  if (d) await shareInvoice({ ...d, kind: "delivery", payments: undefined, credits: undefined, number: d.number }, "classic");
}

export async function shareQuote(db: Db, quoteId: string, business: Profile, currency: string, template?: InvoiceTemplate): Promise<void> {
  const d = await buildQuoteData(db, quoteId, business, currency);
  if (d) await shareInvoice(d, template ?? business.invoiceTemplate);
}
export async function shareCredit(db: Db, creditId: string, business: Profile, currency: string, template?: InvoiceTemplate): Promise<void> {
  const d = await buildCreditData(db, creditId, business, currency);
  if (d) await shareInvoice(d, template ?? business.invoiceTemplate);
}

export async function shareSale(db: Db, localId: string, business: Profile, currency: string, template?: InvoiceTemplate): Promise<void> {
  const d = await buildInvoiceData(db, localId, business, currency);
  if (d) await shareInvoice(d, template ?? business.invoiceTemplate);
}

const docWord = (d: InvoiceData) => (d.kind === "quotation" ? "Quotation" : d.kind === "credit" ? "CreditNote" : d.kind === "delivery" ? "DeliveryNote" : invoiceTitle({ ...d.business, gstRegistered: d.gstRegistered }) === "BILL OF SUPPLY" ? "BillOfSupply" : "Invoice");
const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "document";

/** Renders HTML to a PDF named for the document (so the customer receives "Invoice-INV-0001.pdf", not a random id) and opens the system
 *  share sheet. Returns false when this device has no share sheet (nothing was shared). Throws if the PDF itself could not be made.
 *  The share sheet reports nothing back, so true means "opened", never "sent". */
export async function sharePdfHtml(html: string, paper: { width?: number; height?: number }, fileName: string, dialogTitle: string): Promise<boolean> {
  const { uri } = await Print.printToFileAsync({ html, ...paper });
  const named = new File(Paths.cache, fileName);
  if (named.exists) named.delete();
  new File(uri).copy(named);
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(named.uri, { mimeType: "application/pdf", UTI: ".pdf", dialogTitle });
  return true;
}

/** Renders the invoice to a PDF and opens the system share sheet (WhatsApp, email, print, save...). */
export async function shareInvoice(d: InvoiceData, template: InvoiceTemplate = "classic"): Promise<boolean> {
  const kindWord = d.kind === "quotation" ? "Quotation" : d.kind === "credit" ? "Credit note" : d.kind === "delivery" ? "Delivery note" : "Invoice";
  return sharePdfHtml(invoiceHtml(d, template), paperFor(d.kind === "delivery" ? "classic" : template), `${docWord(d)}-${safeName(d.number)}.pdf`, `${kindWord} ${d.number}`);
}

/** The system print preview of the invoice exactly as it would be shared: the user can check it, then print or save it as a PDF from there. */
export async function previewInvoice(d: InvoiceData, template: InvoiceTemplate = "classic"): Promise<void> {
  await Print.printAsync({ html: invoiceHtml(d, template), ...paperFor(template) });
}

/** The customer's account statement as a PDF, through the share sheet. Sharing it changes no record. */
export async function shareStatement(input: StatementInput): Promise<boolean> {
  return sharePdfHtml(statementHtml(input), paperFor("classic"), `Statement-${safeName(input.customer)}.pdf`, `Statement for ${input.customer}`);
}

/** Everything on the phone as one JSON file (every record, payments included). For a standalone phone this is the safety net; linking a server is the better one. */
export async function exportBackup(db: Db): Promise<void> {
  const f = new File(Paths.cache, `rechvix-backup-${new Date().toISOString().slice(0, 10)}.json`);
  if (f.exists) f.delete();
  f.create();
  f.write(JSON.stringify(await buildBackup(db), null, 2));
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(f.uri, { mimeType: "application/json", dialogTitle: "Rechvix backup" });
}

/** Lets the user pick a backup file and reads it. null when they cancel. Nothing is changed yet. */
export async function pickBackup(): Promise<{ text: string; name: string } | null> {
  const r = await File.pickFileAsync({ mimeTypes: ["application/json", "text/plain", "*/*"] });
  if (r.canceled) return null;
  return { text: await r.result.text(), name: r.result.name };
}

/** Saves what is on the phone right now next to the app's own files, so a restore that turns out to be the wrong file can be undone. */
export async function saveSafetyCopy(db: Db): Promise<string> {
  const f = new File(Paths.document, `before-restore-${Date.now()}.json`);
  f.create();
  f.write(JSON.stringify(await buildBackup(db)));
  return f.name;
}
