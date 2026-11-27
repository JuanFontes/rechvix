//go:build integration

package integration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	accountingapp "rechvix/internal/modules/accounting/app"
	accountingdomain "rechvix/internal/modules/accounting/domain"
	purchasesapp "rechvix/internal/modules/purchases/app"
	purchasesdomain "rechvix/internal/modules/purchases/domain"
	reportingdomain "rechvix/internal/modules/reporting/domain"
)

// A phone on a flaky connection retries "create this supplier bill". The same client_ref must return the document that already exists
// (so a bill is never created twice and the stray-draft gap is closed), and a reused client_ref for a different supplier is refused.
func TestPurchases_ClientRef_CreateIsIdempotent(t *testing.T) {
	ctx := context.Background()
	inventorySvc := newTestInventoryService(t)
	svc := newTestPurchasesService(t, inventorySvc)
	fx := setupPurchasesFixture(t, ctx)

	p := purchasesapp.CreateDocumentParams{
		BranchID: fx.BranchID, WarehouseID: fx.WarehouseID, SupplierPartyID: fx.SupplierPartyID,
		DocumentType: purchasesdomain.DocPurchaseInvoice, CurrencyCode: "INR", ClientRef: "mobile:pur:1",
	}
	first, existed, err := svc.CreateDocumentIdempotent(ctx, fx.Principal, p)
	if err != nil || existed {
		t.Fatalf("first create: existed=%v err=%v", existed, err)
	}
	again, existed, err := svc.CreateDocumentIdempotent(ctx, fx.Principal, p)
	if err != nil || !existed {
		t.Fatalf("retry: existed=%v err=%v; want the original returned", existed, err)
	}
	if again.ID != first.ID || again.DocumentNumber != first.DocumentNumber {
		t.Fatalf("retry returned a different document: %s/%s vs %s/%s", again.ID, again.DocumentNumber, first.ID, first.DocumentNumber)
	}
	all, err := svc.ListDocuments(ctx, fx.Principal, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, d := range all {
		if d.ClientRef == "mobile:pur:1" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d documents carry the client_ref after a retry, want 1", n)
	}

	// The retry also works after the bill is finished: it just returns the finalized document, nothing new is made.
	if _, err := svc.AddLine(ctx, fx.Principal, purchasesapp.AddLineParams{DocumentID: first.ID, ProductVariantID: fx.VariantID, UnitID: fx.PCS, Quantity: mustDecimal(t, "10"), UnitPrice: mustDecimal(t, "20")}); err != nil {
		t.Fatalf("AddLine: %v", err)
	}
	if _, err := svc.FinalizeDocument(ctx, fx.Principal, first.ID); err != nil {
		t.Fatalf("FinalizeDocument: %v", err)
	}
	done, existed, err := svc.CreateDocumentIdempotent(ctx, fx.Principal, p)
	if err != nil || !existed || done.ID != first.ID || done.Status != purchasesdomain.StatusFinalized {
		t.Fatalf("retry after finalize: existed=%v status=%v err=%v", existed, done, err)
	}
	bal, err := inventorySvc.GetBalance(ctx, fx.Principal, fx.WarehouseID, fx.VariantID)
	if err != nil || !bal.QuantityOnHand.Equal(mustDecimal(t, "10")) {
		t.Fatalf("stock after a retried bill = %v (%v), want 10 (booked once)", bal, err)
	}

	other := p
	other.SupplierPartyID = uuid.New()
	if _, _, err := svc.CreateDocumentIdempotent(ctx, fx.Principal, other); !errors.Is(err, purchasesdomain.ErrClientRefReused) {
		t.Fatalf("client_ref reused for another supplier: %v, want ErrClientRefReused", err)
	}
}

// The same for paying a supplier: one client_ref books the money once; a different amount under the same ref is an error.
func TestAccounting_SupplierPayment_ClientRef_IsIdempotent(t *testing.T) {
	ctx := context.Background()
	fx := newBankFixture(t, ctx)
	p := accountingapp.RecordPaymentParams{PartyID: fx.SupplierID, Amount: mustDecimal(t, "750"), Method: accountingdomain.MethodCash, PaidAt: time.Now(), ClientRef: "mobile:spay:1"}
	first, err := fx.acct.RecordPayment(ctx, fx.Principal, p)
	if err != nil {
		t.Fatalf("first RecordPayment: %v", err)
	}
	again, err := fx.acct.RecordPayment(ctx, fx.Principal, p)
	if err != nil {
		t.Fatalf("retry RecordPayment: %v", err)
	}
	if again.ID != first.ID {
		t.Fatalf("retry booked a second payment (%s vs %s)", again.ID, first.ID)
	}
	entries, err := fx.acct.GetPartyLedger(ctx, fx.Principal, fx.SupplierID, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("supplier ledger has %d entries after a retried payment, want 1", len(entries))
	}
	other := p
	other.Amount = mustDecimal(t, "751")
	if _, err := fx.acct.RecordPayment(ctx, fx.Principal, other); err == nil {
		t.Fatal("reusing client_ref for a different amount succeeded; want an error")
	}
}

// The payables report must list a supplier the business still owes. It used to age debits (right for a customer, wrong for a supplier), so a
// supplier billed 1,000 and paid 400 showed nothing owed at all. A bill books Cr Accounts Payable; a payment books Dr; owed = credits - debits.
func TestReporting_PayablesSummary_ShowsWhatIsOwedToASupplier(t *testing.T) {
	ctx := context.Background()
	fx := newBankFixture(t, ctx)
	reportingSvc := newTestReportingService(t, fx.acct)
	if _, _, err := fx.acct.PostIdempotent(ctx, fx.Principal, accountingapp.JournalRequest{
		OrganisationID: fx.Principal.OrganisationID, SourceType: "purchase_document", JournalDate: time.Now().AddDate(0, 0, -45), Description: "Bill", CreatedBy: fx.Principal.UserID,
		Lines: []accountingapp.JournalLineRequest{
			{AccountCode: accountingdomain.CodePurchases, Debit: mustDecimal(t, "1000")},
			{AccountCode: accountingdomain.CodeAccountsPayable, PartyID: &fx.SupplierID, Credit: mustDecimal(t, "1000")},
		},
	}); err != nil {
		t.Fatalf("posting the bill: %v", err)
	}
	if _, err := fx.acct.RecordPayment(ctx, fx.Principal, accountingapp.RecordPaymentParams{PartyID: fx.SupplierID, Amount: mustDecimal(t, "400"), Method: accountingdomain.MethodCash, PaidAt: time.Now()}); err != nil {
		t.Fatalf("RecordPayment: %v", err)
	}
	rows, err := reportingSvc.PayablesSummary(ctx, fx.Principal, time.Now())
	if err != nil {
		t.Fatalf("PayablesSummary: %v", err)
	}
	if len(rows) != 1 || rows[0].PartyID != fx.SupplierID {
		t.Fatalf("payables = %+v, want exactly the supplier", rows)
	}
	if got := rows[0].Total.Decimal().StringFixed(2); got != "600.00" {
		t.Fatalf("owed to the supplier = %s, want 600.00 (1,000 billed - 400 paid)", got)
	}
	if got := rows[0].Days31To60.Decimal().StringFixed(2); got != "600.00" {
		t.Fatalf("the 45-day-old bill, part-paid, should age in 31-60: got %s", got)
	}
	// Paying the rest settles the supplier: they leave the report.
	if _, err := fx.acct.RecordPayment(ctx, fx.Principal, accountingapp.RecordPaymentParams{PartyID: fx.SupplierID, Amount: mustDecimal(t, "600"), Method: accountingdomain.MethodCash, PaidAt: time.Now()}); err != nil {
		t.Fatalf("RecordPayment: %v", err)
	}
	if rows, err = reportingSvc.PayablesSummary(ctx, fx.Principal, time.Now()); err != nil || len(rows) != 0 {
		t.Fatalf("payables after paying in full = %+v, %v; want none", rows, err)
	}
}

// The API takes whole days ("to=2026-11-27"). Money received or paid ON the last day itself must be counted: the range used to stop at 00:00
// of that day, so a dashboard asked for "up to today" left out everything that happened today.
func TestReporting_CashFlow_IncludesTheLastDayItself(t *testing.T) {
	ctx := context.Background()
	fx := newBankFixture(t, ctx)
	reportingSvc := newTestReportingService(t, fx.acct)
	if _, err := fx.acct.RecordPayment(ctx, fx.Principal, accountingapp.RecordPaymentParams{PartyID: fx.SupplierID, Amount: mustDecimal(t, "300"), Method: accountingdomain.MethodCash, PaidAt: time.Now().UTC()}); err != nil {
		t.Fatalf("RecordPayment: %v", err)
	}
	today := time.Now().UTC().Truncate(24 * time.Hour) // what "2026-11-27" parses to
	rows, err := reportingSvc.CashFlow(ctx, fx.Principal, reportingdomain.Filter{From: &today, To: &today})
	if err != nil {
		t.Fatalf("CashFlow: %v", err)
	}
	if len(rows) != 1 || rows[0].Paid != "300.00" {
		t.Fatalf("cash flow for today..today = %+v, want today's 300.00 payment counted", rows)
	}
}
