import React, { useState } from "react";
import { Alert, FlatList, ScrollView, View } from "react-native";
import { addExpense, deleteUnsyncedExpense, getExpenseCategories, listExpenses, retryExpense, DEFAULT_EXPENSE_CATEGORIES, type Expense, type ExpenseCategory } from "../db/repo";
import { parseExpenseAmount, monthTotalMinor } from "../lib/expenses";
import { minorToString, parseMinor } from "../lib/decimal";
import { nowMs, useLocal } from "../lib/hooks";
import { formatMinor } from "../lib/money";
import { uid } from "../state/app";
import { useApp } from "../state/app";
import { space, usePalette } from "../theme";
import { Badge, Button, Card, Chip, Divider, Empty, Field, Header, Label, Screen, Tap } from "../ui/kit";
import { T } from "../ui/text";

/** Expenses: money the business spent (rent, fuel, a courier). Each one is uploaded to the books once, whatever the connection does. */
export function Expenses({ onBack }: { onBack: () => void }) {
  const { db, currency, linked, changed, syncNow, online } = useApp();
  const c = usePalette();
  const rows = useLocal((d) => listExpenses(d), [] as Expense[]);
  const cats = useLocal((d) => getExpenseCategories(d), DEFAULT_EXPENSE_CATEGORIES);
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [cat, setCat] = useState<ExpenseCategory | null>(null);
  const [method, setMethod] = useState<"CASH" | "BANK">("CASH");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const m = (x: bigint) => formatMinor(x, currency);
  const chosen = cat ?? cats[0]!;
  const month = monthTotalMinor(rows, nowMs());

  async function save() {
    const minor = parseExpenseAmount(amount);
    if (minor == null) { setErr("Enter the amount, for example 250 or 1,250.50."); return; }
    if (!db || busy) return;
    setBusy(true); setErr(null);
    try {
      await addExpense(db, { id: uid(), at: nowMs(), category: chosen, amount: minorToString(minor), method, note: note.trim() }, nowMs());
      setAmount(""); setNote(""); setAdding(false); changed();
      if (linked && online) void syncNow();
    } finally { setBusy(false); }
  }
  function remove(e: Expense) {
    Alert.alert("Delete this expense?", `${e.category_name}, ${m(parseMinor(e.amount))}. It has not reached your books yet.`, [
      { text: "Keep it", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => { if (db) void deleteUnsyncedExpense(db, e.id).then(changed); } },
    ]);
  }

  return (
    <Screen>
      <Header title="Expenses" onBack={onBack} sub={linked ? "Each one is added to your books once, even if the connection drops." : "Saved on this phone. Connect a server from More to add them to your books."} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.lg, gap: space.md, paddingBottom: 40 }}>
        <Card style={{ gap: 4 }}>
          <T v="label" muted>Spent this month</T>
          <T v="moneyLg" adjustsFontSizeToFit numberOfLines={1}>{m(month)}</T>
        </Card>
        {adding ? (
          <Card style={{ gap: space.md }}>
            <Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" error={err} autoFocus />
            <Label>Category</Label>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{cats.map((x) => <Chip key={x.code} title={x.name} active={chosen.code === x.code} onPress={() => setCat(x)} />)}</View>
            <Label>Paid from</Label>
            <View style={{ flexDirection: "row", gap: 8 }}><Chip title="Cash" active={method === "CASH"} onPress={() => setMethod("CASH")} /><Chip title="Bank" active={method === "BANK"} onPress={() => setMethod("BANK")} /></View>
            <Field label="Note (optional)" value={note} onChangeText={setNote} placeholder="What was it for?" />
            <Button title="Save expense" icon="checkmark-circle-outline" onPress={() => void save()} busy={busy} />
            <Button title="Cancel" kind="quiet" onPress={() => { setAdding(false); setErr(null); }} />
          </Card>
        ) : <Button title="Add an expense" icon="add-circle-outline" onPress={() => setAdding(true)} />}

        {rows.length === 0 ? <Card><Empty icon="wallet-outline" title="No expenses yet" hint="Rent, fuel, a courier: add what the business spends so your profit is honest." /></Card> : (
          <Card style={{ padding: 0 }}>
            <FlatList scrollEnabled={false} data={rows} keyExtractor={(e) => e.id} ItemSeparatorComponent={Divider}
              renderItem={({ item: e }) => (
                <View style={{ padding: space.lg, gap: 6 }}>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <T v="strong" numberOfLines={1}>{e.category_name}</T>
                      <T v="small" muted numberOfLines={1}>{new Date(e.at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })} · {e.method === "BANK" ? "Bank" : "Cash"}{e.note ? ` · ${e.note}` : ""}</T>
                    </View>
                    <View style={{ alignItems: "flex-end", gap: 4 }}>
                      <T v="money">{m(parseMinor(e.amount))}</T>
                      {e.state === "synced" ? <Badge text="In your books" tone="good" /> : e.state === "failed" ? <Badge text="Needs attention" tone="bad" /> : <Badge text={linked ? "Waiting to upload" : "On this phone"} tone="neutral" />}
                    </View>
                  </View>
                  {e.state === "failed" ? <T v="small" color={c.negative}>{e.error ?? "The server refused this expense."}</T> : null}
                  {e.state !== "synced" ? (
                    <View style={{ flexDirection: "row", gap: 16 }}>
                      {e.state === "failed" ? <Tap label="Try again" onPress={() => { if (db) void retryExpense(db, e.id).then(() => { changed(); if (linked && online) void syncNow(); }); }} style={{ minHeight: 44, justifyContent: "center" }}><T v="small" color={c.accent}>Try again</T></Tap> : null}
                      <Tap label="Delete expense" onPress={() => remove(e)} style={{ minHeight: 44, justifyContent: "center" }}><T v="small" color={c.negative}>Delete</T></Tap>
                    </View>
                  ) : null}
                </View>
              )} />
          </Card>
        )}
      </ScrollView>
    </Screen>
  );
}
