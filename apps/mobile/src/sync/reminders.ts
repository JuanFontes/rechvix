import { ApiError, NetworkError, type Api } from "../api/client";
import { getSale, mapGet } from "../db/repo";
import type { Db } from "../db/types";

interface Row { id: number; party_id: string; at: number; channel: string; sale_local_id: string | null; status: string; with_pdf: number; outstanding: string | null }

/** The phone's channel names mapped to the server's. Anything unknown is "other". */
export const serverChannel = (c: string): "whatsapp" | "share" | "other" => (c === "whatsapp" ? "whatsapp" : c === "share" || c === "pdf" ? "share" : "other");

/** Uploads reminder hand-offs to the server's reminder history (POST /reminders/activity).
 *
 *  Only reminders about a customer the server already knows are sent; the rest wait for the customer to sync. Each status of a reminder
 *  (share opened, then marked as sent, say) is its own entry with its own `client_ref`, so repeating an upload can never double a row, and
 *  a status change after upload is sent as a new entry. The server never records "delivered": neither does the phone. */
export async function pushReminders(api: Api, db: Db): Promise<{ sent: number; waiting: number }> {
  const out = { sent: 0, waiting: 0 };
  const rows = await db.all<Row>("SELECT id, party_id, at, channel, sale_local_id, status, with_pdf, outstanding FROM reminders WHERE synced_status IS NULL OR synced_status <> status ORDER BY id LIMIT 200");
  for (const r of rows) {
    const mapped = await mapGet(db, "party", r.party_id);
    const isLocal = !mapped && !!(await db.first("SELECT 1 FROM parties WHERE id=? AND origin='local'", [r.party_id]));
    if (isLocal) { out.waiting++; continue; }
    let docId: string | null = null;
    if (r.sale_local_id) {
      const sale = await getSale(db, r.sale_local_id);
      if (!sale || !sale.progress.finalized || !sale.progress.docId) { out.waiting++; continue; }
      docId = sale.progress.docId;
    }
    try {
      await api.post("/reminders/activity", {
        party_id: mapped?.serverId ?? r.party_id,
        ...(docId ? { sales_document_id: docId } : {}),
        channel: serverChannel(r.channel), status: r.status, with_pdf: r.with_pdf === 1,
        ...(r.outstanding ? { outstanding: r.outstanding } : {}),
        client_ref: `mobile:rem:${r.id}:${r.status}`,
        occurred_at: new Date(r.at).toISOString(),
      });
      await db.run("UPDATE reminders SET synced_status=? WHERE id=?", [r.status, r.id]);
      out.sent++;
    } catch (e) {
      if (e instanceof NetworkError || (e instanceof ApiError && e.status === 401)) throw e;
      // A refusal (e.g. an older server without this endpoint, or a permission) must not block payments and sales: leave the row and move on.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) { out.waiting++; continue; }
      throw e;
    }
  }
  return out;
}
