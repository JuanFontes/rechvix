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
	"rechvix/internal/modules/bankrec"
	"rechvix/internal/platform/audit"
	"rechvix/internal/platform/permissions"
)

func newBankrec() *bankrec.Service {
	return bankrec.NewService(sharedPool, permissions.NewChecker(permissions.NewPGStore(sharedPool), sharedPool), audit.NewPGRecorder(sharedPool))
}

type bankFixture struct {
	accountingFixture
	acct *accountingapp.Service
	bank uuid.UUID
}

func newBankFixture(t *testing.T, ctx context.Context) bankFixture {
	t.Helper()
	_, _, acct, _ := newTestAccountingServices(t)
	fx := setupAccountingFixture(t, ctx, acct)
	b, err := acct.CreateBankAccount(ctx, fx.Principal, accountingapp.CreateBankAccountParams{LegalEntityID: fx.LegalEntityID, Name: "Main bank", Kind: accountingdomain.BankAccountBank, CurrencyCode: "INR"})
	if err != nil {
		t.Fatalf("CreateBankAccount: %v", err)
	}
	return bankFixture{accountingFixture: fx, acct: acct, bank: b.ID}
}

func (f bankFixture) receipt(t *testing.T, ctx context.Context, amount string, at time.Time, bank uuid.UUID) *accountingdomain.Receipt {
	t.Helper()
	r, err := f.acct.RecordReceipt(ctx, f.Principal, accountingapp.RecordReceiptParams{PartyID: f.CustomerID, Amount: mustDecimal(t, amount), BankAccountID: &bank, Method: accountingdomain.MethodBankTransfer, ReceivedAt: at})
	if err != nil {
		t.Fatalf("RecordReceipt: %v", err)
	}
	return r
}

func TestBankrec_ImportIsIdempotentAndKeepsGenuineRepeats(t *testing.T) {
	ctx := context.Background()
	fx := newBankFixture(t, ctx)
	svc := newBankrec()
	stmt := []bankrec.LineInput{
		{Date: "2026-11-02", Description: "UPI/ASHA", Amount: "1500.00"},
		{Date: "2026-11-03", Description: "Coffee", Amount: "-120.50"},
		{Date: "2026-11-03", Description: "coffee ", Amount: "-120.50"}, // a genuine second identical purchase
	}
	r1, err := svc.ImportLines(ctx, fx.Principal, fx.bank, stmt)
	if err != nil || r1.Added != 3 || r1.Duplicates != 0 {
		t.Fatalf("first import = %+v, %v; want 3 added", r1, err)
	}
	r2, err := svc.ImportLines(ctx, fx.Principal, fx.bank, stmt)
	if err != nil || r2.Added != 0 || r2.Duplicates != 3 {
		t.Fatalf("re-importing the same statement = %+v, %v; want nothing added", r2, err)
	}
	// An overlapping statement adds only what is new.
	r3, err := svc.ImportLines(ctx, fx.Principal, fx.bank, append(stmt[:2:2], bankrec.LineInput{Date: "2026-11-04", Description: "Rent", Amount: "-5000"}))
	if err != nil || r3.Added != 1 || r3.Duplicates != 2 {
		t.Fatalf("overlapping import = %+v, %v; want 1 added, 2 duplicates", r3, err)
	}
	got, err := svc.List(ctx, fx.Principal, fx.bank, "", 0)
	if err != nil || got.Summary.LinesTotal != 4 || got.Summary.Unmatched != 4 || got.Summary.StatementNet != "-3741.000000" && got.Summary.StatementNet != "-3741.00" {
		t.Fatalf("list = %+v, %v", got.Summary, err)
	}
}

func TestBankrec_ImportValidation(t *testing.T) {
	ctx := context.Background()
	fx := newBankFixture(t, ctx)
	svc := newBankrec()
	for name, lines := range map[string][]bankrec.LineInput{
		"empty":        {},
		"bad date":     {{Date: "02/11/2026", Amount: "10"}},
		"zero":         {{Date: "2026-11-02", Amount: "0"}},
		"not a number": {{Date: "2026-11-02", Amount: "ten"}},
		"too precise":  {{Date: "2026-11-02", Amount: "1.1234567"}},
	} {
		if _, err := svc.ImportLines(ctx, fx.Principal, fx.bank, lines); !errors.Is(err, bankrec.ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	if _, err := svc.ImportLines(ctx, fx.Principal, uuid.New(), []bankrec.LineInput{{Date: "2026-11-02", Amount: "10"}}); !errors.Is(err, bankrec.ErrNotFound) {
		t.Errorf("unknown bank account: err = %v, want ErrNotFound", err)
	}
	// A rejected import must not leave half a statement behind.
	if _, err := svc.ImportLines(ctx, fx.Principal, fx.bank, []bankrec.LineInput{{Date: "2026-11-02", Amount: "10"}, {Date: "bad", Amount: "10"}}); err == nil {
		t.Fatal("a statement with a bad line must be rejected")
	}
	if got, _ := svc.List(ctx, fx.Principal, fx.bank, "", 0); got.Summary.LinesTotal != 0 {
		t.Fatalf("%d lines were saved from a rejected statement", got.Summary.LinesTotal)
	}
}

func TestBankrec_MatchRules(t *testing.T) {
	ctx := context.Background()
	fx := newBankFixture(t, ctx)
	svc := newBankrec()
	day := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	good := fx.receipt(t, ctx, "1500.00", day, fx.bank)
	otherAmount := fx.receipt(t, ctx, "1499.00", day, fx.bank)
	farAway := fx.receipt(t, ctx, "2000.00", day.AddDate(0, 0, -40), fx.bank)
	reversed := fx.receipt(t, ctx, "700.00", day, fx.bank)
	if _, err := fx.acct.ReverseReceipt(ctx, fx.Principal, reversed.ID, "entered twice"); err != nil {
		t.Fatalf("ReverseReceipt: %v", err)
	}
	if _, err := svc.ImportLines(ctx, fx.Principal, fx.bank, []bankrec.LineInput{
		{Date: "2026-11-11", Description: "IN 1500", Amount: "1500"},
		{Date: "2026-11-11", Description: "IN 700", Amount: "700"},
		{Date: "2026-11-11", Description: "IN 2000", Amount: "2000"},
	}); err != nil {
		t.Fatal(err)
	}
	list, err := svc.List(ctx, fx.Principal, fx.bank, bankrec.StatusUnmatched, 0)
	if err != nil {
		t.Fatal(err)
	}
	byDesc := map[string]bankrec.Line{}
	for _, l := range list.Lines {
		byDesc[l.Description] = l
	}
	if c := byDesc["IN 1500"].Candidates; len(c) != 1 || c[0].ID != good.ID || c[0].Kind != bankrec.KindReceipt {
		t.Fatalf("candidates for 1500 = %+v, want exactly the 1500 receipt (not 1499)", c)
	}
	if len(byDesc["IN 700"].Candidates) != 0 {
		t.Fatalf("a reversed receipt must never be offered: %+v", byDesc["IN 700"].Candidates)
	}
	if len(byDesc["IN 2000"].Candidates) != 0 {
		t.Fatalf("a receipt 40 days from the bank date must not be offered: %+v", byDesc["IN 2000"].Candidates)
	}

	l1500 := byDesc["IN 1500"].ID
	if err := svc.Match(ctx, fx.Principal, l1500, bankrec.KindReceipt, otherAmount.ID); !errors.Is(err, bankrec.ErrConflict) {
		t.Errorf("matching differing amounts: %v, want ErrConflict", err)
	}
	if err := svc.Match(ctx, fx.Principal, byDesc["IN 700"].ID, bankrec.KindReceipt, reversed.ID); !errors.Is(err, bankrec.ErrConflict) {
		t.Errorf("matching a reversed receipt: %v, want ErrConflict", err)
	}
	if err := svc.Match(ctx, fx.Principal, l1500, bankrec.KindPayment, good.ID); !errors.Is(err, bankrec.ErrInvalid) {
		t.Errorf("money in matched as a supplier payment: %v, want ErrInvalid", err)
	}
	if err := svc.Match(ctx, fx.Principal, l1500, bankrec.KindReceipt, good.ID); err != nil {
		t.Fatalf("the right match: %v", err)
	}
	if err := svc.Match(ctx, fx.Principal, l1500, bankrec.KindReceipt, good.ID); err != nil {
		t.Errorf("matching the same pair twice (a double click) must be harmless: %v", err)
	}
	// The 2000 line and the already-used receipt: a receipt can back only one line.
	if _, err := svc.ImportLines(ctx, fx.Principal, fx.bank, []bankrec.LineInput{{Date: "2026-11-12", Description: "IN 1500 again", Amount: "1500"}}); err != nil {
		t.Fatal(err)
	}
	again, _ := svc.List(ctx, fx.Principal, fx.bank, bankrec.StatusUnmatched, 0)
	for _, l := range again.Lines {
		if l.Description == "IN 1500 again" {
			if len(l.Candidates) != 0 {
				t.Errorf("a receipt already matched must not be offered again: %+v", l.Candidates)
			}
			if err := svc.Match(ctx, fx.Principal, l.ID, bankrec.KindReceipt, good.ID); !errors.Is(err, bankrec.ErrConflict) {
				t.Errorf("one receipt matched to two lines: %v, want ErrConflict", err)
			}
		}
	}
	_ = farAway
}

func TestBankrec_PaymentsUnmatchIgnoreAndSignOffReadiness(t *testing.T) {
	ctx := context.Background()
	fx := newBankFixture(t, ctx)
	svc := newBankrec()
	day := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	pay, err := fx.acct.RecordPayment(ctx, fx.Principal, accountingapp.RecordPaymentParams{PartyID: fx.SupplierID, Amount: mustDecimal(t, "320.75"), BankAccountID: &fx.bank, Method: accountingdomain.MethodBankTransfer, PaidAt: day})
	if err != nil {
		t.Fatalf("RecordPayment: %v", err)
	}
	if _, err := svc.ImportLines(ctx, fx.Principal, fx.bank, []bankrec.LineInput{{Date: "2026-11-09", Description: "NEFT supplier", Amount: "-320.75"}, {Date: "2026-11-09", Description: "Bank fee", Amount: "-5.00"}}); err != nil {
		t.Fatal(err)
	}
	list, _ := svc.List(ctx, fx.Principal, fx.bank, "", 0)
	var supplierLine, feeLine bankrec.Line
	for _, l := range list.Lines {
		if l.Description == "NEFT supplier" {
			supplierLine = l
		} else {
			feeLine = l
		}
	}
	if len(supplierLine.Candidates) != 1 || supplierLine.Candidates[0].Kind != bankrec.KindPayment || supplierLine.Candidates[0].ID != pay.ID {
		t.Fatalf("supplier payment candidate = %+v", supplierLine.Candidates)
	}
	if list.Summary.ReadyToSignOff {
		t.Fatal("not ready while lines are unmatched")
	}
	if err := svc.Match(ctx, fx.Principal, supplierLine.ID, bankrec.KindPayment, pay.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.Ignore(ctx, fx.Principal, feeLine.ID, " "); !errors.Is(err, bankrec.ErrInvalid) {
		t.Errorf("ignoring without a reason: %v, want ErrInvalid", err)
	}
	if err := svc.Ignore(ctx, fx.Principal, feeLine.ID, "bank charge expensed in the monthly journal"); err != nil {
		t.Fatal(err)
	}
	if err := svc.Match(ctx, fx.Principal, feeLine.ID, bankrec.KindPayment, pay.ID); !errors.Is(err, bankrec.ErrConflict) {
		t.Errorf("matching an ignored line without undoing it first: %v, want ErrConflict", err)
	}
	done, _ := svc.List(ctx, fx.Principal, fx.bank, "", 0)
	if !done.Summary.ReadyToSignOff || done.Summary.Matched != 1 || done.Summary.Ignored != 1 || done.Summary.Unmatched != 0 {
		t.Fatalf("summary = %+v, want ready to sign off", done.Summary)
	}
	// Undoing a match frees the payment for another line and reopens the line.
	if err := svc.Unmatch(ctx, fx.Principal, supplierLine.ID); err != nil {
		t.Fatal(err)
	}
	if err := svc.Unignore(ctx, fx.Principal, feeLine.ID); err != nil {
		t.Fatal(err)
	}
	reopened, _ := svc.List(ctx, fx.Principal, fx.bank, bankrec.StatusUnmatched, 0)
	if reopened.Summary.Unmatched != 2 || reopened.Summary.ReadyToSignOff {
		t.Fatalf("after undoing: %+v", reopened.Summary)
	}
	var back bankrec.Line
	for _, l := range reopened.Lines {
		if l.ID == supplierLine.ID {
			back = l
		}
	}
	if len(back.Candidates) != 1 || back.Candidates[0].ID != pay.ID {
		t.Errorf("after unmatching, the payment must be offered again: %+v", back.Candidates)
	}
}

func TestBankrec_OrganisationsAreIsolatedAndMatchingMovesNoMoney(t *testing.T) {
	ctx := context.Background()
	a := newBankFixture(t, ctx)
	b := newBankFixture(t, ctx)
	svc := newBankrec()
	if _, err := svc.ImportLines(ctx, a.Principal, a.bank, []bankrec.LineInput{{Date: "2026-11-02", Description: "A only", Amount: "10"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.List(ctx, b.Principal, a.bank, "", 0); !errors.Is(err, bankrec.ErrNotFound) {
		t.Errorf("another organisation reading this bank account: %v, want ErrNotFound", err)
	}
	if _, err := svc.ImportLines(ctx, b.Principal, a.bank, []bankrec.LineInput{{Date: "2026-11-02", Amount: "10"}}); !errors.Is(err, bankrec.ErrNotFound) {
		t.Errorf("another organisation importing into this bank account: %v, want ErrNotFound", err)
	}
	list, _ := svc.List(ctx, a.Principal, a.bank, "", 0)
	if err := svc.Match(ctx, b.Principal, list.Lines[0].ID, bankrec.KindReceipt, uuid.New()); !errors.Is(err, bankrec.ErrNotFound) {
		t.Errorf("another organisation matching this line: %v, want ErrNotFound", err)
	}

	// Matching posts nothing: the journal count and the receipt are untouched.
	day := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	r := a.receipt(t, ctx, "10.00", day, a.bank)
	var before, after int
	count := func() int {
		var n int
		if err := sharedPool.RunScoped(ctx, a.Principal.OrganisationID, func(ctx context.Context) error {
			return sharedPool.Q(ctx).QueryRow(ctx, `SELECT count(*) FROM journals WHERE organisation_id = $1`, a.Principal.OrganisationID).Scan(&n)
		}); err != nil {
			t.Fatal(err)
		}
		return n
	}
	before = count()
	if err := svc.Match(ctx, a.Principal, list.Lines[0].ID, bankrec.KindReceipt, r.ID); err != nil {
		t.Fatal(err)
	}
	after = count()
	if before != after {
		t.Fatalf("matching changed the number of journals (%d -> %d); it must post nothing", before, after)
	}
}
