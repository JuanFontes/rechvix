package fixedassets

import (
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func TestStraightLineSumsToDepreciableAmount(t *testing.T) {
	cost, residual := d("100000.00"), d("10000.00")
	acc := decimal.Zero
	for m := 0; m < 36; m++ {
		c := monthDepreciation(MethodStraightLine, cost, residual, acc, 36, m, decimal.Zero)
		if !c.IsPositive() {
			t.Fatalf("month %d charged %s", m+1, c)
		}
		acc = acc.Add(c)
	}
	if !acc.Equal(d("90000.00")) {
		t.Fatalf("accumulated %s, want 90000.00", acc)
	}
	if got := monthDepreciation(MethodStraightLine, cost, residual, acc, 36, 36, decimal.Zero); !got.IsZero() {
		t.Fatalf("a fully depreciated asset still charged %s", got)
	}
}

func TestStraightLineLastMonthAbsorbsRounding(t *testing.T) {
	cost := d("1000.00")
	acc := decimal.Zero
	for m := 0; m < 7; m++ {
		acc = acc.Add(monthDepreciation(MethodStraightLine, cost, decimal.Zero, acc, 7, m, decimal.Zero))
	}
	if !acc.Equal(cost) {
		t.Fatalf("accumulated %s, want exactly 1000.00", acc)
	}
}

func TestDecliningBalanceNeverGoesBelowResidual(t *testing.T) {
	cost, residual := d("50000.00"), d("5000.00")
	acc := decimal.Zero
	for m := 0; m < 600; m++ {
		acc = acc.Add(monthDepreciation(MethodDecliningBalance, cost, residual, acc, 60, m, d("40")))
		if cost.Sub(acc).LessThan(residual) {
			t.Fatalf("book value %s fell below residual after %d months", cost.Sub(acc), m+1)
		}
	}
	if !cost.Sub(acc).Equal(residual) {
		t.Fatalf("book value %s, want residual 5000.00 after a long time", cost.Sub(acc))
	}
}

func TestMonthEnd(t *testing.T) {
	for in, want := range map[string]string{"2026-01-15": "2026-01-31", "2028-02-01": "2028-02-29", "2026-12-31": "2026-12-31", "2026-11-30": "2026-11-30"} {
		d, _ := time.Parse("2006-01-02", in)
		if got := monthEnd(d).Format("2006-01-02"); got != want {
			t.Errorf("monthEnd(%s) = %s, want %s", in, got, want)
		}
	}
}
