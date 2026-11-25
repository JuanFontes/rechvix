import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../lib/api-client";
import layout from "../pages/DashboardPage.module.css";
import ui from "./ui.module.css";

interface Asset {
  id: string; code: string; name: string; category: string; purchase_date: string; in_service_date: string; cost: string; residual_value: string;
  life_months: number; method: "STRAIGHT_LINE" | "DECLINING_BALANCE"; rate_percent?: string; accumulated_depreciation: string; book_value: string;
  depreciated_through?: string; status: "ACTIVE" | "DISPOSED"; disposed_on?: string; disposal_proceeds?: string;
}
interface Register { assets: Asset[]; total_cost: string; total_accumulated_depreciation: string; total_book_value: string }
interface Entry { period_end: string; amount: string }

const show = (s: string) => Number(s).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");
const today = () => new Date().toISOString().slice(0, 10);
const lastMonthEnd = () => { const d = new Date(); return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 0)).toISOString().slice(0, 10); };

const EMPTY = { name: "", code: "", category: "", purchase_date: today(), cost: "", residual_value: "", life_years: "5", method: "STRAIGHT_LINE", rate_percent: "", book_acquisition_from: "" };

/** Register of long-lived assets (vehicles, machines, computers). Depreciation is booked one month at a time for every asset together, and
 *  running it twice never doubles anything. Disposal removes the asset and books the gain or loss. */
export function FixedAssetsPanel() {
  const qc = useQueryClient();
  const reg = useQuery({ queryKey: ["fixed-assets"], queryFn: () => api.get<Register>("/accounting/fixed-assets") });
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(EMPTY);
  const [through, setThrough] = useState(lastMonthEnd);
  const [open, setOpen] = useState<string | null>(null);
  const [disposing, setDisposing] = useState<string | null>(null);
  const [d, setD] = useState({ date: today(), proceeds: "", proceeds_account: "1010" });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["fixed-assets"] });
  const set = (k: keyof typeof EMPTY) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }));

  const create = useMutation({
    mutationFn: () => api.post("/accounting/fixed-assets", {
      name: f.name, code: f.code, category: f.category, purchase_date: f.purchase_date, cost: f.cost, residual_value: f.residual_value,
      life_months: Math.round(Number(f.life_years) * 12), method: f.method, rate_percent: f.method === "DECLINING_BALANCE" ? f.rate_percent : "",
      book_acquisition_from: f.book_acquisition_from,
    }),
    onSuccess: () => { setNote({ ok: true, text: "Asset added." }); setAdding(false); setF(EMPTY); refresh(); },
    onError: (e) => setNote({ ok: false, text: msg(e) }),
  });
  const run = useMutation({
    mutationFn: () => api.post<{ months: number; entries: number; total: string }>("/accounting/fixed-assets/depreciation", { through }),
    onSuccess: (r) => { setNote({ ok: true, text: r.months === 0 ? "Nothing to book: depreciation is already up to date for that month." : `Booked ${show(r.total)} over ${r.months} month${r.months === 1 ? "" : "s"}.` }); refresh(); void qc.invalidateQueries({ queryKey: ["fixed-asset-schedule"] }); },
    onError: (e) => setNote({ ok: false, text: msg(e) }),
  });
  const dispose = useMutation({
    mutationFn: (id: string) => api.post(`/accounting/fixed-assets/${id}/dispose`, { date: d.date, proceeds: d.proceeds, proceeds_account: Number(d.proceeds) > 0 ? d.proceeds_account : "" }),
    onSuccess: () => { setNote({ ok: true, text: "Asset disposed of and the gain or loss booked." }); setDisposing(null); refresh(); },
    onError: (e) => setNote({ ok: false, text: msg(e) }),
  });
  const sched = useQuery({ queryKey: ["fixed-asset-schedule", open], enabled: !!open, queryFn: () => api.get<Entry[]>(`/accounting/fixed-assets/${open}/schedule`) });

  const assets = reg.data?.assets ?? [];
  return (
    <div className={layout.panel} aria-labelledby="fixed-assets-h">
      <h2 id="fixed-assets-h">Fixed assets</h2>
      <p className={ui.muted}>Vehicles, machines and equipment you keep for years. Each month's depreciation is booked as one entry for all assets.</p>
      {reg.isError ? <p role="alert">{msg(reg.error)}</p> : null}
      {note ? <p role={note.ok ? "status" : "alert"} style={{ color: note.ok ? "var(--color-positive)" : "var(--color-negative)" }}>{note.text}</p> : null}

      <div className={ui.toolbar}>
        <button type="button" className={ui.btnPrimary} onClick={() => { setAdding((v) => !v); setNote(null); }} aria-expanded={adding}>{adding ? "Close" : "Add asset"}</button>
        <span className={ui.toolbarSpacer} />
        <label className={ui.field}><span>Book depreciation up to</span><input className={ui.input} type="date" value={through} onChange={(e) => setThrough(e.target.value)} /></label>
        <button type="button" className={ui.btnSecondary} disabled={run.isPending || assets.every((a) => a.status !== "ACTIVE")} onClick={() => { setNote(null); run.mutate(); }}>{run.isPending ? "Booking…" : "Book depreciation"}</button>
      </div>

      {adding ? (
        <form className={ui.formGrid} onSubmit={(e) => { e.preventDefault(); setNote(null); create.mutate(); }}>
          <label className={ui.field}><span>Name</span><input className={ui.input} value={f.name} onChange={set("name")} required maxLength={200} /></label>
          <label className={ui.field}><span>Code (optional)</span><input className={ui.input} value={f.code} onChange={set("code")} maxLength={60} /></label>
          <label className={ui.field}><span>Category (optional)</span><input className={ui.input} value={f.category} onChange={set("category")} maxLength={100} /></label>
          <label className={ui.field}><span>Purchase date</span><input className={ui.input} type="date" value={f.purchase_date} onChange={set("purchase_date")} required /></label>
          <label className={ui.field}><span>Cost</span><input className={ui.input} inputMode="decimal" value={f.cost} onChange={set("cost")} required /></label>
          <label className={ui.field}><span>Value at the end of its life</span><input className={ui.input} inputMode="decimal" value={f.residual_value} onChange={set("residual_value")} placeholder="0" /></label>
          <label className={ui.field}><span>Useful life (years)</span><input className={ui.input} inputMode="decimal" value={f.life_years} onChange={set("life_years")} required /></label>
          <label className={ui.field}><span>Method</span>
            <select className={ui.select} value={f.method} onChange={set("method")}><option value="STRAIGHT_LINE">Straight line (same every month)</option><option value="DECLINING_BALANCE">Declining balance (percent of book value)</option></select>
          </label>
          {f.method === "DECLINING_BALANCE" ? <label className={ui.field}><span>Yearly rate (%)</span><input className={ui.input} inputMode="decimal" value={f.rate_percent} onChange={set("rate_percent")} required /></label> : null}
          <label className={ui.field}><span>Book the purchase now?</span>
            <select className={ui.select} value={f.book_acquisition_from} onChange={set("book_acquisition_from")}>
              <option value="">No, the cost is already in my books</option><option value="1010">Yes, paid from bank</option><option value="1000">Yes, paid in cash</option>
              <option value="2000">Yes, still owed to the supplier</option><option value="3100">Yes, owned before I started (opening balance)</option>
            </select>
          </label>
          <div className={ui.formActions}><button type="submit" className={ui.btnPrimary} disabled={create.isPending}>{create.isPending ? "Saving…" : "Save asset"}</button></div>
        </form>
      ) : null}

      {reg.isLoading ? <p className={ui.muted}>Loading…</p> : assets.length === 0 && !adding ? <p>No assets yet. Add the first one above.</p> : assets.length > 0 ? (
        <>
          <p style={{ margin: "var(--space-3) 0" }}>Cost <strong>{show(reg.data!.total_cost)}</strong> · depreciated so far <strong>{show(reg.data!.total_accumulated_depreciation)}</strong> · book value <strong>{show(reg.data!.total_book_value)}</strong> <span className={ui.muted}>(assets in use)</span></p>
          <div className={ui.tableScroll} tabIndex={0}>
            <table className={ui.table}>
              <thead><tr><th scope="col">Asset</th><th scope="col">Bought</th><th scope="col" style={{ textAlign: "right" }}>Cost</th><th scope="col" style={{ textAlign: "right" }}>Depreciated</th><th scope="col" style={{ textAlign: "right" }}>Book value</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}{a.code ? <span className={ui.muted}> · {a.code}</span> : null}<div className={ui.muted}>{a.method === "STRAIGHT_LINE" ? "Straight line" : `${a.rate_percent}% declining`} · {a.life_months % 12 === 0 ? `${a.life_months / 12} yr` : `${a.life_months} mo`}</div>
                      {open === a.id ? (sched.isLoading ? <div className={ui.muted}>Loading…</div> : <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{(sched.data ?? []).map((e) => <li key={e.period_end}>{e.period_end.slice(0, 7)}: {show(e.amount)}</li>)}{(sched.data ?? []).length === 0 ? <li>No depreciation booked yet.</li> : null}</ul>) : null}
                    </td>
                    <td><time dateTime={a.purchase_date}>{a.purchase_date}</time></td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{show(a.cost)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{show(a.accumulated_depreciation)}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{show(a.book_value)}</td>
                    <td><span className={ui.badge} data-tone={a.status === "ACTIVE" ? "positive" : "neutral"}>{a.status === "ACTIVE" ? "In use" : `Disposed ${a.disposed_on}`}</span></td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                        <button type="button" className={ui.btnGhost} aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? "Hide months" : "Months"}</button>
                        {a.status === "ACTIVE" ? (disposing === a.id ? (
                          <form onSubmit={(e) => { e.preventDefault(); setNote(null); dispose.mutate(a.id); }} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <input className={ui.input} type="date" aria-label="Disposal date" value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} required />
                            <input className={ui.input} inputMode="decimal" aria-label="Sale proceeds" placeholder="Sold for (0 if scrapped)" value={d.proceeds} onChange={(e) => setD({ ...d, proceeds: e.target.value })} />
                            {Number(d.proceeds) > 0 ? <select className={ui.select} aria-label="Money received into" value={d.proceeds_account} onChange={(e) => setD({ ...d, proceeds_account: e.target.value })}><option value="1010">Bank</option><option value="1000">Cash</option></select> : null}
                            <button type="submit" className={ui.btnDanger} disabled={dispose.isPending}>Dispose</button>
                            <button type="button" className={ui.btnGhost} onClick={() => setDisposing(null)}>Cancel</button>
                          </form>
                        ) : <button type="button" className={ui.btnGhost} onClick={() => { setDisposing(a.id); setNote(null); }}>Sell or scrap…</button>) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
