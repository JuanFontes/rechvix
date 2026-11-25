import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../lib/api-client";
import { LABEL_COLOURS } from "../lib/labelColours";
import layout from "../pages/DashboardPage.module.css";
import ui from "./ui.module.css";

export type TagKind = "PARTY" | "PRODUCT" | "SALES_DOCUMENT" | "PURCHASE_DOCUMENT";
export interface Label { id: string; name: string; colour: string; in_use?: number }
interface FieldValue { id: string; name: string; type: "TEXT" | "NUMBER" | "DATE" | "YES_NO" | "CHOICE"; options?: string[]; value: string }
interface Tags { labels: Label[]; fields: FieldValue[] }

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

/** A colour dot beside the label name. The name carries the meaning, so nothing depends on telling colours apart. */
export function LabelDot({ colour }: { colour: string }) {
  return <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: "50%", background: LABEL_COLOURS[colour] ?? LABEL_COLOURS.grey, flex: "none" }} />;
}

export function LabelChip({ label }: { label: Label }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 10px", borderRadius: 999, background: "var(--color-surface-alt)", fontSize: "var(--text-xs)", fontWeight: 600 }}>
      <LabelDot colour={label.colour} />{label.name}
    </span>
  );
}

/** Labels and custom fields for one contact, product or document. Shows nothing when the organisation has defined neither and the
 *  person cannot define them, so a plain screen stays plain. */
export function TagsPanel({ kind, id }: { kind: TagKind; id: string }) {
  const qc = useQueryClient();
  const key = ["tags", kind, id];
  const tags = useQuery({ queryKey: key, queryFn: () => api.get<Tags>(`/tags/${kind}/${id}`) });
  const all = useQuery({ queryKey: ["labels"], queryFn: () => api.get<Label[]>("/settings/labels"), retry: false });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const setLabels = useMutation({
    mutationFn: (ids: string[]) => api.put<Tags>(`/tags/${kind}/${id}/labels`, { label_ids: ids }),
    onSuccess: (t) => { qc.setQueryData(key, t); void qc.invalidateQueries({ queryKey: ["labels"] }); setNote(null); },
    onError: (e) => setNote({ ok: false, text: msg(e) }),
  });
  const setFields = useMutation({
    mutationFn: () => api.put<Tags>(`/tags/${kind}/${id}/fields`, { values: draft }),
    onSuccess: (t) => { qc.setQueryData(key, t); setEditing(false); setDraft({}); setNote({ ok: true, text: "Saved." }); },
    onError: (e) => setNote({ ok: false, text: msg(e) }),
  });

  // A bad or empty reply must never take the whole page down, so read both lists defensively.
  const itemLabels = Array.isArray(tags.data?.labels) ? tags.data.labels : [];
  const fields = Array.isArray(tags.data?.fields) ? tags.data.fields : [];
  const available = Array.isArray(all.data) ? all.data : [];
  const onItem = new Set(itemLabels.map((l) => l.id));
  if (tags.isError || !tags.data) return null; // loading, no permission to see this item's tags, or the item is gone
  if (fields.length === 0 && available.length === 0 && itemLabels.length === 0) return null;

  const toggle = (l: Label) => setLabels.mutate([...(onItem.has(l.id) ? [...onItem].filter((x) => x !== l.id) : [...onItem, l.id])]);
  const valueOf = (f: FieldValue) => draft[f.id] ?? f.value;

  return (
    <div className={layout.panel} aria-labelledby={`tags-${id}`}>
      <h2 id={`tags-${id}`}>Labels and details</h2>
      {note ? <p role={note.ok ? "status" : "alert"} style={{ color: note.ok ? "var(--color-positive)" : "var(--color-negative)" }}>{note.text}</p> : null}

      <div role="group" aria-label="Labels" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        {available.map((l) => (
          <button key={l.id} type="button" className={ui.btnGhost} aria-pressed={onItem.has(l.id)} disabled={setLabels.isPending} onClick={() => toggle(l)}
            style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: onItem.has(l.id) ? 700 : 400, opacity: onItem.has(l.id) ? 1 : 0.7 }}>
            <LabelDot colour={l.colour} />{onItem.has(l.id) ? "✓ " : ""}{l.name}
          </button>
        ))}
        {available.length === 0 ? <span className={ui.muted}>No labels yet. Add some under Settings.</span> : null}
      </div>

      {fields.length > 0 ? (
        editing ? (
          <form className={ui.formGrid} onSubmit={(e) => { e.preventDefault(); setFields.mutate(); }}>
            {fields.map((f) => (
              <label key={f.id} className={ui.field}><span>{f.name}</span>
                {f.type === "CHOICE" || f.type === "YES_NO" ? (
                  <select className={ui.select} value={valueOf(f)} onChange={(e) => setDraft({ ...draft, [f.id]: e.target.value })}>
                    <option value="">—</option>
                    {(f.type === "YES_NO" ? ["yes", "no"] : f.options ?? []).map((o) => <option key={o} value={o}>{o === "yes" ? "Yes" : o === "no" ? "No" : o}</option>)}
                  </select>
                ) : <input className={ui.input} type={f.type === "DATE" ? "date" : "text"} inputMode={f.type === "NUMBER" ? "decimal" : undefined} maxLength={500} value={valueOf(f)} onChange={(e) => setDraft({ ...draft, [f.id]: e.target.value })} />}
              </label>
            ))}
            <div className={ui.formActions}>
              <button type="submit" className={ui.btnPrimary} disabled={setFields.isPending}>{setFields.isPending ? "Saving…" : "Save"}</button>
              <button type="button" className={ui.btnGhost} onClick={() => { setEditing(false); setDraft({}); setNote(null); }}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <dl style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px", margin: "8px 0" }}>
              {fields.map((f) => <div key={f.id} style={{ display: "contents" }}><dt className={ui.muted}>{f.name}</dt><dd style={{ margin: 0 }}>{f.value ? (f.type === "YES_NO" ? (f.value === "yes" ? "Yes" : "No") : f.value) : "—"}</dd></div>)}
            </dl>
            <button type="button" className={ui.btnSecondary} onClick={() => { setEditing(true); setNote(null); }}>Edit details</button>
          </>
        )
      ) : null}
    </div>
  );
}
