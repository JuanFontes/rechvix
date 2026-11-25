import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAmount, parseDate, parseStatementCsv, splitRecord } from "./bankStatement.ts";

test("amounts: thousands and decimal separators in both conventions, signs, brackets, DR/CR, currency symbols", () => {
  const cases: [string, string | null][] = [
    ["1,234.56", "1234.56"], ["1.234,56", "1234.56"], ["1234.56", "1234.56"], ["1234,56", "1234.56"], ["12,5", "12.5"], ["1,234", "1234"], ["1.234", "1234"],
    ["1,234,567.89", "1234567.89"], ["1.234.567,89", "1234567.89"], ["-50", "-50"], ["(50.00)", "-50.00"], ["50 DR", "-50"], ["50 CR", "50"], ["+7.5", "7.5"],
    ["€ 1 234,50", "1234.50"], ["₹1,00,000.00", "100000.00"], ["0.00", "0"], ["", null], ["abc", null], ["1.2.3x", null], ["-", null],
  ];
  for (const [input, want] of cases) assert.equal(parseAmount(input), want, `parseAmount(${JSON.stringify(input)})`);
});

test("dates: ISO, day-first, month-first, two-digit years; impossible dates are refused", () => {
  assert.equal(parseDate("2026-11-05", "dmy"), "2026-11-05");
  assert.equal(parseDate("05/11/2026", "dmy"), "2026-11-05"); assert.equal(parseDate("05/11/2026", "mdy"), "2026-05-11");
  assert.equal(parseDate("5.11.26", "dmy"), "2026-11-05"); assert.equal(parseDate("31/02/2026", "dmy"), null); assert.equal(parseDate("13/13/2026", "mdy"), null);
  assert.equal(parseDate("2026-11-05 10:30", "dmy"), "2026-11-05"); assert.equal(parseDate("yesterday", "dmy"), null);
});

test("quoted fields keep their commas and escaped quotes", () => {
  assert.deepEqual(splitRecord('05/11/2026,"ACME, Inc ""HQ""",100', ","), ["05/11/2026", 'ACME, Inc "HQ"', "100"]);
});

test("one signed amount column, letterhead rows above the header skipped", () => {
  const csv = `Acme Bank\nAccount: 123\n\nDate,Description,Reference,Amount\n05/11/2026,UPI/ASHA,UTR1,"1,500.00"\n06/11/2026,Rent,,-5000\n`;
  const r = parseStatementCsv(csv);
  assert.deepEqual(r.lines, [
    { date: "2026-11-05", description: "UPI/ASHA", reference: "UTR1", amount: "1500.00" },
    { date: "2026-11-06", description: "Rent", reference: "", amount: "-5000" },
  ]);
  assert.deepEqual(r.errors, []);
});

test("separate debit and credit columns, semicolons, European numbers", () => {
  const csv = "Fecha;Concepto;Cargo;Abono\n05/11/2026;Cobro cliente;;1.500,25\n06/11/2026;Alquiler;800,00;\n";
  const r = parseStatementCsv(csv);
  assert.deepEqual(r.lines.map((l) => [l.date, l.amount]), [["2026-11-05", "1500.25"], ["2026-11-06", "-800.00"]]);
});

test("a row that cannot be read is reported with its line number, never guessed", () => {
  const csv = "Date,Description,Amount\n05/11/2026,ok,10\nsoon,bad date,10\n07/11/2026,bad amount,ten\n08/11/2026,zero,0.00\n";
  const r = parseStatementCsv(csv);
  assert.equal(r.lines.length, 1);
  assert.equal(r.errors.length, 3); assert.match(r.errors[0]!, /^Row 3: "soon" is not a date/); assert.match(r.errors[1]!, /^Row 4: "ten" is not an amount/); assert.match(r.errors[2]!, /^Row 5: .*zero/);
});

test("month-first reading changes the dates; a file with no recognisable header says so", () => {
  assert.equal(parseStatementCsv("Date,Amount\n03/04/2026,5\n", "mdy").lines[0]!.date, "2026-03-04");
  assert.equal(parseStatementCsv("Date,Amount\n03/04/2026,5\n", "dmy").lines[0]!.date, "2026-04-03");
  assert.match(parseStatementCsv("foo,bar\n1,2\n").errors[0]!, /No header row/);
  assert.match(parseStatementCsv("").errors[0]!, /empty/);
});
