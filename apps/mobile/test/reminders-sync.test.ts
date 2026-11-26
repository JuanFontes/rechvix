import assert from "node:assert/strict";
import { test } from "node:test";
import { addReminder, setReminderStatus } from "../src/db/repo";
import { migrate } from "../src/db/schema";
import { pushReminders, serverChannel } from "../src/sync/reminders";
import { memoryDb } from "./nodedb";

const apiStub = (calls: unknown[]) => ({ post: async (_p: string, body: unknown) => { calls.push(body); return {}; } }) as never;

test("channels map to the server's names", () => {
  assert.equal(serverChannel("whatsapp"), "whatsapp");
  assert.equal(serverChannel("pdf"), "share");
  assert.equal(serverChannel("manual"), "other");
});

test("a reminder about a customer the server knows is uploaded once, and a later status is a new entry", async () => {
  const db = await memoryDb(); await migrate(db);
  await db.run("INSERT INTO parties(id,name,phone,type,origin) VALUES('srv-1','Asha','9811111111','CUSTOMER','server')");
  const id = await addReminder(db, "srv-1", Date.UTC(2026, 10, 26), "whatsapp", { status: "share_opened", withPdf: true, outstanding: "1234.50" });
  const calls: Record<string, unknown>[] = [];
  const first = await pushReminders(apiStub(calls), db);
  assert.equal(first.sent, 1);
  assert.deepEqual({ ref: calls[0]!.client_ref, status: calls[0]!.status, pdf: calls[0]!.with_pdf, party: calls[0]!.party_id }, { ref: `mobile:rem:${id}:share_opened`, status: "share_opened", pdf: true, party: "srv-1" });
  assert.equal((await pushReminders(apiStub(calls), db)).sent, 0);        // nothing left to send
  await setReminderStatus(db, id, "marked_sent");
  assert.equal((await pushReminders(apiStub(calls), db)).sent, 1);        // the new status goes up as its own entry
  assert.equal(calls[1]!.client_ref, `mobile:rem:${id}:marked_sent`);
});

test("a reminder about a customer only on this phone waits", async () => {
  const db = await memoryDb(); await migrate(db);
  await db.run("INSERT INTO parties(id,name,phone,type,origin) VALUES('loc-1','Ravi','','CUSTOMER','local')");
  await addReminder(db, "loc-1", Date.now(), "share", { status: "share_opened" });
  const calls: unknown[] = [];
  const r = await pushReminders(apiStub(calls), db);
  assert.deepEqual({ sent: r.sent, waiting: r.waiting, posted: calls.length }, { sent: 0, waiting: 1, posted: 0 });
});
