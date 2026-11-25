import { ageBucket, daysOverdue, dueOf, type AgeBucket, type LedgerInvoice } from "./ledger";

/** What the phone can honestly know about a reminder. It never claims "delivered": WhatsApp and the share sheet don't report that back.
 *  share_opened the message or PDF was handed to WhatsApp / the system share sheet (the user may still have backed out of it)
 *  marked_sent  the user told us they sent it themselves
 *  cancelled    the system reported that the share sheet was dismissed without sharing */
export type ReminderStatus = "share_opened" | "marked_sent" | "cancelled";
export type ReminderChannel = "whatsapp" | "share" | "pdf" | "manual";

export const STATUS_LABEL: Record<ReminderStatus, string> = {
  share_opened: "Share opened", marked_sent: "Marked as sent by you", cancelled: "Cancelled",
};
export const CHANNEL_LABEL: Record<ReminderChannel, string> = { whatsapp: "WhatsApp message", share: "Message via share sheet", pdf: "Invoice PDF via share sheet", manual: "Sent outside the app" };

export const isStatus = (v: unknown): v is ReminderStatus => v === "share_opened" || v === "marked_sent" || v === "cancelled";
/** Older rows (before status existed) only knew "the reminder was opened for sharing". */
export const statusOf = (v: unknown): ReminderStatus => (isStatus(v) ? v : "share_opened");

export interface ReminderPlan {
  /** False when there is nothing to remind about (fully paid / cancelled / unknown invoice). */
  eligible: boolean;
  /** Why not, in words the user can act on. */
  reason?: string;
  /** The open invoices the reminder covers (one for an invoice reminder, all open ones for a customer reminder). */
  invoices: LedgerInvoice[];
  totalMinor: bigint;
  paidMinor: bigint;
  /** Always what is still unpaid right now: partial payments already reduce it. */
  outstandingMinor: bigint;
  overdueMinor: bigint;
  /** The earliest due date among the covered invoices. */
  dueAt: number | null;
  daysOverdue: number;
}

/** Works out what a reminder is about from the customer's current invoices. `invoiceId` narrows it to one invoice. */
export function planReminder(invoices: LedgerInvoice[], now: number, invoiceId?: string): ReminderPlan {
  const empty: ReminderPlan = { eligible: false, invoices: [], totalMinor: 0n, paidMinor: 0n, outstandingMinor: 0n, overdueMinor: 0n, dueAt: null, daysOverdue: 0 };
  if (invoiceId) {
    const inv = invoices.find((i) => i.id === invoiceId);
    if (!inv) return { ...empty, reason: "This invoice could not be found." };
    if (inv.cancelled) return { ...empty, reason: `Invoice ${inv.number} was cancelled, so nothing is owed on it.` };
    if (dueOf(inv) === 0n) return { ...empty, reason: `Invoice ${inv.number} is already paid in full.` };
  }
  const open = (invoiceId ? invoices.filter((i) => i.id === invoiceId) : invoices).filter((i) => dueOf(i) > 0n).sort((a, z) => a.issuedAt - z.issuedAt);
  if (open.length === 0) return { ...empty, reason: "Nothing is outstanding for this customer." };
  let total = 0n, paid = 0n, out = 0n, over = 0n, due: number | null = null;
  for (const i of open) {
    total += i.totalMinor; paid += i.paidMinor > i.totalMinor ? i.totalMinor : i.paidMinor; out += dueOf(i);
    if (i.dueAt != null && i.dueAt < now) over += dueOf(i);
    if (i.dueAt != null && (due === null || i.dueAt < due)) due = i.dueAt;
  }
  return { eligible: true, invoices: open, totalMinor: total, paidMinor: paid, outstandingMinor: out, overdueMinor: over, dueAt: due, daysOverdue: daysOverdue(due, now) };
}

export interface MessageInput {
  customer: string; business: string; plan: ReminderPlan; money: (minor: bigint) => string; date: (ms: number) => string;
  /** The user means to send the invoice PDF with this reminder (as a separate attachment: the phone cannot merge text and a file on every platform). */
  withPdf: boolean;
}

/** The suggested wording. Every figure comes from the live plan, so a partly paid invoice is reminded for what is left, not its original total. */
export function composeMessage(i: MessageInput): string {
  const { plan, money } = i;
  const nums = plan.invoices.map((x) => x.number);
  const single = plan.invoices.length === 1;
  const what = single ? `invoice ${nums[0]}` : `your ${plan.invoices.length} unpaid invoices (${nums.slice(0, 3).join(", ")}${nums.length > 3 ? ` and ${nums.length - 3} more` : ""})`;
  const partly = single && plan.paidMinor > 0n ? ` You have already paid ${money(plan.paidMinor)} of ${money(plan.totalMinor)}.` : "";
  const when = plan.dueAt == null ? "" : plan.daysOverdue > 0 ? (single ? `, which was due on ${i.date(plan.dueAt)}` : `, the oldest of which was due on ${i.date(plan.dueAt)}`) : (single ? `, due on ${i.date(plan.dueAt)}` : `, the earliest due on ${i.date(plan.dueAt)}`);
  const pdf = i.withPdf ? ` I'm sending ${single ? "the invoice" : "the invoices"} as a PDF as well.` : "";
  return `Hello ${i.customer}, this is a friendly reminder from ${i.business} that ${what} ${single ? "has" : "have"} an outstanding balance of ${money(plan.outstandingMinor)}${when}.${partly}${pdf} Please let us know once it is paid. Thank you!`;
}

/** Money you are about to remind about may have changed since the screen opened (a payment came in on another device). */
export function stalePlan(a: ReminderPlan, b: ReminderPlan): string | null {
  if (a.eligible && !b.eligible) return b.reason ?? "This is no longer outstanding.";
  if (a.eligible && b.eligible && a.outstandingMinor !== b.outstandingMinor) return "The amount outstanding changed since you opened this. The message text now shows the current figure.";
  return null;
}

/** The phone number WhatsApp wants: digits only, with the country code. A bare 10-digit number is taken as Indian, as the rest of the app does. */
export function whatsappNumber(phone: string | undefined | null): string | null {
  const d = (phone ?? "").replace(/\D/g, "");
  if (d.length < 8) return null;
  return d.length === 10 ? `91${d}` : d;
}

export const BUCKETS: { key: AgeBucket; label: string }[] = [
  { key: "current", label: "Not yet due" }, { key: "1-30", label: "1-30 days" }, { key: "31-60", label: "31-60 days" }, { key: "61-90", label: "61-90 days" }, { key: "90+", label: "Over 90 days" },
];

export interface Aging { totals: Record<AgeBucket, bigint>; totalMinor: bigint }
/** Receivables by how late they are. An invoice without a due date counts as not yet due. */
export function agingOf(invoices: LedgerInvoice[], now: number): Aging {
  const totals: Record<AgeBucket, bigint> = { current: 0n, "1-30": 0n, "31-60": 0n, "61-90": 0n, "90+": 0n };
  let sum = 0n;
  for (const i of invoices) { const d = dueOf(i); if (d === 0n) continue; totals[ageBucket(i.dueAt, now)] += d; sum += d; }
  return { totals, totalMinor: sum };
}

/** Whole-number share of each bucket for a bar. Rounded down; never negative, never over 100. */
export function bucketPercent(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  return Math.min(100, Number((part * 100n) / whole));
}
