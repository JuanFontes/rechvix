# Reference review: Contasimple desktop and Vyapar-style mobile screenshots (2026-11-25)

Three screenshot archives were reviewed: 71 desktop screens of an accounting product (Spanish interface) and 48 phone screens of a
billing product (`WhatsApp ... 1.05.15 PM`: 30 screens, `... 1.05.18 PM`: 18 screens). They are a workflow reference only; nothing here
copies their branding, wording or layout.

**How they were reviewed (read this before relying on the table).** All 119 images were opened as numbered contact sheets
(three to six screens per sheet) and the structure of every screen was read from those. Small text on the long list screens (2, 4, 13, 16,
23, 41, 50) was not legible at that size, so they are marked UNKNOWN beyond "a long table". No screen was zoomed to full resolution.
OBSERVED = visible on a sheet; INFERRED = reasonable reading of a control; UNKNOWN = not determinable.

## Phone screens (Vyapar-style)

| Screens | What is shown (OBSERVED) | Rechvix mobile before | Decision |
|---|---|---|---|
| Party details: Send Reminder, Send Statement, transaction list with Overdue/Unpaid badges, print and share per row | per-customer reminder and statement entry points | customer-level reminder only (WhatsApp/share), no statement | **Built**: reminder composer, statement PDF |
| "Send Payment Reminder" sheet: WhatsApp / SMS / Share | channel choice | WhatsApp and share only | **Improved**: review/edit message, honest status; SMS **not built** (no reliable attach/status story) |
| Reminder card image with amount "as of" date, friendly text | amount plus date message | text only | **Not built**: image cards add no information; PDF statement covers it |
| Sale aging report (buckets, pie, per-party columns) | receivables by age | per-invoice age only | **Built**: aging bar and buckets on To collect (per-party columns: existing customer rows) |
| Sale form (customer, terms, items, discount/shipping/round-off, payment type, notes, terms) | invoice entry | existing Sell screen | **Kept** (not re-audited in this pass) |
| Payment-in with "link payment to transactions" | allocate a payment to invoices | existing payment sheet allocates oldest first or a chosen invoice | **Kept** |
| Reports hub (sale, purchase, day book, P&L, GST, stock, expense, loan) | many report types | To collect, invoices, items | **Deferred**: needs server reports; not a phone-first need |
| Settings list, multi-currency, loyalty points, Sync & Share, backup | configuration | More screen, backup, sync | **Kept** |
| Sale list rows: cash vs credit toggle | tender at entry | payment method on Sell | **Kept** |

## Desktop screens (Contasimple)

| Screens | Module | Rechvix equivalent | Decision |
|---|---|---|---|
| 1 | Dashboard (income, expenses, result, invoices donut, cash, top clients) | Dashboard "what needs me today?" | Kept (not re-compared) |
| 2, 3, 4 | Issued invoices, drafts, filters, status colours | Sales list, drafts, payment-state badges | Kept |
| 5, 56 | Quotes / delivery notes and their numbering and templates | Quotations; delivery challans; numbering series | Kept |
| 6, 19 | Exports (books of record, advanced export, accountant tools, catalogue) | Accountant export panel, tax packs, CSV | Kept |
| 7, 15, 18, 66 | Import invoices, contacts, products | Import centre | Kept |
| 8 | Quarter closing | Accounting period locks | **Improved**: one-click "close last / this quarter" with a confirmation (reuses the existing create and lock endpoints) |
| 9, 11, 12 | Received invoices register, expenses, OCR | Purchases, expenses, OCR | Kept |
| 10 | Investment-goods register | none | **Deferred**: needs a depreciation design |
| 13, 14 | Suppliers/customers lists | Contacts | Kept |
| 16, 17, 63 | Catalogue, stock regularisation, stock control settings | Catalogue, stock adjustments | Kept |
| 20-27, 58, 59, 68 | Treasury summary, movements, reconciliation, receipts and remittances, bank accounts, payment methods | Payments, SEPA export, bank accounts in Settings | **Built (reconciliation)**: statement import and matching to booked receipts/payments, no auto-posting. Not built: treasury charts, remittance/receipt batches, auto-posting of unmatched lines |
| 28-35 | Tax summary, filing calendar, models 303/390/130/100/111/190/115/180/347/349 | Tax pack exports; no calendar | **Built**: filing calendar (deadlines of standard national regime; observed dates match). Model-by-model calculators **not built** (tax packs already export the figures) |
| 36 | Virtual disk | document attachments | Deferred |
| 37-39 | Reports hub, profit and loss, company reports | Reports, P&L | Kept |
| 40-42 | Working-hours report and register | Staff attendance (not re-audited) | Investigate |
| 43-46 | Email inbox, marketplace, messages | none | **Not appropriate**: ads and a mailbox are outside an invoicing product |
| 47-52 | Settings hub, credentials, personal data, company data, VERI*FACTU | Settings, VERI*FACTU (implemented, not certified) | Kept |
| 53-57, 60-62 | Invoice, draft, quote settings; taxes; accounting accounts; certificates; client/supplier custom fields | Numbering series, templates, tax settings, chart of accounts; **custom fields missing** | Deferred (custom fields) |
| 64, 65, 71 | Users, labels, administrative centres | Staff/roles; no labels | Deferred |
| 67, 69 | Mail provider, external apps (Dropbox, Drive, API keys) | SMTP, API keys and scopes | Kept; cloud-drive upload deferred |
| 70 | List pagination and default filters | per-list filters | Deferred |

## What this pass built

1. Mobile payment reminders (per invoice and per customer) with message review, live outstanding amount, PDF/statement hand-off, honest status and history.
2. Mobile statement PDF, invoice preview, and ageing on To collect.
3. Web filing calendar for Spain and India.

Added later the same day: bank reconciliation (server migration 0066, `bankrec` module, Accounting page panel), tested against a real local PostgreSQL 18 and seen in a browser against a running server. Not done in this pass, and why: fixed-asset register, custom fields, labels, per-model tax calculators and
list-preference settings are each a separate feature with its own data model and tests. The phone UI was not rendered (no emulator
in this environment). The filing-calendar panel was not viewed in a browser; the bank reconciliation panel was, at desktop width only (the window would not shrink to phone width).
