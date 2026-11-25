import React, { useState } from "react";
import { FlatList, TextInput, View } from "react-native";
import { allCreditNotes, allPayments, listSales, type CreditNote, type Party, type Payment } from "../db/repo";
import { PERIODS, buildDayBook, customRange, dayBookHtml, periodRange, type DayBookEntry, type KindFilter, type Period } from "../lib/daybook";
import { dayBookInput } from "../lib/daybookData";
import { useLocal, useNow } from "../lib/hooks";
import { formatMinor } from "../lib/money";
import { paperFor } from "../lib/invoice";
import { sharePdfHtml } from "../lib/share";
import { useApp } from "../state/app";
import { useLedgers } from "../state/ledgers";
import { fonts, radius, space, usePalette } from "../theme";
import { Button, Card, Chip, Empty, Field, Header, Icon, Screen, Tap, type IconName } from "../ui/kit";
import { T } from "../ui/text";

const SHOW = 200;
const KINDS: { k: KindFilter; t: string }[] = [{ k: "all", t: "Everything" }, { k: "sale", t: "Invoices" }, { k: "payment", t: "Money in" }, { k: "credit", t: "Credit notes" }];
const ICON: Record<DayBookEntry["kind"], IconName> = { sale: "receipt-outline", payment: "arrow-down-circle-outline", credit: "return-down-back-outline" };

/** Everything that happened in a period: invoices, money received, credit notes. Read-only: it changes no record. */
export function DayBook({ onBack, openSale, openCustomer }: { onBack: () => void; openSale: (id: string) => void; openCustomer: (partyId: string) => void }) {
  const c = usePalette();
  const { currency, profile, businessName } = useApp();
  const now = useNow();
  const sales = useLocal((d) => listSales(d, 5000), []);
  const pays = useLocal((d) => allPayments(d), [] as Payment[]);
  const credits = useLocal((d) => allCreditNotes(d), [] as CreditNote[]);
  const parties = useLocal((d) => d.all<Party>("SELECT * FROM parties"), [] as Party[]);
  const ledgers = useLedgers();
  const [period, setPeriod] = useState<Period>("today");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const m = (x: bigint) => formatMinor(x, currency);

  const fy = (profile?.country ?? "IN") === "IN" ? 4 : 1;
  const custom = period === "custom" ? customRange(from, to) : null;
  const range = period === "custom" ? custom : periodRange(period, now, fy);
  const customError = period === "custom" && (from || to) && !custom ? "Enter real dates as YYYY-MM-DD, with the end on or after the start." : null;
  const input = dayBookInput(sales, pays, credits, ledgers, new Map(parties.map((p) => [p.id, p.name])));
  const book = range ? buildDayBook(input, range, kind, q) : null;
  const label = PERIODS.find((p) => p.key === period)!.label;
  const day = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });

  async function share() {
    if (!book || !range || busy) return;
    setBusy(true); setMsg(null);
    try {
      const ok = await sharePdfHtml(dayBookHtml(book, range, profile?.name || businessName, currency, label), paperFor("classic"), `DayBook-${new Date(range.from).toISOString().slice(0, 10)}.pdf`, "Day book");
      setMsg(ok ? "The day book PDF was opened for sharing." : "This phone has no share sheet, so the PDF could not be shared.");
    } catch { setMsg("Couldn't create the PDF. Try again."); } finally { setBusy(false); }
  }

  const rows = (book?.entries ?? []).slice(0, SHOW);
  const header = (
    <View style={{ gap: space.lg, paddingBottom: space.md }}>
      <Header title="Day book" onBack={onBack} sub="Invoices, money in and credit notes, in time order" />
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <FlatList horizontal data={PERIODS} keyExtractor={(p) => p.key} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) => <Chip title={item.label} active={period === item.key} onPress={() => setPeriod(item.key)} />} />
        {period === "custom" ? (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ flex: 1 }}><Field label="From" value={from} onChangeText={setFrom} placeholder="2026-11-01" keyboardType="numbers-and-punctuation" autoCapitalize="none" /></View>
            <View style={{ flex: 1 }}><Field label="To" value={to} onChangeText={setTo} placeholder="2026-11-30" keyboardType="numbers-and-punctuation" autoCapitalize="none" /></View>
          </View>
        ) : null}
        {customError ? <T v="small" color={c.negative}>{customError}</T> : null}
        {range ? <T v="small" muted>{day(range.from)}{range.to - range.from > 86_400_000 ? ` to ${day(range.to - 1)}` : ""}</T> : null}

        {book ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Tile label="Billed" value={m(book.billedMinor)} sub={`${book.billedCount} invoice${book.billedCount === 1 ? "" : "s"}`} tone={c.text} bg={c.surface} />
            <Tile label="Money in" value={m(book.receivedMinor)} sub={`${book.receivedCount} payment${book.receivedCount === 1 ? "" : "s"}`} tone={c.positive} bg={c.positiveSoft} />
            <Tile label="Credit notes" value={m(book.creditedMinor)} sub={`${book.creditCount}`} tone={c.negative} bg={c.negativeSoft} />
          </View>
        ) : null}

        <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: c.surface, borderRadius: radius.md + 2, borderWidth: 1, borderColor: c.border, paddingLeft: 14 }}>
          <Icon name="search" size={18} color={c.faint} />
          <TextInput accessibilityLabel="Search the day book" value={q} onChangeText={setQ} placeholder="Customer or invoice number" placeholderTextColor={c.faint} style={{ flex: 1, minHeight: 48, paddingHorizontal: 10, fontSize: 16, color: c.text, fontFamily: fonts.body }} />
        </View>
        <FlatList horizontal data={KINDS} keyExtractor={(k) => k.k} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) => <Chip title={item.t} active={kind === item.k} onPress={() => setKind(item.k)} />} />
        <Button title="Share as PDF" icon="share-outline" kind="quiet" onPress={() => void share()} busy={busy} disabled={!book || book.entries.length === 0} />
        {msg ? <T v="small" muted>{msg}</T> : null}
      </View>
    </View>
  );

  return (
    <Screen>
      <FlatList
        data={rows} keyExtractor={(e) => e.id} ListHeaderComponent={header} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={book ? <Card style={{ marginHorizontal: space.lg }}><Empty icon="calendar-outline" title="Nothing in this period" hint="Try a wider period or another filter." /></Card> : <Card style={{ marginHorizontal: space.lg }}><Empty icon="calendar-outline" title="Choose a period" hint="Enter a start and end date to see what happened." /></Card>}
        ListFooterComponent={book && book.entries.length > SHOW ? <T v="small" muted style={{ padding: space.lg }}>Showing the newest {SHOW} of {book.entries.length}. The totals above include all {book.entries.length}; narrow the period to see the rest.</T> : undefined}
        renderItem={({ item, index }) => {
          const prev = rows[index - 1];
          const newDay = !prev || new Date(prev.at).toDateString() !== new Date(item.at).toDateString();
          const tone = item.void ? c.faint : item.kind === "payment" ? c.positive : item.kind === "credit" ? c.negative : c.text;
          return (
            <View style={{ paddingHorizontal: space.lg }}>
              {newDay ? <T v="label" muted style={{ paddingTop: space.lg, paddingBottom: 6 }}>{day(item.at)}</T> : null}
              <Tap label={`${item.kind === "sale" ? "Invoice" : item.kind === "payment" ? "Payment" : "Credit note"} ${item.ref}, ${item.party}, ${m(item.amountMinor)}${item.void ? ", cancelled" : ""}`}
                onPress={() => (item.saleId ? openSale(item.saleId) : item.partyId ? openCustomer(item.partyId) : undefined)}
                style={{ minHeight: 64, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, borderRadius: radius.md + 2, padding: space.md, marginBottom: 8 }}>
                <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: item.kind === "payment" ? c.positiveSoft : item.kind === "credit" ? c.negativeSoft : c.surfaceAlt, alignItems: "center", justifyContent: "center" }}>
                  <Icon name={ICON[item.kind]} size={20} color={tone} />
                </View>
                <View style={{ flex: 1 }}>
                  <T v="strong" numberOfLines={1} style={item.void ? { textDecorationLine: "line-through", color: c.muted } : undefined}>{item.party}</T>
                  <T v="small" muted numberOfLines={1}>{item.kind === "payment" ? "Payment" : item.kind === "credit" ? "Credit note" : "Invoice"} · {item.ref}{item.detail ? ` · ${item.detail}` : ""} · {new Date(item.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}{item.void ? " · cancelled" : ""}</T>
                </View>
                <T v="money" color={tone} style={{ fontFamily: fonts.monoBold, ...(item.void ? { textDecorationLine: "line-through" as const } : null) }}>{item.kind === "credit" ? "-" : item.kind === "payment" ? "+" : ""}{m(item.amountMinor)}</T>
              </Tap>
            </View>
          );
        }}
      />
    </Screen>
  );
}

function Tile({ label, value, sub, tone, bg }: { label: string; value: string; sub: string; tone: string; bg: string }) {
  const c = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: space.md, gap: 2 }} accessible accessibilityLabel={`${label} ${value}, ${sub}`}>
      <T v="label" color={tone}>{label}</T>
      <T v="money" adjustsFontSizeToFit numberOfLines={1} style={{ fontFamily: fonts.monoBold, fontSize: 15 }}>{value}</T>
      <T v="small" muted>{sub}</T>
    </View>
  );
}
