import React, { useState } from "react";
import { FlatList, ScrollView, View } from "react-native";
import { allCreditNotes, allPayments, listSales, searchProducts, type CreditNote, type Payment, type Product } from "../db/repo";
import { PERIODS, customRange, periodRange, type Period } from "../lib/daybook";
import { dayBookInput } from "../lib/daybookData";
import { useLocal, useNow } from "../lib/hooks";
import { formatMinor } from "../lib/money";
import { collectionsByMethod, saleReport, stockReport } from "../lib/reports";
import { useApp } from "../state/app";
import { useLedgers } from "../state/ledgers";
import { fonts, radius, space, usePalette } from "../theme";
import { Badge, Card, Chip, Divider, Empty, Field, Header, Icon, Screen, Tap, type IconName } from "../ui/kit";
import { T } from "../ui/text";

type Kind = "sales" | "customers" | "items" | "money" | "stock";
const KINDS: { k: Kind; t: string; icon: IconName; sub: string }[] = [
  { k: "sales", t: "Sales", icon: "receipt-outline", sub: "Billed, count and average bill" },
  { k: "customers", t: "By customer", icon: "people-outline", sub: "Who bought the most" },
  { k: "items", t: "By item", icon: "cube-outline", sub: "What sold, and for how much" },
  { k: "money", t: "Money in", icon: "cash-outline", sub: "Received, by how it was paid" },
  { k: "stock", t: "Stock", icon: "layers-outline", sub: "What to reorder, and what it is worth" },
];

/** Reports from this phone's own records (they work offline). Every figure is for the chosen period except stock, which is as of now. */
export function Reports({ onBack, openCustomer }: { onBack: () => void; openCustomer: (partyId: string) => void }) {
  const c = usePalette();
  const { currency, profile } = useApp();
  const now = useNow();
  const [kind, setKind] = useState<Kind | null>(null);
  const [period, setPeriod] = useState<Period>("month");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const sales = useLocal((d) => listSales(d, 5000), []);
  const pays = useLocal((d) => allPayments(d), [] as Payment[]);
  const credits = useLocal((d) => allCreditNotes(d), [] as CreditNote[]);
  const items = useLocal((d) => searchProducts(d, "", 5000), [] as Product[]);
  const ledgers = useLedgers();
  const m = (x: bigint) => formatMinor(x, currency);
  const fy = (profile?.country ?? "IN") === "IN" ? 4 : 1;
  const custom = period === "custom" ? customRange(from, to) : null;
  const range = period === "custom" ? custom : periodRange(period, now, fy);
  const periodLabel = PERIODS.find((p) => p.key === period)!.label;

  if (kind === null) {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          <Header title="Reports" onBack={onBack} sub="From the records on this phone, so they work offline" />
          <View style={{ padding: space.lg, gap: space.md }}>
            {KINDS.map((k) => (
              <Tap key={k.k} label={`${k.t} report. ${k.sub}`} onPress={() => setKind(k.k)} style={{ minHeight: 76, flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: c.surface, borderRadius: radius.lg + 2, borderWidth: 1, borderColor: c.border, padding: space.lg }}>
                <View style={{ width: 46, height: 46, borderRadius: 14, backgroundColor: c.accentSoft, alignItems: "center", justifyContent: "center" }}><Icon name={k.icon} size={24} color={c.accent} /></View>
                <View style={{ flex: 1 }}><T v="h3">{k.t}</T><T v="small" muted>{k.sub}</T></View>
                <Icon name="chevron-forward" size={20} color={c.faint} />
              </Tap>
            ))}
            <T v="small" muted>Looking for who owes you, by age? That is on To collect. Everything that happened on a day is in Day book (More).</T>
          </View>
        </ScrollView>
      </Screen>
    );
  }

  const meta = KINDS.find((k) => k.k === kind)!;
  const needsPeriod = kind !== "stock";
  const head = (
    <View style={{ gap: space.md, paddingBottom: space.md }}>
      <Header title={meta.t} onBack={() => setKind(null)} sub={needsPeriod ? undefined : "As of now"} />
      {needsPeriod ? (
        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          <FlatList horizontal data={PERIODS} keyExtractor={(p) => p.key} showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}
            renderItem={({ item }) => <Chip title={item.label} active={period === item.key} onPress={() => setPeriod(item.key)} />} />
          {period === "custom" ? (
            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1 }}><Field label="From" value={from} onChangeText={setFrom} placeholder="2026-11-01" keyboardType="numbers-and-punctuation" autoCapitalize="none" /></View>
              <View style={{ flex: 1 }}><Field label="To" value={to} onChangeText={setTo} placeholder="2026-11-30" keyboardType="numbers-and-punctuation" autoCapitalize="none" /></View>
            </View>
          ) : null}
          {period === "custom" && (from || to) && !custom ? <T v="small" color={c.negative}>Enter real dates as YYYY-MM-DD, with the end on or after the start.</T> : null}
        </View>
      ) : null}
    </View>
  );

  const bar = (part: bigint, whole: bigint) => (
    <View style={{ height: 6, borderRadius: 3, backgroundColor: c.surfaceAlt, overflow: "hidden", marginTop: 6 }}>
      <View style={{ height: 6, width: `${whole > 0n ? Math.min(100, Number((part * 100n) / whole)) : 0}%`, backgroundColor: c.accent }} />
    </View>
  );

  let body: React.ReactNode = null;
  if (needsPeriod && !range) {
    body = <Card style={{ marginHorizontal: space.lg }}><Empty icon="calendar-outline" title="Choose a period" hint="Enter a start and end date." /></Card>;
  } else if (kind === "sales" && range) {
    const r = saleReport(sales, range);
    body = (
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <View style={{ backgroundColor: c.accentSoft, borderRadius: radius.lg + 4, padding: space.xl, gap: 4 }}>
          <T v="label" color={c.accent}>Billed · {periodLabel.toLowerCase()}</T>
          <T v="moneyHero" adjustsFontSizeToFit numberOfLines={1}>{m(r.billedMinor)}</T>
          <T v="small" muted>{r.count} invoice{r.count === 1 ? "" : "s"}{r.count ? ` · average ${m(r.averageMinor)}` : ""}. Cancelled invoices are not counted.</T>
        </View>
        {r.count === 0 ? <Card><Empty icon="receipt-outline" title="No invoices in this period" /></Card> : null}
      </View>
    );
  } else if (kind === "customers" && range) {
    const r = saleReport(sales, range);
    body = r.byCustomer.length === 0 ? <Card style={{ marginHorizontal: space.lg }}><Empty icon="people-outline" title="No sales in this period" /></Card> : (
      <Card style={{ marginHorizontal: space.lg, padding: 0 }}>
        {r.byCustomer.map((x, i) => (
          <View key={x.partyId}>
            <Tap label={`${x.name}, ${x.count} invoices, ${m(x.billedMinor)}`} onPress={() => openCustomer(x.partyId)} style={{ padding: space.lg }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                <View style={{ flex: 1 }}><T v="strong" numberOfLines={1}>{x.name}</T><T v="small" muted>{x.count} invoice{x.count === 1 ? "" : "s"}</T></View>
                <T v="money" style={{ fontFamily: fonts.monoBold }}>{m(x.billedMinor)}</T>
              </View>
              {bar(x.billedMinor, r.byCustomer[0]!.billedMinor)}
            </Tap>
            {i < r.byCustomer.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card>
    );
  } else if (kind === "items" && range) {
    const r = saleReport(sales, range);
    body = r.byItem.length === 0 ? <Card style={{ marginHorizontal: space.lg }}><Empty icon="cube-outline" title="No sales in this period" /></Card> : (
      <Card style={{ marginHorizontal: space.lg, padding: 0 }}>
        {r.byItem.map((x, i) => (
          <View key={x.key}>
            <View style={{ padding: space.lg }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                <View style={{ flex: 1 }}><T v="strong" numberOfLines={1}>{x.name}</T><T v="small" muted>{x.qty} sold</T></View>
                <T v="money" style={{ fontFamily: fonts.monoBold }}>{m(x.amountMinor)}</T>
              </View>
              {bar(x.amountMinor, r.byItem[0]!.amountMinor)}
            </View>
            {i < r.byItem.length - 1 ? <Divider /> : null}
          </View>
        ))}
      </Card>
    );
  } else if (kind === "money" && range) {
    const dbk = dayBookInput(sales, pays, credits, ledgers, new Map());
    const r = collectionsByMethod(dbk.payments, range);
    body = (
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <View style={{ backgroundColor: c.positiveSoft, borderRadius: radius.lg + 4, padding: space.xl, gap: 4 }}>
          <T v="label" color={c.positive}>Received · {periodLabel.toLowerCase()}</T>
          <T v="moneyHero" adjustsFontSizeToFit numberOfLines={1}>{m(r.totalMinor)}</T>
          <T v="small" muted>Money taken at the till and payments recorded later, counted once. Reversed payments are not counted.</T>
        </View>
        {r.methods.length === 0 ? <Card><Empty icon="cash-outline" title="No money received in this period" /></Card> : (
          <Card style={{ padding: 0 }}>
            {r.methods.map((x, i) => (
              <View key={x.method}>
                <View style={{ padding: space.lg }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                    <View style={{ flex: 1 }}><T v="strong" style={{ textTransform: "capitalize" }}>{x.method}</T><T v="small" muted>{x.count} payment{x.count === 1 ? "" : "s"}</T></View>
                    <T v="money" style={{ fontFamily: fonts.monoBold }}>{m(x.amountMinor)}</T>
                  </View>
                  {bar(x.amountMinor, r.totalMinor)}
                </View>
                {i < r.methods.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        )}
      </View>
    );
  } else if (kind === "stock") {
    const r = stockReport(items);
    body = (
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Stat label="Out" value={`${r.out}`} bg={c.negativeSoft} tone={c.negative} />
          <Stat label="Low" value={`${r.low}`} bg={c.warningSoft} tone={c.warning} />
          <Stat label="Worth" value={m(r.valueMinor)} bg={c.surface} tone={c.text} />
        </View>
        <T v="small" muted>Worth is stock times the price on each item, a guide rather than a book value.{r.untracked > 0 ? ` ${r.untracked} item${r.untracked === 1 ? " has" : "s have"} no stock figure and ${r.untracked === 1 ? "is" : "are"} not listed.` : ""}</T>
        {r.rows.length === 0 ? <Card><Empty icon="layers-outline" title="No items with stock" hint="Give an item a stock figure and it appears here." /></Card> : (
          <Card style={{ padding: 0 }}>
            {r.rows.map((x, i) => (
              <View key={x.id}>
                <View style={{ padding: space.lg, flexDirection: "row", alignItems: "center", gap: 12 }}>
                  <View style={{ flex: 1 }}><T v="strong" numberOfLines={1}>{x.name}</T><T v="small" muted>{x.stock} {x.unit}{x.sku ? ` · ${x.sku}` : ""}</T></View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <T v="money">{m(x.valueMinor)}</T>
                    {x.state === "out" ? <Badge tone="bad" text="Out of stock" /> : x.state === "low" ? <Badge tone="warn" text="Running low" /> : <Badge tone="good" text="In stock" />}
                  </View>
                </View>
                {i < r.rows.length - 1 ? <Divider /> : null}
              </View>
            ))}
          </Card>
        )}
      </View>
    );
  }

  return <Screen><ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">{head}{body}</ScrollView></Screen>;
}

function Stat({ label, value, bg, tone }: { label: string; value: string; bg: string; tone: string }) {
  const c = usePalette();
  return (
    <View style={{ flex: 1, backgroundColor: bg, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, padding: space.md, gap: 2 }} accessible accessibilityLabel={`${label} ${value}`}>
      <T v="label" color={tone}>{label}</T>
      <T v="money" adjustsFontSizeToFit numberOfLines={1} style={{ fontFamily: fonts.monoBold, fontSize: 16 }}>{value}</T>
    </View>
  );
}
