import React, { useEffect, useMemo, useState } from "react";
import { Linking, Modal, ScrollView, Share, Switch, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { addReminder, getParty, remindersFor, setReminderStatus, type Party, type Payment, type ReminderRow } from "../db/repo";
import { minorToString, parseMinor } from "../lib/decimal";
import { ago, nowMs, useLocal, useNow } from "../lib/hooks";
import { formatMinor } from "../lib/money";
import { CHANNEL_LABEL, STATUS_LABEL, composeMessage, planReminder, stalePlan, statusOf, whatsappNumber, type ReminderChannel, type ReminderPlan, type ReminderStatus } from "../lib/reminder";
import { buildInvoiceData, shareInvoice, shareStatement } from "../lib/share";
import { statementPayments } from "../lib/statement";
import { useApp } from "../state/app";
import { fonts, radius, space, usePalette } from "../theme";
import { Badge, Button, Card, Divider, Header, Label, Tap } from "../ui/kit";
import { T } from "../ui/text";
import { useLedgers } from "../state/ledgers";

const TONE: Record<ReminderStatus, "info" | "good" | "neutral"> = { share_opened: "info", marked_sent: "good", cancelled: "neutral" };

/** Compose and hand off a payment reminder for one invoice (invoiceId) or for everything a customer owes.
 *  Nothing is sent by opening this screen. Each button below is an explicit hand-off, and the history records only what really happened:
 *  "share opened" (the phone cannot see whether anything was delivered) or "marked sent" (the user's own word). */
export function ReminderComposer({ partyId, invoiceId, onClose }: { partyId: string; invoiceId?: string; onClose: () => void }) {
  const c = usePalette();
  const { db, profile, currency, businessName, changed, linked, online, syncNow } = useApp();
  const ledger = useLedgers().find((l) => l.partyId === partyId);
  const party = useLocal((d) => getParty(d, partyId), null as Party | null, [partyId]);
  const history = useLocal((d) => remindersFor(d, partyId), [] as ReminderRow[], [partyId]);
  const pays = useLocal((d) => d.all<Payment>("SELECT * FROM payments WHERE party_id=? ORDER BY paid_at", [partyId]), [] as Payment[], [partyId]);
  const now = useNow();
  const m = (x: bigint) => formatMinor(x, currency);
  const day = (ms: number) => new Date(ms).toLocaleDateString();

  const plan: ReminderPlan = useMemo(() => planReminder(ledger?.invoices ?? [], now, invoiceId), [ledger, now, invoiceId]);
  const single = plan.invoices.length === 1;
  // What the user was looking at when the composer opened, to tell them if it changes underneath (React's "adjust state while rendering" pattern).
  const [openedWith, setOpenedWith] = useState<ReminderPlan | null>(null);
  if (ledger && openedWith === null) setOpenedWith(plan);
  const stale = openedWith ? stalePlan(openedWith, plan) : null;

  const [withPdf, setWithPdf] = useState(true);
  const [edited, setEdited] = useState<string | null>(null);   // the user's own wording, once they type
  const suggested = plan.eligible ? composeMessage({ customer: ledger?.name ?? "", business: businessName, plan, money: m, date: day, withPdf }) : "";
  const message = edited ?? suggested;
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // Pull the latest balances once when the composer opens and a server is linked, so a payment taken elsewhere is not reminded about.
  useEffect(() => { if (linked && online) void syncNow(); }, [linked, online, syncNow]);

  const wa = whatsappNumber(party?.phone);
  const saleId = invoiceId ?? null;

  async function log(channel: ReminderChannel, status: ReminderStatus, pdf: boolean): Promise<number | null> {
    if (!db) return null;
    const id = await addReminder(db, partyId, nowMs(), channel, { saleLocalId: saleId, status, withPdf: pdf, outstanding: minorToString(plan.outstandingMinor), message });
    changed();
    return id;
  }

  async function openWhatsApp() {
    if (!wa || busy) return;
    setBusy("wa"); setNote(null);
    try {
      try { await Linking.openURL(`whatsapp://send?phone=${wa}&text=${encodeURIComponent(message)}`); } catch { await Linking.openURL(`https://wa.me/${wa}?text=${encodeURIComponent(message)}`); }
      await log("whatsapp", "share_opened", false);
      setNote({ tone: "ok", text: "WhatsApp was opened with your message. Press send there. Rechvix cannot see whether it was sent or read." });
    } catch { setNote({ tone: "bad", text: "WhatsApp could not be opened on this phone. Use the share sheet instead." }); } finally { setBusy(null); }
  }

  async function shareText() {
    if (busy) return;
    setBusy("text"); setNote(null);
    try {
      const r = await Share.share({ message });
      if (r.action === Share.dismissedAction) { await log("share", "cancelled", false); setNote({ tone: "ok", text: "Share closed without sending. Nothing was shared." }); }
      else { await log("share", "share_opened", false); setNote({ tone: "ok", text: "The share sheet was used. Rechvix cannot see which app you picked or whether it was delivered." }); }
    } catch { setNote({ tone: "bad", text: "The share sheet could not be opened." }); } finally { setBusy(null); }
  }

  async function sharePdf() {
    if (!db || !profile || !ledger || busy) return;
    setBusy("pdf"); setNote(null);
    try {
      let opened: boolean;
      if (single) {
        const d = await buildInvoiceData(db, plan.invoices[0]!.id, profile, currency);
        if (!d) throw new Error("missing");
        opened = await shareInvoice(d, profile.invoiceTemplate);
      } else {
        opened = await shareStatement({ business: profile, customer: ledger.name, phone: party?.phone, currency, invoices: ledger.invoices, payments: statementPayments(ledger.invoices, pays), now: nowMs() });
      }
      if (!opened) { setNote({ tone: "bad", text: "This phone has no share sheet, so the PDF could not be handed to another app." }); return; }
      await log("pdf", "share_opened", true);
      setNote({ tone: "ok", text: `The ${single ? "invoice" : "statement"} PDF was opened for sharing. If you also want the message to go, use WhatsApp or Share message too: apps do not take a message and a file together.` });
    } catch { setNote({ tone: "bad", text: "The PDF could not be created. Nothing was shared. Try again." }); } finally { setBusy(null); }
  }

  async function markSent() {
    if (busy) return;
    await log("manual", "marked_sent", false);
    setNote({ tone: "ok", text: "Recorded as sent by you. This is your own note: Rechvix did not send it." });
  }

  async function markHistory(r: ReminderRow) {
    if (!db) return;
    await setReminderStatus(db, r.id, "marked_sent");
    changed();
  }

  const shown = history.filter((r) => !invoiceId || r.sale_local_id === invoiceId).slice(0, 8);
  const gone = !ledger || !plan.eligible;

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <Header title="Payment reminder" onBack={onClose} sub={ledger?.name} />
        <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          {gone ? (
            <Card style={{ backgroundColor: c.surfaceAlt, gap: 6 }}>
              <T v="h3">No reminder needed</T>
              <T v="body" muted>{plan.reason ?? "Nothing is outstanding."}</T>
              <T v="small" muted>Reminders are only for invoices that still have a balance.</T>
            </Card>
          ) : (
            <>
              <View style={{ backgroundColor: plan.overdueMinor > 0n ? c.negativeSoft : c.warningSoft, borderRadius: radius.lg + 4, padding: space.xl, gap: 6 }}>
                <T v="label" color={plan.overdueMinor > 0n ? c.negative : c.warning}>Outstanding now</T>
                <T v="moneyHero" adjustsFontSizeToFit numberOfLines={1} accessibilityLabel={`Outstanding ${m(plan.outstandingMinor)}`}>{m(plan.outstandingMinor)}</T>
                <T v="small" muted>
                  {single ? `Invoice ${plan.invoices[0]!.number}` : `${plan.invoices.length} unpaid invoices`} · total {m(plan.totalMinor)}{plan.paidMinor > 0n ? ` · received ${m(plan.paidMinor)}` : ""}
                </T>
                {plan.dueAt != null ? <T v="small" color={plan.daysOverdue > 0 ? c.negative : c.muted}>{plan.daysOverdue > 0 ? `${plan.daysOverdue} day${plan.daysOverdue === 1 ? "" : "s"} overdue (due ${day(plan.dueAt)})` : `Due ${day(plan.dueAt)}`}</T> : null}
              </View>

              {stale ? <Card style={{ backgroundColor: c.warningSoft, borderColor: c.warning }}><T v="small" color={c.warning}>{stale}</T></Card> : null}
              {!wa ? <Card style={{ backgroundColor: c.infoSoft, borderColor: c.info }}><T v="small" color={c.info}>{party?.phone ? `The saved phone number (${party.phone}) doesn't look complete, so WhatsApp is off.` : `No phone number is saved for ${ledger!.name}, so WhatsApp is off.`} You can still use the share sheet, or add a number on the customer.</T></Card> : null}

              <View style={{ gap: 8 }}>
                <Label>Message</Label>
                <TextInput accessibilityLabel="Reminder message" multiline value={message} onChangeText={setEdited} textAlignVertical="top"
                  style={{ minHeight: 150, borderRadius: radius.md + 2, borderWidth: 1, borderColor: c.borderStrong, backgroundColor: c.surface, color: c.text, padding: 14, fontSize: 16, lineHeight: 23, fontFamily: fonts.body }} />
                {edited !== null && edited !== suggested ? <Tap label="Use the suggested wording again" onPress={() => setEdited(null)} style={{ minHeight: 40, justifyContent: "center", alignSelf: "flex-start" }}><T v="small" color={c.accent} style={{ fontFamily: fonts.bodySemi }}>Use the suggested wording again</T></Tap> : null}
              </View>

              <View style={{ flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surface, borderRadius: radius.md + 2, borderWidth: 1, borderColor: c.border, padding: space.md, paddingHorizontal: space.lg }}>
                <View style={{ flex: 1 }}>
                  <T v="strong">{single ? "Also send the invoice PDF" : "Also send a statement PDF"}</T>
                  <T v="small" muted>{single ? "The invoice as it was issued, with payments received." : "All invoices and payments, with what is owed by age."}</T>
                </View>
                <Switch accessibilityLabel={single ? "Include invoice PDF" : "Include statement PDF"} value={withPdf} onValueChange={setWithPdf} trackColor={{ true: c.accent, false: c.borderStrong }} />
              </View>

              <View style={{ gap: 10 }}>
                <Label>Send it</Label>
                <Button title="Open WhatsApp with this message" icon="logo-whatsapp" onPress={() => void openWhatsApp()} disabled={!wa} busy={busy === "wa"} />
                {withPdf ? <Button title={single ? "Share invoice PDF" : "Share statement PDF"} icon="document-attach-outline" kind="quiet" onPress={() => void sharePdf()} busy={busy === "pdf"} /> : null}
                <Button title="Share message as text" icon="share-outline" kind="quiet" onPress={() => void shareText()} busy={busy === "text"} />
                {withPdf ? <T v="small" muted>WhatsApp and most apps take either a message or a file, not both together, so this is two taps: message first, then the PDF to the same chat.</T> : null}
                <Tap label="I sent this myself" onPress={() => void markSent()} style={{ minHeight: 44, justifyContent: "center", alignSelf: "flex-start" }}><T v="small" color={c.accent} style={{ fontFamily: fonts.bodySemi }}>I sent this myself, note it down</T></Tap>
              </View>
            </>
          )}

          {note ? <Card style={{ backgroundColor: note.tone === "ok" ? c.positiveSoft : c.negativeSoft, borderColor: note.tone === "ok" ? c.positive : c.negative }} ><View accessibilityLiveRegion="polite"><T v="small" color={note.tone === "ok" ? c.positive : c.negative}>{note.text}</T></View></Card> : null}

          <View style={{ gap: 8 }}>
            <Label>Reminder history{invoiceId ? " for this invoice" : ""}</Label>
            {shown.length === 0 ? <T v="small" muted>No reminders recorded yet.</T> : (
              <Card style={{ padding: 0 }}>
                {shown.map((r, i) => {
                  const st = statusOf(r.status);
                  return (
                    <View key={r.id}>
                      <View style={{ padding: space.lg, gap: 6 }}>
                        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                          <View style={{ flex: 1 }}><T v="strong">{CHANNEL_LABEL[(r.channel as ReminderChannel)] ?? r.channel}{r.with_pdf ? " · PDF" : ""}</T><T v="small" muted>{new Date(r.at).toLocaleString()} ({ago(r.at, now)}){r.outstanding ? ` · for ${m(parseMinor(r.outstanding))}` : ""}</T></View>
                          <Badge tone={TONE[st]} text={STATUS_LABEL[st]} icon={st === "marked_sent" ? "checkmark" : undefined} />
                        </View>
                        {st === "share_opened" ? <Tap label="Mark as sent" onPress={() => void markHistory(r)} style={{ minHeight: 36, justifyContent: "center", alignSelf: "flex-start" }}><T v="small" color={c.accent} style={{ fontFamily: fonts.bodySemi }}>I did send it, mark as sent</T></Tap> : null}
                      </View>
                      {i < shown.length - 1 ? <Divider /> : null}
                    </View>
                  );
                })}
              </Card>
            )}
            <T v="small" muted>Rechvix records that a message or PDF was handed to another app. It cannot tell whether it was delivered or read.</T>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

/** A small "Reminded 3 d ago" line for lists. */
export function lastReminderText(rows: ReminderRow[], now: number): string | null {
  const r = rows[0];
  if (!r) return null;
  const st = statusOf(r.status);
  return st === "cancelled" ? null : `Reminder ${st === "marked_sent" ? "sent" : "opened"} ${ago(r.at, now)}`;
}
