import React, { useEffect, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Linking, Modal, Platform, ScrollView, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  addSupplierPayment, billMinor, canDeletePurchase, createSupplier, deletePurchase, deleteUnsyncedSupplierPayment, getSupplier, lineMinor, paymentsForSupplier, purchasesForSupplier,
  retryPurchase, retrySupplierPayment, savePurchase, suppliersWithOwed, totalOwed, updateSupplier, type Purchase, type PurchaseLine, type Supplier, type SupplierPayment, type SupplierRow,
} from "../db/purchases";
import { searchProducts, type Product } from "../db/repo";
import { dec, minorToString, parseDec, parseMinor } from "../lib/decimal";
import { formatMinor } from "../lib/money";
import { nowMs, useLocal } from "../lib/hooks";
import { uid, useApp } from "../state/app";
import { fonts, radius, space, usePalette } from "../theme";
import { Badge, Button, Card, Chip, Divider, Empty, Field, Header, Icon, IconButton, Label, Screen, Tap } from "../ui/kit";
import { T } from "../ui/text";

const METHODS: { key: string; label: string }[] = [{ key: "CASH", label: "Cash" }, { key: "UPI", label: "UPI" }, { key: "BANK_TRANSFER", label: "Bank" }, { key: "CARD", label: "Card" }, { key: "CHEQUE", label: "Cheque" }];
const methodLabel = (k: string) => METHODS.find((m) => m.key === k)?.label ?? k;
const dateText = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
const amountOk = (t: string): bigint | null => { const s = t.replace(/[,\s]/g, ""); if (!/^\d+(\.\d{1,2})?$/.test(s)) return null; const m = parseMinor(s); return m > 0n ? m : null; };

/** Set while the screen is open: returns true when it stepped back inside itself. */
export const suppliersBack: { current: (() => boolean) | null } = { current: null };

type View_ = { name: "list" } | { name: "supplier"; id: string } | { name: "bill"; supplierId: string | null };

/** Suppliers and what is bought from them: bills (which put stock on the shelf), what is owed, and payments. Each bill and payment reaches the books once, whatever the connection does. */
export function Suppliers({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<View_>({ name: "list" });
  const [editor, setEditor] = useState<string | null | undefined>(undefined);
  // The app's own back handler asks us first, so Back steps out of a bill or a supplier before it closes this whole screen.
  useEffect(() => {
    suppliersBack.current = () => {
      if (editor !== undefined) { setEditor(undefined); return true; }
      if (view.name === "bill") { setView(view.supplierId ? { name: "supplier", id: view.supplierId } : { name: "list" }); return true; }
      if (view.name === "supplier") { setView({ name: "list" }); return true; }
      return false;   // the list: let the app close this screen
    };
    return () => { suppliersBack.current = null; };
  }, [view, editor]);
  return (
    <>
      {view.name === "list" ? <List onBack={onBack} open={(id) => setView({ name: "supplier", id })} add={() => setEditor(null)} newBill={() => setView({ name: "bill", supplierId: null })} />
        : view.name === "supplier" ? <Detail id={view.id} onBack={() => setView({ name: "list" })} newBill={() => setView({ name: "bill", supplierId: view.id })} edit={() => setEditor(view.id)} />
        : <NewBill supplierId={view.supplierId} onBack={() => setView(view.supplierId ? { name: "supplier", id: view.supplierId } : { name: "list" })} done={(id) => setView({ name: "supplier", id })} addSupplier={() => setEditor(null)} />}
      {editor !== undefined ? <SupplierEditor id={editor} onClose={() => setEditor(undefined)} /> : null}
    </>
  );
}

function List({ onBack, open, add, newBill }: { onBack: () => void; open: (id: string) => void; add: () => void; newBill: () => void }) {
  const { currency, linked } = useApp();
  const c = usePalette();
  const [q, setQ] = useState("");
  const rows = useLocal((d) => suppliersWithOwed(d, q), [] as SupplierRow[], [q]);
  const m = (x: bigint) => formatMinor(x, currency);
  const owed = totalOwed(rows);
  return (
    <Screen>
      <Header title="Suppliers" onBack={onBack} sub="Bills you receive, what you owe, and what you pay." right={<IconButton name="person-add-outline" label="Add supplier" tone="accent" onPress={add} />} />
      <View style={{ paddingHorizontal: space.lg, gap: space.md, paddingBottom: space.md }}>
        <Card style={{ gap: 4 }}>
          <T v="label" muted>You owe suppliers</T>
          <T v="moneyLg" adjustsFontSizeToFit numberOfLines={1}>{m(owed)}</T>
        </Card>
        <Button title="New supplier bill" icon="add-circle-outline" onPress={newBill} />
        <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: c.surface, borderRadius: radius.md + 2, borderWidth: 1, borderColor: c.borderStrong, paddingLeft: 14 }}>
          <Icon name="search" size={20} color={c.faint} />
          <TextInput accessibilityLabel="Search suppliers" value={q} onChangeText={setQ} placeholder="Name or phone" placeholderTextColor={c.faint}
            style={{ flex: 1, minHeight: 50, paddingHorizontal: 10, fontSize: 16, color: c.text, fontFamily: fonts.body }} />
        </View>
      </View>
      <FlatList data={rows} keyExtractor={(s) => s.id} contentContainerStyle={{ paddingBottom: 40 }} ItemSeparatorComponent={Divider}
        ListEmptyComponent={<Empty icon="business-outline" title="No suppliers yet" hint="Add who you buy from, then record their bills so your stock and what you owe stay right." action={{ title: "Add a supplier", onPress: add }} />}
        renderItem={({ item }) => (
          <Tap label={item.name} onPress={() => open(item.id)} style={{ minHeight: 68, backgroundColor: c.surface, padding: space.lg, flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: c.accentSoft, alignItems: "center", justifyContent: "center" }}><T v="h3" color={c.accent}>{item.name.slice(0, 1).toUpperCase()}</T></View>
            <View style={{ flex: 1, gap: 2 }}>
              <T v="strong" numberOfLines={1}>{item.name}</T>
              <T v="small" muted numberOfLines={1}>{item.phone || "No phone"}{linked && item.origin === "local" && !item.pushed ? " · not uploaded" : ""}</T>
            </View>
            <View style={{ alignItems: "flex-end", gap: 4 }}>
              <T v="money" color={item.owed > 0n ? c.negative : c.text}>{item.owed > 0n ? m(item.owed) : item.owed < 0n ? `${m(-item.owed)} advance` : "Settled"}</T>
              {item.waiting ? <Badge text={linked ? "Waiting to upload" : "On this phone"} tone="neutral" /> : null}
            </View>
          </Tap>
        )} />
    </Screen>
  );
}

function Detail({ id, onBack, newBill, edit }: { id: string; onBack: () => void; newBill: () => void; edit: () => void }) {
  const { db, currency, linked, online, changed, syncNow } = useApp();
  const c = usePalette();
  const sup = useLocal((d) => getSupplier(d, id), null as Supplier | null, [id]);
  const row = useLocal((d) => suppliersWithOwed(d).then((r) => r.find((x) => x.id === id) ?? null), null as SupplierRow | null, [id]);
  const bills = useLocal((d) => purchasesForSupplier(d, id), [] as Purchase[], [id]);
  const pays = useLocal((d) => paymentsForSupplier(d, id), [] as SupplierPayment[], [id]);
  const [paying, setPaying] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const m = (x: bigint) => formatMinor(x, currency);
  const kick = () => { changed(); if (linked && online) void syncNow(); };

  async function savePayment() {
    const minor = amountOk(amount);
    if (minor == null) { setErr("Enter the amount, for example 2,500 or 1,250.50."); return; }
    if (!db) return;
    await addSupplierPayment(db, { id: uid(), supplierId: id, amount: minorToString(minor), method, note, paidAt: nowMs() }, nowMs());
    setAmount(""); setNote(""); setPaying(false); setErr(null); kick();
  }
  function removeBill(b: Purchase) {
    Alert.alert("Delete this bill?", `${b.bill_no || "Bill"} for ${m(parseMinor(b.total))}. It hasn't reached your books yet; the goods come back off your stock.`, [
      { text: "Keep it", style: "cancel" }, { text: "Delete", style: "destructive", onPress: () => { if (db) void deletePurchase(db, b.id).then(changed).catch((e: unknown) => Alert.alert("Not deleted", e instanceof Error ? e.message : "Try again.")); } },
    ]);
  }
  if (!sup) return <Screen><Header title="Supplier" onBack={onBack} /></Screen>;
  const owed = row?.owed ?? 0n;
  type Entry = { at: number; key: string; node: React.ReactNode };
  const entries: Entry[] = [
    ...bills.map((b) => ({ at: b.bill_date, key: `b${b.id}`, node: (
      <View style={{ padding: space.lg, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}><T v="strong" numberOfLines={1}>Bill{b.bill_no ? ` ${b.bill_no}` : ""}</T><T v="small" muted>{dateText(b.bill_date)} · {b.payload.lines.length} item{b.payload.lines.length === 1 ? "" : "s"}{b.doc_number ? ` · ${b.doc_number}` : ""}</T></View>
          <View style={{ alignItems: "flex-end", gap: 4 }}><T v="money">{m(parseMinor(b.total))}</T>{b.state === "synced" ? <Badge text="In your books" tone="good" /> : b.state === "failed" ? <Badge text="Needs attention" tone="bad" /> : <Badge text={linked ? "Waiting to upload" : "On this phone"} tone="neutral" />}</View>
        </View>
        {b.state === "failed" ? <T v="small" color={c.negative}>{b.error ?? "The server refused this bill."}</T> : null}
        <View style={{ flexDirection: "row", gap: 16 }}>
          {b.state === "failed" ? <Tap label="Try again" onPress={() => { if (db) void retryPurchase(db, b.id).then(kick); }} style={{ minHeight: 44, justifyContent: "center" }}><T v="small" color={c.accent}>Try again</T></Tap> : null}
          {canDeletePurchase(b) ? <Tap label="Delete bill" onPress={() => removeBill(b)} style={{ minHeight: 44, justifyContent: "center" }}><T v="small" color={c.negative}>Delete</T></Tap> : null}
        </View>
      </View>) })),
    ...pays.filter((p) => !p.purchase_id).map((p) => ({ at: p.paid_at, key: `p${p.id}`, node: (
      <View style={{ padding: space.lg, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1 }}><T v="strong">Payment</T><T v="small" muted numberOfLines={1}>{dateText(p.paid_at)} · {methodLabel(p.method)}{p.note ? ` · ${p.note}` : ""}</T></View>
          <View style={{ alignItems: "flex-end", gap: 4 }}><T v="money" color={c.positive}>−{m(parseMinor(p.amount))}</T>{p.state === "synced" ? <Badge text="In your books" tone="good" /> : p.state === "failed" ? <Badge text="Needs attention" tone="bad" /> : <Badge text={linked ? "Waiting to upload" : "On this phone"} tone="neutral" />}</View>
        </View>
        {p.state === "failed" ? <T v="small" color={c.negative}>{p.error ?? "The server refused this payment."}</T> : null}
        {p.state !== "synced" ? (
          <View style={{ flexDirection: "row", gap: 16 }}>
            {p.state === "failed" ? <Tap label="Try again" onPress={() => { if (db) void retrySupplierPayment(db, p.id).then(kick); }} style={{ minHeight: 44, justifyContent: "center" }}><T v="small" color={c.accent}>Try again</T></Tap> : null}
            <Tap label="Delete payment" onPress={() => { if (db) void deleteUnsyncedSupplierPayment(db, p.id).then(changed); }} style={{ minHeight: 44, justifyContent: "center" }}><T v="small" color={c.negative}>Delete</T></Tap>
          </View>
        ) : null}
      </View>) })),
  ].sort((a, b) => b.at - a.at);

  return (
    <Screen>
      <Header title={sup.name} onBack={onBack} sub={sup.phone || undefined}
        right={<View style={{ flexDirection: "row", gap: 8 }}>
          {sup.phone ? <IconButton name="call-outline" label={`Call ${sup.name}`} onPress={() => void Linking.openURL(`tel:${sup.phone}`)} /> : null}
          {sup.origin === "local" && !sup.pushed ? <IconButton name="create-outline" label="Edit supplier" onPress={edit} /> : null}
        </View>} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 40, paddingTop: space.xs }}>
        <Card style={{ gap: 4 }}>
          <T v="label" muted>{owed < 0n ? "Paid in advance" : "You owe"}</T>
          <T v="moneyLg" adjustsFontSizeToFit numberOfLines={1} color={owed > 0n ? c.negative : c.text}>{m(owed < 0n ? -owed : owed)}</T>
          {row?.waiting ? <T v="small" muted>{linked ? "Includes work not yet uploaded." : "Counted on this phone only."}</T> : null}
        </Card>
        <View style={{ flexDirection: "row", gap: space.md }}>
          <Button title="Add a bill" icon="receipt-outline" onPress={newBill} style={{ flex: 1 }} />
          <Button title="Pay supplier" kind="quiet" icon="cash-outline" onPress={() => setPaying(true)} style={{ flex: 1 }} />
        </View>
        {paying ? (
          <Card style={{ gap: space.md }}>
            <Field label="Amount" value={amount} onChangeText={(v) => { setAmount(v); setErr(null); }} keyboardType="decimal-pad" placeholder="0.00" error={err} autoFocus />
            <Label>Paid by</Label>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{METHODS.map((x) => <Chip key={x.key} title={x.label} active={method === x.key} onPress={() => setMethod(x.key)} />)}</View>
            <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="Cheque number, UPI reference…" />
            <Button title="Save payment" icon="checkmark-circle-outline" onPress={() => void savePayment()} />
            <Button title="Cancel" kind="quiet" onPress={() => { setPaying(false); setErr(null); }} />
          </Card>
        ) : null}
        {entries.length === 0 ? <Card><Empty icon="receipt-outline" title="No bills or payments yet" hint="Record a bill when goods arrive; the stock goes up and it counts as owed until you pay." /></Card> : (
          <Card style={{ padding: 0 }}>
            {entries.map((e, i) => <React.Fragment key={e.key}>{i > 0 ? <Divider /> : null}{e.node}</React.Fragment>)}
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}

function NewBill({ supplierId, onBack, done, addSupplier }: { supplierId: string | null; onBack: () => void; done: (supplierId: string) => void; addSupplier: () => void }) {
  const { db, currency, linked, online, changed, syncNow } = useApp();
  const c = usePalette();
  const [supId, setSupId] = useState<string | null>(supplierId);
  const [billNo, setBillNo] = useState("");
  const [note, setNote] = useState("");
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<PurchaseLine[]>([]);
  const [paid, setPaid] = useState("");
  const [method, setMethod] = useState("CASH");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const suppliers = useLocal((d) => suppliersWithOwed(d), [] as SupplierRow[]);
  const results = useLocal((d) => searchProducts(d, q, 8), [] as Product[], [q]);
  const m = (x: bigint) => formatMinor(x, currency);
  const chosen = suppliers.find((s) => s.id === supId) ?? null;
  const total = billMinor(lines.filter((l) => parseDec(l.qty) != null && parseDec(l.cost) != null));
  const paidMinor = paid.trim() === "" ? 0n : amountOk(paid) ?? -1n;
  const lineErr = lines.some((l) => !(dec(l.qty) > 0n) || parseDec(l.cost) == null);

  function addProduct(p: Product) {
    setLines((ls) => ls.some((l) => l.variantId === p.variant_id) ? ls : [...ls, { variantId: p.variant_id, unitId: p.unit_id, name: p.name, qty: "1", cost: "" }]);
    setQ(""); setErr(null);
  }
  const setLine = (i: number, patch: Partial<PurchaseLine>) => setLines((ls) => ls.map((l, k) => k === i ? { ...l, ...patch } : l));

  async function save() {
    if (!db || busy) return;
    if (!supId) { setErr("Choose the supplier."); return; }
    if (lines.length === 0) { setErr("Add at least one item."); return; }
    if (lineErr) { setErr("Every item needs a quantity and a cost price."); return; }
    if (paidMinor < 0n) { setErr("Enter the amount paid, for example 500 or 1,250.50, or leave it empty."); return; }
    setBusy(true); setErr(null);
    try {
      await savePurchase(db, { id: uid(), supplierId: supId, billNo, billDate: nowMs(), note, lines, paid: paidMinor > 0n ? { amount: minorToString(paidMinor), method } : null }, nowMs());
      changed();
      if (linked && online) void syncNow();
      done(supId);
    } catch (e) { setErr(e instanceof Error ? e.message : "Couldn't save the bill. Nothing was lost; try again."); }
    finally { setBusy(false); }
  }

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 60 }}>
        <Header title="New supplier bill" onBack={onBack} sub="Saving it adds the goods to your stock and to what you owe." />
        <View style={{ padding: space.lg, gap: space.lg, paddingTop: space.xs }}>
          <View style={{ gap: 8 }}>
            <Label>Supplier</Label>
            {chosen ? (
              <Tap label={`Supplier: ${chosen.name}. Change`} onPress={() => setSupId(null)} style={{ minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: c.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: c.border, paddingHorizontal: space.lg }}>
                <Icon name="business-outline" size={20} color={c.accent} /><T v="strong" style={{ flex: 1 }} numberOfLines={1}>{chosen.name}</T><T v="small" color={c.accent}>Change</T>
              </Tap>
            ) : (
              <Card style={{ padding: 0 }}>
                {suppliers.length === 0 ? <View style={{ padding: space.lg }}><T v="small" muted>No suppliers yet.</T></View> : suppliers.slice(0, 8).map((s, i) => (
                  <React.Fragment key={s.id}>{i > 0 ? <Divider /> : null}<Tap label={s.name} onPress={() => { setSupId(s.id); setErr(null); }} style={{ minHeight: 52, padding: space.lg, justifyContent: "center" }}><T v="strong" numberOfLines={1}>{s.name}</T></Tap></React.Fragment>
                ))}
                <Divider />
                <Tap label="Add a new supplier" onPress={addSupplier} style={{ minHeight: 52, padding: space.lg, flexDirection: "row", alignItems: "center", gap: 10 }}><Icon name="person-add-outline" size={18} color={c.accent} /><T v="strong" color={c.accent}>Add a new supplier</T></Tap>
              </Card>
            )}
          </View>
          <Field label="Supplier's bill number (optional)" value={billNo} onChangeText={setBillNo} autoCapitalize="characters" />

          <View style={{ gap: 8 }}>
            <Label>Items received</Label>
            <View style={{ flexDirection: "row", alignItems: "center", backgroundColor: c.surface, borderRadius: radius.md + 2, borderWidth: 1, borderColor: c.borderStrong, paddingLeft: 14 }}>
              <Icon name="search" size={20} color={c.faint} />
              <TextInput accessibilityLabel="Search items to add" value={q} onChangeText={setQ} placeholder="Search your items" placeholderTextColor={c.faint}
                style={{ flex: 1, minHeight: 50, paddingHorizontal: 10, fontSize: 16, color: c.text, fontFamily: fonts.body }} />
            </View>
            {q.trim() ? (
              <Card style={{ padding: 0 }}>
                {results.length === 0 ? <View style={{ padding: space.lg }}><T v="small" muted>No item matches. Add it under Items &amp; stock first.</T></View> : results.map((p, i) => (
                  <React.Fragment key={p.variant_id}>{i > 0 ? <Divider /> : null}
                    <Tap label={`Add ${p.name}`} onPress={() => addProduct(p)} style={{ minHeight: 52, padding: space.lg, flexDirection: "row", alignItems: "center", gap: 10 }}>
                      <T v="strong" style={{ flex: 1 }} numberOfLines={1}>{p.name}</T>{p.stock != null ? <T v="small" muted>{p.stock} in stock</T> : null}
                    </Tap></React.Fragment>
                ))}
              </Card>
            ) : null}
            {lines.map((l, i) => (
              <Card key={l.variantId} style={{ gap: space.sm }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                  <T v="strong" style={{ flex: 1 }} numberOfLines={2}>{l.name}</T>
                  <IconButton name="close" label={`Remove ${l.name}`} onPress={() => setLines((ls) => ls.filter((_, k) => k !== i))} />
                </View>
                <View style={{ flexDirection: "row", gap: space.md }}>
                  <View style={{ flex: 1 }}><Field label="Quantity" value={l.qty} onChangeText={(v) => setLine(i, { qty: v })} keyboardType="decimal-pad" /></View>
                  <View style={{ flex: 1 }}><Field label="Cost each" value={l.cost} onChangeText={(v) => setLine(i, { cost: v })} keyboardType="decimal-pad" placeholder="0.00" /></View>
                </View>
                <T v="small" muted style={{ textAlign: "right" }}>{parseDec(l.qty) != null && parseDec(l.cost) != null ? m(lineMinor(l)) : "—"}</T>
              </Card>
            ))}
          </View>

          <Card style={{ gap: space.md }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}><T v="label" muted>Bill total</T><T v="moneyLg">{m(total)}</T></View>
            <Field label="Paid now (optional)" value={paid} onChangeText={(v) => { setPaid(v); setErr(null); }} keyboardType="decimal-pad" placeholder="0.00" hint="Leave empty if you will pay later." />
            {paid.trim() ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{METHODS.map((x) => <Chip key={x.key} title={x.label} active={method === x.key} onPress={() => setMethod(x.key)} />)}</View> : null}
            <Field label="Note (optional)" value={note} onChangeText={setNote} />
          </Card>
          {err ? <T v="small" color={c.negative}>{err}</T> : null}
          <Button title="Save bill" icon="checkmark-circle-outline" onPress={() => void save()} busy={busy} disabled={lines.length === 0} />
        </View>
      </ScrollView>
    </Screen>
  );
}

function SupplierEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { db, changed } = useApp();
  const c = usePalette();
  const [f, setF] = useState({ name: "", phone: "", gstin: "" });
  const [err, setErr] = useState<string | null>(null);
  const [existing, setExisting] = useState<Supplier | null>(null);
  useEffect(() => { if (id && db) void getSupplier(db, id).then((s) => { if (s) { setExisting(s); setF({ name: s.name, phone: s.phone, gstin: s.gstin }); } }); }, [id, db]);
  async function save() {
    if (!db) return;
    if (!f.name.trim()) { setErr("Enter the supplier's name."); return; }
    if (existing) await updateSupplier(db, existing.id, f); else await createSupplier(db, uid(), f, nowMs());
    changed(); onClose();
  }
  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
            <Header title={existing ? "Supplier" : "New supplier"} onBack={onClose} />
            <View style={{ padding: space.lg, gap: space.lg }}>
              <Field label="Name" value={f.name} onChangeText={(v) => { setF({ ...f, name: v }); setErr(null); }} autoCapitalize="words" error={err} />
              <Field label="Phone" value={f.phone} onChangeText={(v) => setF({ ...f, phone: v })} keyboardType="phone-pad" />
              <Field label="GSTIN (optional)" value={f.gstin} onChangeText={(v) => setF({ ...f, gstin: v.toUpperCase() })} autoCapitalize="characters" autoCorrect={false} />
              <Button title={existing ? "Save changes" : "Add supplier"} onPress={() => void save()} icon="checkmark" />
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}
