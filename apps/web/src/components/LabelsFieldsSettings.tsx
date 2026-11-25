import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../lib/api-client";
import layout from "../pages/DashboardPage.module.css";
import { LABEL_COLOURS } from "../lib/labelColours";
import { LabelChip, type Label, type TagKind } from "./TagsPanel";
import ui from "./ui.module.css";

interface FieldDef { id: string; entity_type: TagKind; name: string; type: string; options?: string[] }
const KINDS: { key: TagKind; label: string }[] = [{ key: "PARTY", label: "Contacts" }, { key: "PRODUCT", label: "Products" }, { key: "SALES_DOCUMENT", label: "Sales documents" }, { key: "PURCHASE_DOCUMENT", label: "Purchase documents" }];
const TYPES = [{ key: "TEXT", label: "Text" }, { key: "NUMBER", label: "Number" }, { key: "DATE", label: "Date" }, { key: "YES_NO", label: "Yes / no" }, { key: "CHOICE", label: "Pick from a list" }];
const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

/** Settings: the labels people can put on contacts, products and documents, and the extra fields to fill in on each kind. */
export function LabelsFieldsSettings() {
  const qc = useQueryClient();
  const labels = useQuery({ queryKey: ["labels"], queryFn: () => api.get<Label[]>("/settings/labels") });
  const fields = useQuery({ queryKey: ["custom-fields"], queryFn: () => api.get<FieldDef[]>("/settings/custom-fields") });
  const [name, setName] = useState("");
  const [colour, setColour] = useState("blue");
  const [fKind, setFKind] = useState<TagKind>("PARTY");
  const [fName, setFName] = useState("");
  const [fType, setFType] = useState("TEXT");
  const [fOptions, setFOptions] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (e: unknown) => setNote({ ok: false, text: msg(e) });

  const addLabel = useMutation({
    mutationFn: () => api.post("/settings/labels", { name, colour }),
    onSuccess: () => { setName(""); setNote(null); void qc.invalidateQueries({ queryKey: ["labels"] }); }, onError: fail,
  });
  const delLabel = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/labels/${id}`),
    onSuccess: () => { setNote(null); void qc.invalidateQueries({ queryKey: ["labels"] }); void qc.invalidateQueries({ queryKey: ["tags"] }); }, onError: fail,
  });
  const addField = useMutation({
    mutationFn: () => api.post("/settings/custom-fields", { entity_type: fKind, name: fName, type: fType, options: fType === "CHOICE" ? fOptions.split(",").map((o) => o.trim()).filter(Boolean) : [] }),
    onSuccess: () => { setFName(""); setFOptions(""); setNote(null); void qc.invalidateQueries({ queryKey: ["custom-fields"] }); void qc.invalidateQueries({ queryKey: ["tags"] }); }, onError: fail,
  });
  const delField = useMutation({
    mutationFn: (id: string) => api.delete(`/settings/custom-fields/${id}`),
    onSuccess: () => { setNote(null); void qc.invalidateQueries({ queryKey: ["custom-fields"] }); void qc.invalidateQueries({ queryKey: ["tags"] }); }, onError: fail,
  });

  return (
    <div className={layout.panel} aria-labelledby="labels-fields-h">
      <h2 id="labels-fields-h">Labels and custom fields</h2>
      {note ? <p role="alert" style={{ color: "var(--color-negative)" }}>{note.text}</p> : null}

      <h3>Labels</h3>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0" }}>
        {(labels.data ?? []).map((l) => (
          <span key={l.id} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <LabelChip label={l} />{l.in_use ? <span className={ui.muted}>{l.in_use}</span> : null}
            <button type="button" className={ui.btnGhost} aria-label={`Delete label ${l.name}`} disabled={delLabel.isPending}
              onClick={() => { if (l.in_use ? window.confirm(`"${l.name}" is on ${l.in_use} item${l.in_use === 1 ? "" : "s"}. Delete it and take it off all of them?`) : true) delLabel.mutate(l.id); }}>×</button>
          </span>
        ))}
        {labels.isSuccess && labels.data.length === 0 ? <span className={ui.muted}>None yet.</span> : null}
      </div>
      <form className={ui.toolbar} onSubmit={(e) => { e.preventDefault(); addLabel.mutate(); }}>
        <label className={ui.field}><span>New label</span><input className={ui.input} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required /></label>
        <label className={ui.field}><span>Colour</span><select className={ui.select} value={colour} onChange={(e) => setColour(e.target.value)}>{Object.keys(LABEL_COLOURS).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <button type="submit" className={ui.btnSecondary} disabled={addLabel.isPending}>Add label</button>
      </form>

      <h3 style={{ marginTop: "var(--space-4)" }}>Custom fields</h3>
      {KINDS.map((k) => {
        const mine = (fields.data ?? []).filter((f) => f.entity_type === k.key);
        return mine.length === 0 ? null : (
          <div key={k.key} style={{ margin: "8px 0" }}>
            <strong>{k.label}</strong>
            <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
              {mine.map((f) => (
                <li key={f.id}>{f.name} <span className={ui.muted}>· {TYPES.find((t) => t.key === f.type)?.label}{f.options?.length ? `: ${f.options.join(", ")}` : ""}</span>{" "}
                  <button type="button" className={ui.btnGhost} aria-label={`Delete field ${f.name}`} disabled={delField.isPending}
                    onClick={() => { if (window.confirm(`Delete "${f.name}" and every answer saved in it?`)) delField.mutate(f.id); }}>Delete</button></li>
              ))}
            </ul>
          </div>
        );
      })}
      <form className={ui.formGrid} onSubmit={(e) => { e.preventDefault(); addField.mutate(); }}>
        <label className={ui.field}><span>Applies to</span><select className={ui.select} value={fKind} onChange={(e) => setFKind(e.target.value as TagKind)}>{KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}</select></label>
        <label className={ui.field}><span>Field name</span><input className={ui.input} value={fName} onChange={(e) => setFName(e.target.value)} maxLength={60} required /></label>
        <label className={ui.field}><span>Type</span><select className={ui.select} value={fType} onChange={(e) => setFType(e.target.value)}>{TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></label>
        {fType === "CHOICE" ? <label className={ui.field}><span>Choices, separated by commas</span><input className={ui.input} value={fOptions} onChange={(e) => setFOptions(e.target.value)} placeholder="Gold, Silver, Bronze" required /></label> : null}
        <div className={ui.formActions}><button type="submit" className={ui.btnSecondary} disabled={addField.isPending}>Add field</button></div>
      </form>
    </div>
  );
}
