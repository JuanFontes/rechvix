import { ApiError, NetworkError, type Api } from "../api/client";
import { markExpenseFailed, markExpenseSynced, pendingExpenses } from "../db/repo";
import type { Db } from "../db/types";
import { journalFor } from "../lib/expenses";

/** Uploads expenses as manual journals. Every journal carries `client_ref = mobile:exp:<id>`, and the server returns the journal it already
 *  booked for that reference instead of posting again, so a dropped connection, a killed app or a double sync can only ever book an expense
 *  once. A refusal (4xx) marks the expense failed with the server's message for a person to fix; network and server errors are retried. */
export async function pushExpenses(api: Api, db: Db): Promise<{ posted: number; failed: number }> {
  const out = { posted: 0, failed: 0 };
  for (const e of await pendingExpenses(db)) {
    try {
      const j = await api.post<{ ID: string }>("/accounting/journals", {
        source_type: "manual_expense", journal_date: new Date(e.at).toISOString(), description: e.note.trim() || e.category_name,
        client_ref: `mobile:exp:${e.id}`, lines: journalFor(e),
      });
      await markExpenseSynced(db, e.id, j.ID);
      out.posted++;
    } catch (err) {
      if (err instanceof NetworkError || (err instanceof ApiError && err.status === 401)) throw err;
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429) {
        await markExpenseFailed(db, e.id, err.message, e.attempts + 1); out.failed++;
      } else if (e.attempts + 1 >= 5) {
        await markExpenseFailed(db, e.id, err instanceof Error ? err.message : "Server error", e.attempts + 1); out.failed++;
      } else {
        await db.run("UPDATE expenses SET attempts=attempts+1, error=? WHERE id=?", [err instanceof Error ? err.message : "Server error", e.id]);
        throw err;
      }
    }
  }
  return out;
}
