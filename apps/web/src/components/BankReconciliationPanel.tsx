import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../lib/api-client";
import { parseStatementCsv, type DateOrder } from "../lib/bankStatement";
import layout from "../pages/DashboardPage.module.css";
import ui from "./ui.module.css";

interface BankAccount { ID: string; Name: string; Kind: "BANK" | "CASH"; IsActive: boolean; CurrencyCode?: string }
interface Candidate { kind: "RECEIPT" | "PAYMENT"; id: string; amount: string; date: string; reference: string; party: string }
interface Line { id: string; date: string; description: string; reference: string; amount: string; status: "UNMATCHED" | "MATCHED" | "IGNORED"; matched_kind?: string; note?: string; candidates?: Candidate[] }
interface Summary { unmatched: number; matched: number; ignored: number; unmatched_in: string; unmatched_out: string; statement_net: string; lines_total: number; ready_to_sign_off: boolean }
interface Listing { lines: Line[]; summary: Summary }
type Filter = "UNMATCHED" | "MATCHED" | "IGNORED" | "";

const FILTERS: { key: Filter; label: string }[] = [{ key: "UNMATCHED", label: "Needs matching" }, { key: "MATCHED", label: "Matched" }, { key: "IGNORED", label: "Ignored" }, { key: "", label: "All" }];

/** Display only: the exact decimal string comes from the server and goes back to it untouched. */
const show = (s: string) => Number(s).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

/** Checks a bank statement against the receipts and supplier payments already booked. Matching posts nothing: it only records that the
 *  bank agrees with the books. A bank line with nothing behind it is not posted for you; record the missing receipt, payment or expense first,
 *  or ignore the line with a reason. */
export function BankReconciliationPanel() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["bank-accounts"], queryFn: () => api.get<BankAccount[]>("/accounting/bank-accounts") });
  const banks = (accounts.data ?? []).filter((a) => a.Kind === "BANK" && a.IsActive);
  const [picked, setPicked] = useState("");
  const bank = banks.find((b) => b.ID === picked) ?? banks[0];
  const [filter, setFilter] = useState<Filter>("UNMATCHED");
  const [order, setOrder] = useState<DateOrder>("dmy");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [pickerKey, setPickerKey] = useState(0);   // remounts the file input so it forgets the old file name
  const clearFile = () => { setFile(null); setPickerKey((k) => k + 1); };
  const [ignoring, setIgnoring] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const key = ["bank-statement-lines", bank?.ID, filter];
  const lines = useQuery({
    queryKey: key, enabled: !!bank,
    queryFn: () => api.get<Listing>(`/accounting/bank-accounts/${bank!.ID}/statement-lines?status=${filter}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["bank-statement-lines", bank?.ID] });

  const parsed = file ? parseStatementCsv(file.text, order) : null;

  const importLines = useMutation({
    mutationFn: () => api.post<{ added: number; duplicates: number }>(`/accounting/bank-accounts/${bank!.ID}/statement-lines`, { lines: parsed!.lines }),
    onSuccess: (r) => { setNote({ ok: true, text: `${r.added} line${r.added === 1 ? "" : "s"} added${r.duplicates ? `, ${r.duplicates} already loaded earlier and skipped` : ""}.` }); clearFile(); refresh(); },
    onError: (e) => setNote({ ok: false, text: msg(e) }),
  });
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: "match" | "unmatch" | "ignore" | "unignore"; body?: unknown }) => api.post(`/accounting/bank-statement-lines/${id}/${action}`, body),
    onSuccess: () => { setNote(null); setIgnoring(null); setReason(""); refresh(); },
    onError: (e) => setNote({ ok: false, text: msg(e) }),
  });

  const s = lines.data?.summary;
  return (
    <div className={layout.panel} aria-labelledby="bank-rec-h">
      <h2 id="bank-rec-h">Bank reconciliation</h2>
      <p className={ui.muted}>Load your bank statement and match each line to a receipt or supplier payment you have already recorded. Matching changes no accounts. A line with no match is never posted for you.</p>

      {accounts.isError ? <p role="alert">{msg(accounts.error)}</p> : null}
      {accounts.isSuccess && banks.length === 0 ? <p>Add a bank account in Settings first, and record receipts and payments against it.</p> : null}

      {bank ? (
        <>
          <div className={ui.toolbar}>
            <label className={ui.field} style={{ minWidth: 220 }}>
              <span>Bank account</span>
              <select className={ui.select} value={bank.ID} onChange={(e) => { setPicked(e.target.value); setNote(null); }}>
                {banks.map((b) => <option key={b.ID} value={b.ID}>{b.Name}</option>)}
              </select>
            </label>
            <label className={ui.field}>
              <span>Statement file (CSV)</span>
              <input key={pickerKey} className={ui.input} type="file" accept=".csv,text/csv,text/plain" onChange={async (e) => {
                const f = e.target.files?.[0];
                setNote(null);
                if (!f) { setFile(null); return; }
                if (f.size > 4_000_000) { setFile(null); setNote({ ok: false, text: "That file is over 4 MB. Export a shorter date range." }); return; }
                setFile({ name: f.name, text: await f.text() });
              }} />
            </label>
            <label className={ui.field}>
              <span>Dates are written</span>
              <select className={ui.select} value={order} onChange={(e) => setOrder(e.target.value as DateOrder)}>
                <option value="dmy">day / month / year</option>
                <option value="mdy">month / day / year</option>
              </select>
            </label>
          </div>

          {parsed ? (
            <div role="status" style={{ margin: "var(--space-3) 0" }}>
              <p><strong>{parsed.lines.length}</strong> line{parsed.lines.length === 1 ? "" : "s"} read from {file!.name}{parsed.columns ? ` (columns: ${parsed.columns})` : ""}.{parsed.lines.length > 0 ? ` First: ${parsed.lines[0]!.date}, ${show(parsed.lines[0]!.amount)}.` : ""}</p>
              {parsed.errors.length > 0 ? (
                <details open={parsed.lines.length === 0}>
                  <summary>{parsed.errors.length} row{parsed.errors.length === 1 ? "" : "s"} could not be read and will be skipped</summary>
                  <ul>{parsed.errors.slice(0, 20).map((er) => <li key={er}>{er}</li>)}{parsed.errors.length > 20 ? <li>and {parsed.errors.length - 20} more</li> : null}</ul>
                </details>
              ) : null}
              <div className={ui.formActions}>
                <button type="button" className={ui.btnPrimary} disabled={parsed.lines.length === 0 || importLines.isPending} onClick={() => importLines.mutate()}>
                  {importLines.isPending ? "Adding…" : `Add ${parsed.lines.length} line${parsed.lines.length === 1 ? "" : "s"} to ${bank.Name}`}
                </button>
                <button type="button" className={ui.btnGhost} onClick={clearFile}>Cancel</button>
              </div>
              <p className={ui.muted}>Loading the same statement again is safe: lines already loaded are skipped.</p>
            </div>
          ) : null}

          {note ? <p role={note.ok ? "status" : "alert"} style={{ color: note.ok ? "var(--color-positive)" : "var(--color-negative)" }}>{note.text}</p> : null}

          {s && s.lines_total > 0 ? (
            <>
              <p style={{ margin: "var(--space-3) 0" }}>
                <strong>{s.unmatched}</strong> to match · <strong>{s.matched}</strong> matched · <strong>{s.ignored}</strong> ignored
                {s.unmatched > 0 ? <> · still unmatched: <strong>{show(s.unmatched_in)}</strong> in, <strong>{show(s.unmatched_out)}</strong> out</> : null}
              </p>
              {s.ready_to_sign_off ? <p role="status" style={{ color: "var(--color-positive)" }}>Every line is matched or ignored.</p> : null}
            </>
          ) : null}

          <nav className={ui.segmented} aria-label="Statement lines" style={{ margin: "var(--space-2) 0" }}>
            {FILTERS.map((f) => <button key={f.label} type="button" className={ui.segment} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>)}
          </nav>

          {lines.isLoading ? <p className={ui.muted}>Loading…</p> : lines.isError ? (
            <p role="alert">{msg(lines.error)} <button type="button" className={ui.btnGhost} onClick={() => void lines.refetch()}>Try again</button></p>
          ) : (lines.data?.lines.length ?? 0) === 0 ? (
            <p>{filter === "UNMATCHED" && s && s.lines_total > 0 ? "Nothing left to match." : "No statement lines here yet. Load a CSV above."}</p>
          ) : (
            <div className={ui.tableScroll} tabIndex={0}>
              <table className={ui.table}>
                <thead><tr><th scope="col">Date</th><th scope="col">Bank says</th><th scope="col" style={{ textAlign: "right" }}>Amount</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
                <tbody>
                  {lines.data!.lines.map((l) => (
                    <tr key={l.id}>
                      <td><time dateTime={l.date}>{l.date}</time></td>
                      <td>{l.description || "—"}{l.reference ? <span className={ui.muted}> · {l.reference}</span> : null}{l.note ? <div className={ui.muted}>Ignored: {l.note}</div> : null}</td>
                      <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: Number(l.amount) < 0 ? "var(--color-negative)" : undefined }}>{show(l.amount)}</td>
                      <td><span className={ui.badge} data-tone={l.status === "MATCHED" ? "positive" : l.status === "IGNORED" ? "neutral" : "warning"}>{l.status === "MATCHED" ? `Matched to ${l.matched_kind === "RECEIPT" ? "a receipt" : "a payment"}` : l.status === "IGNORED" ? "Ignored" : "Needs matching"}</span></td>
                      <td>
                        {l.status === "UNMATCHED" ? (
                          <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                            {(l.candidates ?? []).map((c) => (
                              <button key={c.id} type="button" className={ui.btnSecondary} disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: "match", body: { kind: c.kind, id: c.id } })}>
                                Match {c.kind === "RECEIPT" ? "receipt" : "payment"}{c.party ? ` · ${c.party}` : ""} · {c.date.slice(0, 10)}{c.reference ? ` · ${c.reference}` : ""}
                              </button>
                            ))}
                            {(l.candidates ?? []).length === 0 ? <span className={ui.muted}>No booked {Number(l.amount) > 0 ? "receipt" : "payment"} of {show(String(Math.abs(Number(l.amount))))} within a week of this date.</span> : null}
                            {ignoring === l.id ? (
                              <form onSubmit={(e) => { e.preventDefault(); act.mutate({ id: l.id, action: "ignore", body: { note: reason } }); }} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <input className={ui.input} aria-label="Why is this line ignored?" placeholder="Why? (required)" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={500} />
                                <button type="submit" className={ui.btnSecondary} disabled={reason.trim().length < 3 || act.isPending}>Ignore</button>
                                <button type="button" className={ui.btnGhost} onClick={() => { setIgnoring(null); setReason(""); }}>Cancel</button>
                              </form>
                            ) : <button type="button" className={ui.btnGhost} onClick={() => { setIgnoring(l.id); setReason(""); }}>Ignore…</button>}
                          </div>
                        ) : l.status === "MATCHED" ? (
                          <button type="button" className={ui.btnGhost} disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: "unmatch" })}>Undo match</button>
                        ) : (
                          <button type="button" className={ui.btnGhost} disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: "unignore" })}>Undo ignore</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={ui.muted}>A match needs the same bank account, exactly the same amount and a booking within a week of the bank date. A reversed receipt is never offered, and one receipt can back only one bank line.</p>
        </>
      ) : null}
    </div>
  );
}
