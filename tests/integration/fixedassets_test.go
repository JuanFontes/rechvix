//go:build integration

package integration

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	accountingapp "rechvix/internal/modules/accounting/app"
	"rechvix/internal/modules/fixedassets"
	"rechvix/internal/platform/audit"
	"rechvix/internal/platform/permissions"
)

type assetFixture struct {
	accountingFixture
	acct *accountingapp.Service
	svc  *fixedassets.Service
}

func newAssetFixture(t *testing.T, ctx context.Context) assetFixture {
	t.Helper()
	_, _, acct, _ := newTestAccountingServices(t)
	fx := setupAccountingFixture(t, ctx, acct)
	svc := fixedassets.NewService(sharedPool, acct, permissions.NewChecker(permissions.NewPGStore(sharedPool), sharedPool), audit.NewPGRecorder(sharedPool))
	return assetFixture{accountingFixture: fx, acct: acct, svc: svc}
}

// balance is debits minus credits on one account code for the organisation.
func (f assetFixture) balance(t *testing.T, ctx context.Context, code string) decimal.Decimal {
	t.Helper()
	var bal decimal.Decimal
	err := sharedPool.RunScoped(ctx, f.Principal.OrganisationID, func(ctx context.Context) error {
		return sharedPool.Q(ctx).QueryRow(ctx, `
			SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0) FROM journal_lines l JOIN accounts a ON a.id = l.account_id
			WHERE a.organisation_id = $1 AND a.code = $2`, f.Principal.OrganisationID, code).Scan(&bal)
	})
	if err != nil {
		t.Fatalf("balance %s: %v", code, err)
	}
	return bal
}

func (f assetFixture) mustBe(t *testing.T, ctx context.Context, code, want string) {
	t.Helper()
	if got := f.balance(t, ctx, code); !got.Equal(decimal.RequireFromString(want)) {
		t.Errorf("account %s balance = %s, want %s", code, got, want)
	}
}

func TestFixedAssets_DepreciationRunsBookEachMonthOnceAndStayBalanced(t *testing.T) {
	ctx := context.Background()
	fx := newAssetFixture(t, ctx)
	a, err := fx.svc.Create(ctx, fx.Principal, fixedassets.CreateInput{
		Name: "Delivery van", Code: "VAN-1", PurchaseDate: "2026-01-10", Cost: "120000", Residual: "12000", LifeMonths: 36,
		Method: fixedassets.MethodStraightLine, BookAcquisitionFrom: "1010",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	fx.mustBe(t, ctx, "1500", "120000")
	fx.mustBe(t, ctx, "1010", "-120000")

	// January to June: six months of 3000.
	r, err := fx.svc.RunDepreciation(ctx, fx.Principal, "2026-06-15")
	if err != nil || r.Months != 6 || r.Entries != 6 || r.Total != "18000.00" {
		t.Fatalf("first run = %+v, %v", r, err)
	}
	fx.mustBe(t, ctx, "5800", "18000")
	fx.mustBe(t, ctx, "1590", "-18000")

	// Running the same month again books nothing.
	r, err = fx.svc.RunDepreciation(ctx, fx.Principal, "2026-06-30")
	if err != nil || r.Months != 0 || r.Total != "0.00" {
		t.Fatalf("repeat run = %+v, %v; want nothing booked", r, err)
	}
	fx.mustBe(t, ctx, "5800", "18000")

	reg, err := fx.svc.List(ctx, fx.Principal)
	if err != nil || len(reg.Assets) != 1 || reg.Assets[0].BookValue != "102000.00" || reg.Assets[0].DepreciatedThrough != "2026-06-30" || reg.TotalCost != "120000.00" {
		t.Fatalf("register = %+v, %v", reg, err)
	}
	sched, err := fx.svc.Schedule(ctx, fx.Principal, a.ID)
	if err != nil || len(sched) != 6 || sched[0].PeriodEnd != "2026-01-31" || sched[5].PeriodEnd != "2026-06-30" {
		t.Fatalf("schedule = %+v, %v", sched, err)
	}
}

func TestFixedAssets_LifeEndsAtResidualAndNeverBelow(t *testing.T) {
	ctx := context.Background()
	fx := newAssetFixture(t, ctx)
	if _, err := fx.svc.Create(ctx, fx.Principal, fixedassets.CreateInput{
		Name: "Laptop", PurchaseDate: "2026-01-01", Cost: "1000", Residual: "100", LifeMonths: 7, BookAcquisitionFrom: "1000",
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := fx.svc.RunDepreciation(ctx, fx.Principal, "2027-12-31"); err != nil {
		t.Fatalf("RunDepreciation: %v", err)
	}
	fx.mustBe(t, ctx, "5800", "900") // 7 months, the last absorbing rounding
	fx.mustBe(t, ctx, "1590", "-900")
}

func TestFixedAssets_DisposalBooksGainOrLossAndNeedsDepreciationFirst(t *testing.T) {
	ctx := context.Background()
	fx := newAssetFixture(t, ctx)
	a, err := fx.svc.Create(ctx, fx.Principal, fixedassets.CreateInput{
		Name: "Printer", PurchaseDate: "2026-01-05", Cost: "12000", LifeMonths: 12, BookAcquisitionFrom: "1000",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	// Three months booked (Jan-Mar, 1000 each); disposing in June needs April and May first.
	if _, err := fx.svc.RunDepreciation(ctx, fx.Principal, "2026-03-31"); err != nil {
		t.Fatalf("RunDepreciation: %v", err)
	}
	if _, err := fx.svc.Dispose(ctx, fx.Principal, a.ID, fixedassets.DisposeInput{Date: "2026-06-10", Proceeds: "8000", ProceedsAccount: "1010"}); !errors.Is(err, fixedassets.ErrConflict) {
		t.Fatalf("disposing with months missing: err = %v, want ErrConflict", err)
	}
	if _, err := fx.svc.RunDepreciation(ctx, fx.Principal, "2026-05-31"); err != nil {
		t.Fatalf("RunDepreciation: %v", err)
	}
	// Book value is 12000 - 5000 = 7000; selling for 8000 is a gain of 1000.
	out, err := fx.svc.Dispose(ctx, fx.Principal, a.ID, fixedassets.DisposeInput{Date: "2026-06-10", Proceeds: "8000", ProceedsAccount: "1010"})
	if err != nil || out.Status != fixedassets.StatusDisposed || out.BookValue != "0.00" {
		t.Fatalf("Dispose = %+v, %v", out, err)
	}
	fx.mustBe(t, ctx, "1500", "0")
	fx.mustBe(t, ctx, "1590", "0")
	fx.mustBe(t, ctx, "1010", "8000")
	fx.mustBe(t, ctx, "5950", "-1000") // a gain is a credit
	if _, err := fx.svc.Dispose(ctx, fx.Principal, a.ID, fixedassets.DisposeInput{Date: "2026-06-11"}); !errors.Is(err, fixedassets.ErrConflict) {
		t.Fatalf("disposing twice: err = %v, want ErrConflict", err)
	}
	// A disposed asset takes no further depreciation.
	if r, err := fx.svc.RunDepreciation(ctx, fx.Principal, "2026-12-31"); err != nil || r.Months != 0 {
		t.Fatalf("run after disposal = %+v, %v", r, err)
	}
}

func TestFixedAssets_ScrapIsAFullLossAndValidationRejectsBadInput(t *testing.T) {
	ctx := context.Background()
	fx := newAssetFixture(t, ctx)
	a, err := fx.svc.Create(ctx, fx.Principal, fixedassets.CreateInput{Name: "Old rack", PurchaseDate: "2026-02-01", Cost: "600", LifeMonths: 6})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := fx.svc.Dispose(ctx, fx.Principal, a.ID, fixedassets.DisposeInput{Date: "2026-02-20"}); err != nil {
		t.Fatalf("scrap in the first month: %v", err)
	}
	for name, in := range map[string]fixedassets.CreateInput{
		"no name":            {PurchaseDate: "2026-01-01", Cost: "100", LifeMonths: 12},
		"zero cost":          {Name: "x", PurchaseDate: "2026-01-01", Cost: "0", LifeMonths: 12},
		"residual too big":   {Name: "x", PurchaseDate: "2026-01-01", Cost: "100", Residual: "100", LifeMonths: 12},
		"no life":            {Name: "x", PurchaseDate: "2026-01-01", Cost: "100"},
		"db without a rate":  {Name: "x", PurchaseDate: "2026-01-01", Cost: "100", LifeMonths: 12, Method: fixedassets.MethodDecliningBalance},
		"service before buy": {Name: "x", PurchaseDate: "2026-03-01", InServiceDate: "2026-01-01", Cost: "100", LifeMonths: 12},
		"bad account":        {Name: "x", PurchaseDate: "2026-01-01", Cost: "100", LifeMonths: 12, BookAcquisitionFrom: "4000"},
	} {
		if _, err := fx.svc.Create(ctx, fx.Principal, in); !errors.Is(err, fixedassets.ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	if _, err := fx.svc.Schedule(ctx, fx.Principal, uuid.New()); !errors.Is(err, fixedassets.ErrNotFound) {
		t.Errorf("unknown asset schedule: err = %v, want ErrNotFound", err)
	}
}
