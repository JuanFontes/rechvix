/** Reads a bank's CSV export into statement lines. Banks differ a lot, so this is deliberately forgiving about headers and number formats
 *  and strict about what it cannot read: a row it cannot understand is reported by line number, never guessed at. */

export interface StatementLine { date: string; description: string; reference: string; amount: string }
export interface ParsedStatement { lines: StatementLine[]; errors: string[]; columns: string }
export type DateOrder = "dmy" | "mdy";

/** Splits one CSV record, honouring "quoted, fields" and "" escapes. */
export function splitRecord(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function pickDelimiter(head: string): string {
  const count = (d: string) => splitRecord(head, d).length;
  return [",", ";", "\t", "|"].map((d) => [d, count(d)] as const).sort((a, b) => b[1] - a[1])[0]![0];
}

/** Records may contain quoted line breaks; this splits on newlines that are outside quotes. */
export function splitRecords(text: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (const ch of text.replace(/^﻿/, "")) {
    if (ch === '"') q = !q;
    if ((ch === "\n" || ch === "\r") && !q) { if (cur.trim()) out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** "2026-11-05", "05/11/2026", "5-11-26", "5.11.2026" -> "2026-11-05". Null when it is not a real calendar date. */
export function parseDate(s: string, order: DateOrder): string | null {
  const t = s.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(t);
  if (r) { y = +r[1]!; m = +r[2]!; d = +r[3]!; }
  else {
    r = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})/.exec(t);
    if (!r) return null;
    const a = +r[1]!, b = +r[2]!;
    [d, m] = order === "dmy" ? [a, b] : [b, a];
    y = r[3]!.length === 2 ? 2000 + +r[3]! : +r[3]!;
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "1,234.56", "1.234,56", "(50.00)", "-50", "50 DR", "€ 1 234,50" -> a plain signed decimal string. Null when it is not a number.
 *  Kept as a string: it goes to the server as text, never through floating point. */
export function parseAmount(s: string): string | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\b(dr|db|debit)\b\.?$/i.test(t)) { neg = true; t = t.replace(/\b(dr|db|debit)\b\.?$/i, ""); }
  else if (/\b(cr|credit)\b\.?$/i.test(t)) t = t.replace(/\b(cr|credit)\b\.?$/i, "");
  t = t.replace(/[^\d.,\-+]/g, "");
  if (t.startsWith("-")) { neg = !neg; t = t.slice(1); } else if (t.startsWith("+")) t = t.slice(1);
  if (!/^[\d.,]+$/.test(t) || !/\d/.test(t)) return null;
  const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
  // Which separator is the decimal point? With both present, whichever comes last. With one kind: a single one followed by anything but
  // exactly three digits is a decimal point ("12,5", "12.50"); otherwise every one of them is a thousands separator ("1,234", "1.234.567").
  let dec = -1;
  if (lastDot >= 0 && lastComma >= 0) dec = Math.max(lastDot, lastComma);
  else if (lastDot >= 0 || lastComma >= 0) {
    const i = Math.max(lastDot, lastComma), sep = t[i]!;
    if (t.split(sep).length - 1 === 1 && t.length - i - 1 !== 3) dec = i;
  }
  const intPart = dec >= 0 ? t.slice(0, dec) : t;
  // Thousands groups must look like groups: the first has 1-3 digits (Indian style "1,00,000" has 2-digit groups after it).
  const groups = intPart.split(/[.,]/);
  if (groups.length > 1 && (groups[0]!.length < 1 || groups[0]!.length > 3 || groups.slice(1).some((g) => g.length < 2 || g.length > 3))) return null;
  const whole = intPart.replace(/[.,]/g, "");
  const frac = dec >= 0 ? t.slice(dec + 1) : "";
  if (!/^\d+$/.test(whole || "0") || (frac && !/^\d+$/.test(frac)) || frac.length > 6) return null;
  const num = `${whole.replace(/^0+(?=\d)/, "") || "0"}${frac ? `.${frac}` : ""}`;
  if (/^0(\.0+)?$/.test(num)) return "0";
  return neg ? `-${num}` : num;
}

const HEAD = {
  date: /^(date|booking date|value date|transaction date|txn date|posting date|fecha|datum|data)\b/i,
  desc: /^(description|details|narration|particulars|memo|concept|concepto|text|transaction details|remarks|omschrijving|libell)/i,
  ref: /^(reference|ref|ref no|cheque|chq|utr|transaction id|txn id|id)\b/i,
  amount: /^(amount|importe|betrag|bedrag|montant|value)\b/i,
  debit: /^(debit|withdrawal|withdrawals|paid out|money out|dr|cargo|soll|debet)\b/i,
  credit: /^(credit|deposit|deposits|paid in|money in|cr|abono|haben|credito)\b/i,
};

/** Reads a statement. The first row that names a date column and an amount (or debit and credit) column is the header; rows above it
 *  (bank letterhead, account numbers) are skipped. Money in is positive, money out negative. */
export function parseStatementCsv(text: string, order: DateOrder = "dmy"): ParsedStatement {
  const recs = splitRecords(text);
  if (recs.length === 0) return { lines: [], errors: ["The file is empty."], columns: "" };
  const delim = pickDelimiter(recs.slice(0, 10).sort((a, b) => b.length - a.length)[0]!);
  let h = -1, idx = { date: -1, desc: -1, ref: -1, amount: -1, debit: -1, credit: -1 };
  for (let i = 0; i < Math.min(recs.length, 30); i++) {
    const cells = splitRecord(recs[i]!, delim);
    const find = (re: RegExp) => cells.findIndex((c) => re.test(c.trim()));
    const cand = { date: find(HEAD.date), desc: find(HEAD.desc), ref: find(HEAD.ref), amount: find(HEAD.amount), debit: find(HEAD.debit), credit: find(HEAD.credit) };
    if (cand.date >= 0 && (cand.amount >= 0 || (cand.debit >= 0 && cand.credit >= 0))) { h = i; idx = cand; break; }
  }
  if (h < 0) return { lines: [], errors: ["No header row found. The file needs a date column and either an amount column or debit and credit columns."], columns: "" };
  const lines: StatementLine[] = [], errors: string[] = [];
  for (let i = h + 1; i < recs.length; i++) {
    const c = splitRecord(recs[i]!, delim), row = i + 1;
    if (c.every((x) => !x)) continue;
    const date = parseDate(c[idx.date] ?? "", order);
    if (!date) { errors.push(`Row ${row}: "${c[idx.date] ?? ""}" is not a date (reading ${order === "dmy" ? "day/month/year" : "month/day/year"}).`); continue; }
    let amount: string | null;
    if (idx.amount >= 0 && !(idx.debit >= 0 && idx.credit >= 0 && !(c[idx.amount] ?? "").trim())) amount = parseAmount(c[idx.amount] ?? "");
    else {
      const d = (c[idx.debit] ?? "").trim() ? parseAmount(c[idx.debit]!) : "0", k = (c[idx.credit] ?? "").trim() ? parseAmount(c[idx.credit]!) : "0";
      if (d === null || k === null) amount = null;
      else if (d !== "0" && k !== "0") { errors.push(`Row ${row}: has both a debit and a credit.`); continue; }
      else amount = k !== "0" ? k.replace(/^-/, "") : d === "0" ? "0" : `-${d.replace(/^-/, "")}`;
    }
    if (amount === null) { errors.push(`Row ${row}: "${c[idx.amount >= 0 ? idx.amount : idx.debit] ?? ""}" is not an amount.`); continue; }
    if (amount === "0") { errors.push(`Row ${row}: the amount is zero, so it was skipped.`); continue; }
    lines.push({ date, description: (c[idx.desc] ?? "").slice(0, 500), reference: (c[idx.ref] ?? "").slice(0, 200), amount });
  }
  const columns = [idx.date >= 0 ? "date" : "", idx.desc >= 0 ? "description" : "", idx.ref >= 0 ? "reference" : "", idx.amount >= 0 ? "amount" : "debit/credit"].filter(Boolean).join(", ");
  return { lines, errors, columns };
}
