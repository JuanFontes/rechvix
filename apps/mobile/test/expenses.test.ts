import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, NetworkError } from "../src/api/client";
import { addExpense, getExpenseCategories, listExpenses, retryExpense, setExpenseCategories, deleteUnsyncedExpense, DEFAULT_EXPENSE_CATEGORIES } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import { journalFor, monthTotalMinor, parseExpenseAmount } from "../src/lib/expenses";
import { pushExpenses } from "../src/sync/expenses";
import { memoryDb } from "./nodedb";

const cat = { code: "5990", name: "General expenses" };
const NOW = Date.UTC(2026, 10, 27, 10);

test("amounts parse to exact minor units and reject anything doubtful", () => {
  assert.equal(parseExpenseAmount("250"), 25000n);
  assert.equal(parseExpenseAmount("1,250.5"), 125050n);
  for (const bad of ["", "0", "0.00", "-5", "12.345", "abc", "1.2.3"]) assert.equal(parseExpenseAmount(bad), null, bad);
});

test("the journal debits the category and credits cash or bank by the same amount", () => {
  const lines = journalFor({ category_code: "5990", category_name: "General expenses", amount: "250.00", method: "BANK", note: " courier " });
  assert.deepEqual(lines.map((l) => [l.account_code, l.debit, l.credit]), [["5990", "250.00", "0"], ["1010", "0", "250.00"]]);
  assert.equal(lines[0]!.description, "courier");
  assert.equal(journalFor({ category_code: "5990", category_name: "General expenses", amount: "1.00", method: "CASH", note: "" })[1]!.account_code, "1000");
});

test("the month total counts only this month", async () => {
  const db = await memoryDb(); await migrate(db);
  await addExpense(db, { id: "a", at: NOW, category: cat, amount: "100.00", method: "CASH", note: "" }, NOW);
  await addExpense(db, { id: "b", at: NOW - 40 * 86_400_000, category: cat, amount: "999.00", method: "CASH", note: "" }, NOW);
  assert.equal(monthTotalMinor(await listExpenses(db), NOW), 10000n);
});

test("an upload carries a client_ref and books once; a retry after a dropped connection reuses the same reference", async () => {
  const db = await memoryDb(); await migrate(db);
  await addExpense(db, { id: "e1", at: NOW, category: cat, amount: "250.00", method: "CASH", note: "courier" }, NOW);
  const seen: Record<string, unknown>[] = [];
  let drop = true;
  const api = { post: async (_p: string, body: Record<string, unknown>) => { seen.push(body); if (drop) { drop = false; throw new NetworkError("offline"); } return { ID: "j-1" }; } } as never;
  await assert.rejects(() => pushExpenses(api, db), NetworkError);           // the connection dropped: still waiting
  assert.equal((await listExpenses(db))[0]!.state, "pending");
  const r = await pushExpenses(api, db);                                       // the retry
  assert.deepEqual(r, { posted: 1, failed: 0 });
  assert.equal(seen.length, 2); assert.equal(seen[0]!.client_ref, "mobile:exp:e1"); assert.equal(seen[1]!.client_ref, "mobile:exp:e1");
  const row = (await listExpenses(db))[0]!;
  assert.deepEqual({ state: row.state, journal: row.server_journal_id }, { state: "synced", journal: "j-1" });
  assert.deepEqual(await pushExpenses(api, db), { posted: 0, failed: 0 });   // nothing left to send
  assert.equal(seen.length, 2);
});

test("a refused expense is marked failed with the server's message, can be retried, and a synced one cannot be deleted", async () => {
  const db = await memoryDb(); await migrate(db);
  await addExpense(db, { id: "e2", at: NOW, category: { code: "9999", name: "Unknown" }, amount: "10.00", method: "CASH", note: "" }, NOW);
  const refuse = { post: async () => { throw new ApiError(404, "ACCOUNT_NOT_FOUND", "That account was not found."); } } as never;
  assert.deepEqual(await pushExpenses(refuse, db), { posted: 0, failed: 1 });
  const failed = (await listExpenses(db))[0]!;
  assert.equal(failed.state, "failed"); assert.match(failed.error!, /account was not found/);
  await retryExpense(db, "e2"); assert.equal((await listExpenses(db))[0]!.state, "pending");
  await db.run("UPDATE expenses SET state='synced' WHERE id='e2'");
  await deleteUnsyncedExpense(db, "e2"); assert.equal((await listExpenses(db)).length, 1, "an expense in the books is never erased from here");
});

test("categories default to General expenses until the server's are stored", async () => {
  const db = await memoryDb(); await migrate(db);
  assert.deepEqual(await getExpenseCategories(db), DEFAULT_EXPENSE_CATEGORIES);
  await setExpenseCategories(db, [{ code: "6100", name: "Rent" }]);
  assert.deepEqual(await getExpenseCategories(db), [{ code: "6100", name: "Rent" }]);
});
