// Package fixedassets keeps the register of long-lived assets and books their depreciation and disposal through the accounting module.
// Every journal goes through accounting.PostTx, so period locks and the balanced-journal rule apply exactly as for any other posting.
package fixedassets

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"

	accountingapp "rechvix/internal/modules/accounting/app"
	accountingdomain "rechvix/internal/modules/accounting/domain"
	"rechvix/internal/platform/audit"
	"rechvix/internal/platform/database"
	"rechvix/internal/platform/permissions"
)

var (
	ErrInvalid  = errors.New("fixedassets: invalid request")
	ErrNotFound = errors.New("fixedassets: not found")
	ErrConflict = errors.New("fixedassets: conflict")
)

const (
	MethodStraightLine     = "STRAIGHT_LINE"
	MethodDecliningBalance = "DECLINING_BALANCE"
	StatusActive           = "ACTIVE"
	StatusDisposed         = "DISPOSED"

	CodeFixedAssets      = "1500"
	CodeAccumulatedDep   = "1590"
	CodeDepreciationExp  = "5800"
	CodeDisposalGainLoss = "5950"

	SourceDepreciation = "fixed_asset_depreciation"
	SourceAcquisition  = "fixed_asset_acquisition"
	SourceDisposal     = "fixed_asset_disposal"

	// A run books at most this many months at once, so one request cannot post an unbounded number of journals.
	maxMonthsPerRun = 120
)

// Accounts this module needs on top of the default chart. They are created the first time they are used, so an organisation set up before
// fixed assets existed gets them without a separate migration step.
var accountSpecs = []struct {
	code, name string
	typ        accountingdomain.AccountType
	balance    accountingdomain.NormalBalance
}{
	{CodeFixedAssets, "Fixed Assets", accountingdomain.AccountAsset, accountingdomain.BalanceDebit},
	{CodeAccumulatedDep, "Accumulated Depreciation", accountingdomain.AccountAsset, accountingdomain.BalanceCredit}, // contra
	{CodeDepreciationExp, "Depreciation Expense", accountingdomain.AccountExpense, accountingdomain.BalanceDebit},
	{CodeDisposalGainLoss, "Loss / (Gain) on Disposal of Assets", accountingdomain.AccountExpense, accountingdomain.BalanceDebit},
}

type Service struct {
	pool        *database.Pool
	accounting  *accountingapp.Service
	permissions *permissions.Checker
	audit       audit.Recorder
	now         func() time.Time
}

func NewService(pool *database.Pool, acct *accountingapp.Service, p *permissions.Checker, a audit.Recorder) *Service {
	return &Service{pool: pool, accounting: acct, permissions: p, audit: a, now: time.Now}
}

func (s *Service) view(ctx context.Context, p permissions.Principal) error {
	return s.permissions.Require(ctx, p, "accounting.view", permissions.Scope{})
}
func (s *Service) post(ctx context.Context, p permissions.Principal) error {
	return s.permissions.Require(ctx, p, "accounting.post", permissions.Scope{})
}

// ---- calculation (pure, unit-tested) -------------------------------------------------------------------------------------------

var (
	hundred = decimal.NewFromInt(100)
	twelve  = decimal.NewFromInt(12)
)

// monthEnd is the last day of the month containing d.
func monthEnd(d time.Time) time.Time {
	return time.Date(d.Year(), d.Month()+1, 0, 0, 0, 0, 0, time.UTC)
}

// monthDepreciation is the charge for one month, given the book value at the start of that month's depreciation. monthsDone counts the
// months already depreciated. The charge never takes the asset below its residual value, and the last month of a straight-line asset takes
// exactly what is left so rounding never leaves a few paise behind.
func monthDepreciation(method string, cost, residual, accumulated decimal.Decimal, lifeMonths, monthsDone int, ratePercent decimal.Decimal) decimal.Decimal {
	remaining := cost.Sub(residual).Sub(accumulated)
	if !remaining.IsPositive() {
		return decimal.Zero
	}
	var charge decimal.Decimal
	switch method {
	case MethodDecliningBalance:
		charge = cost.Sub(accumulated).Mul(ratePercent).Div(hundred).Div(twelve).Round(2)
	default:
		if monthsDone >= lifeMonths-1 {
			return remaining
		}
		charge = cost.Sub(residual).Div(decimal.NewFromInt(int64(lifeMonths))).Round(2)
	}
	if charge.GreaterThan(remaining) {
		return remaining
	}
	return charge
}

// ---- types ---------------------------------------------------------------------------------------------------------------------

type CreateInput struct {
	Code          string `json:"code"`
	Name          string `json:"name"`
	Category      string `json:"category"`
	PurchaseDate  string `json:"purchase_date"`
	InServiceDate string `json:"in_service_date"`
	Cost          string `json:"cost"`
	Residual      string `json:"residual_value"`
	LifeMonths    int    `json:"life_months"`
	Method        string `json:"method"`
	RatePercent   string `json:"rate_percent"`
	// BookAcquisitionFrom is the account the purchase was paid from: "1000" cash, "1010" bank, "3100" opening balance (an asset already
	// owned when the books start) or "2000" accounts payable. Empty means the purchase is already on the books and only the register entry
	// is made, which is right when the cost was booked through a purchase bill or an opening import.
	BookAcquisitionFrom string `json:"book_acquisition_from"`
	Note                string `json:"note"`
}

type Asset struct {
	ID                 uuid.UUID  `json:"id"`
	Code               string     `json:"code"`
	Name               string     `json:"name"`
	Category           string     `json:"category"`
	PurchaseDate       string     `json:"purchase_date"`
	InServiceDate      string     `json:"in_service_date"`
	Cost               string     `json:"cost"`
	ResidualValue      string     `json:"residual_value"`
	LifeMonths         int        `json:"life_months"`
	Method             string     `json:"method"`
	RatePercent        string     `json:"rate_percent,omitempty"`
	Accumulated        string     `json:"accumulated_depreciation"`
	BookValue          string     `json:"book_value"`
	DepreciatedThrough string     `json:"depreciated_through,omitempty"`
	Status             string     `json:"status"`
	DisposedOn         string     `json:"disposed_on,omitempty"`
	DisposalProceeds   string     `json:"disposal_proceeds,omitempty"`
	Note               string     `json:"note,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	AcquisitionJournal *uuid.UUID `json:"acquisition_journal_id,omitempty"`
	DisposalJournal    *uuid.UUID `json:"disposal_journal_id,omitempty"`
}

type Register struct {
	Assets      []Asset `json:"assets"`
	TotalCost   string  `json:"total_cost"`
	Accumulated string  `json:"total_accumulated_depreciation"`
	BookValue   string  `json:"total_book_value"`
}

type Entry struct {
	PeriodEnd string     `json:"period_end"`
	Amount    string     `json:"amount"`
	JournalID uuid.UUID  `json:"journal_id"`
	AssetID   *uuid.UUID `json:"asset_id,omitempty"`
	Asset     string     `json:"asset,omitempty"`
}

type RunResult struct {
	Months  int    `json:"months"`
	Entries int    `json:"entries"`
	Total   string `json:"total"`
}

const assetCols = `id, code, name, category, purchase_date, in_service_date, cost, residual_value, life_months, method, rate_percent,
	accumulated_depreciation, depreciated_through, status, disposed_on, disposal_proceeds, note, created_at, acquisition_journal_id, disposal_journal_id`

func scanAsset(row pgx.Row) (Asset, error) {
	var (
		a                           Asset
		purchase, inService         time.Time
		cost, residual, accumulated decimal.Decimal
		rate, proceeds              *decimal.Decimal
		through, disposed           *time.Time
	)
	if err := row.Scan(&a.ID, &a.Code, &a.Name, &a.Category, &purchase, &inService, &cost, &residual, &a.LifeMonths, &a.Method, &rate,
		&accumulated, &through, &a.Status, &disposed, &proceeds, &a.Note, &a.CreatedAt, &a.AcquisitionJournal, &a.DisposalJournal); err != nil {
		return a, err
	}
	a.PurchaseDate, a.InServiceDate = purchase.Format("2006-01-02"), inService.Format("2006-01-02")
	a.Cost, a.ResidualValue, a.Accumulated = cost.StringFixed(2), residual.StringFixed(2), accumulated.StringFixed(2)
	a.BookValue = cost.Sub(accumulated).StringFixed(2)
	if rate != nil {
		a.RatePercent = rate.String()
	}
	if through != nil {
		a.DepreciatedThrough = through.Format("2006-01-02")
	}
	if disposed != nil {
		a.DisposedOn = disposed.Format("2006-01-02")
		a.BookValue = "0.00"
	}
	if proceeds != nil {
		a.DisposalProceeds = proceeds.StringFixed(2)
	}
	return a, nil
}

// ---- reads ---------------------------------------------------------------------------------------------------------------------

func (s *Service) List(ctx context.Context, p permissions.Principal) (*Register, error) {
	if err := s.view(ctx, p); err != nil {
		return nil, err
	}
	reg := &Register{Assets: []Asset{}}
	err := s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		rows, err := s.pool.Q(ctx).Query(ctx, `SELECT `+assetCols+` FROM fixed_assets WHERE organisation_id = $1 ORDER BY status, in_service_date, created_at`, p.OrganisationID)
		if err != nil {
			return err
		}
		defer rows.Close()
		cost, acc, book := decimal.Zero, decimal.Zero, decimal.Zero
		for rows.Next() {
			a, err := scanAsset(rows)
			if err != nil {
				return err
			}
			if a.Status == StatusActive {
				c, _ := decimal.NewFromString(a.Cost)
				ad, _ := decimal.NewFromString(a.Accumulated)
				cost, acc, book = cost.Add(c), acc.Add(ad), book.Add(c.Sub(ad))
			}
			reg.Assets = append(reg.Assets, a)
		}
		reg.TotalCost, reg.Accumulated, reg.BookValue = cost.StringFixed(2), acc.StringFixed(2), book.StringFixed(2)
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return reg, nil
}

// Schedule is the depreciation booked so far for one asset, oldest first.
func (s *Service) Schedule(ctx context.Context, p permissions.Principal, id uuid.UUID) ([]Entry, error) {
	if err := s.view(ctx, p); err != nil {
		return nil, err
	}
	out := []Entry{}
	err := s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		var exists bool
		if err := s.pool.Q(ctx).QueryRow(ctx, `SELECT true FROM fixed_assets WHERE organisation_id = $1 AND id = $2`, p.OrganisationID, id).Scan(&exists); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("%w: asset", ErrNotFound)
			}
			return err
		}
		rows, err := s.pool.Q(ctx).Query(ctx, `SELECT period_end, amount, journal_id FROM fixed_asset_depreciation WHERE organisation_id = $1 AND asset_id = $2 ORDER BY period_end`, p.OrganisationID, id)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e Entry
			var end time.Time
			var amt decimal.Decimal
			if err := rows.Scan(&end, &amt, &e.JournalID); err != nil {
				return err
			}
			e.PeriodEnd, e.Amount = end.Format("2006-01-02"), amt.StringFixed(2)
			out = append(out, e)
		}
		return rows.Err()
	})
	return out, err
}

// ---- create --------------------------------------------------------------------------------------------------------------------

func parseDate(field, v string) (time.Time, error) {
	d, err := time.Parse("2006-01-02", strings.TrimSpace(v))
	if err != nil {
		return d, fmt.Errorf("%w: %s must be a date as YYYY-MM-DD", ErrInvalid, field)
	}
	return d, nil
}

func parseMoney(field, v string, allowZero bool) (decimal.Decimal, error) {
	d, err := decimal.NewFromString(strings.TrimSpace(v))
	if err != nil || d.IsNegative() || (!allowZero && d.IsZero()) || d.Exponent() < -2 || d.GreaterThanOrEqual(decimal.New(1, 13)) {
		return d, fmt.Errorf("%w: %s must be an amount with at most 2 decimals", ErrInvalid, field)
	}
	return d, nil
}

var acquisitionAccounts = map[string]bool{accountingdomain.CodeCash: true, accountingdomain.CodeBank: true, accountingdomain.CodeOpeningBalanceEquity: true, accountingdomain.CodeAccountsPayable: true}

func (s *Service) ensureAccounts(ctx context.Context, orgID uuid.UUID) error {
	for _, a := range accountSpecs {
		id, err := uuid.NewV7()
		if err != nil {
			return err
		}
		if _, err := s.pool.Q(ctx).Exec(ctx, `
			INSERT INTO accounts (id, organisation_id, code, name, account_type, normal_balance, is_system, is_active)
			VALUES ($1,$2,$3,$4,$5,$6,true,true) ON CONFLICT (organisation_id, code) DO NOTHING`,
			id, orgID, a.code, a.name, string(a.typ), string(a.balance)); err != nil {
			return err
		}
	}
	return nil
}

func postErr(err error) error {
	if errors.Is(err, accountingdomain.ErrPeriodLocked) {
		return fmt.Errorf("%w: %v", ErrConflict, "that month is in a locked period; unlock it or use a later date")
	}
	return err
}

func (s *Service) Create(ctx context.Context, p permissions.Principal, in CreateInput) (*Asset, error) {
	if err := s.post(ctx, p); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || len(name) > 200 || len(in.Code) > 60 || len(in.Category) > 100 || len(in.Note) > 1000 {
		return nil, fmt.Errorf("%w: give the asset a name (up to 200 characters)", ErrInvalid)
	}
	purchase, err := parseDate("purchase date", in.PurchaseDate)
	if err != nil {
		return nil, err
	}
	inService := purchase
	if strings.TrimSpace(in.InServiceDate) != "" {
		if inService, err = parseDate("in-service date", in.InServiceDate); err != nil {
			return nil, err
		}
	}
	if inService.Before(purchase) {
		return nil, fmt.Errorf("%w: the in-service date cannot be before the purchase date", ErrInvalid)
	}
	cost, err := parseMoney("cost", in.Cost, false)
	if err != nil {
		return nil, err
	}
	residual := decimal.Zero
	if strings.TrimSpace(in.Residual) != "" {
		if residual, err = parseMoney("residual value", in.Residual, true); err != nil {
			return nil, err
		}
	}
	if !residual.LessThan(cost) {
		return nil, fmt.Errorf("%w: the residual value must be less than the cost", ErrInvalid)
	}
	if in.LifeMonths < 1 || in.LifeMonths > 1200 {
		return nil, fmt.Errorf("%w: useful life must be between 1 and 1200 months", ErrInvalid)
	}
	method := strings.ToUpper(strings.TrimSpace(in.Method))
	if method == "" {
		method = MethodStraightLine
	}
	var rate *decimal.Decimal
	switch method {
	case MethodStraightLine:
	case MethodDecliningBalance:
		r, err := decimal.NewFromString(strings.TrimSpace(in.RatePercent))
		if err != nil || !r.IsPositive() || r.GreaterThan(hundred) || r.Exponent() < -4 {
			return nil, fmt.Errorf("%w: declining balance needs an annual rate between 0 and 100 percent", ErrInvalid)
		}
		rate = &r
	default:
		return nil, fmt.Errorf("%w: method must be STRAIGHT_LINE or DECLINING_BALANCE", ErrInvalid)
	}
	from := strings.TrimSpace(in.BookAcquisitionFrom)
	if from != "" && !acquisitionAccounts[from] {
		return nil, fmt.Errorf("%w: the purchase can be booked against cash, bank, opening balance or accounts payable", ErrInvalid)
	}

	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	var out Asset
	err = s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		if err := s.ensureAccounts(ctx, p.OrganisationID); err != nil {
			return err
		}
		var journalID *uuid.UUID
		if from != "" {
			j, err := s.accounting.PostTx(ctx, p, accountingapp.JournalRequest{
				OrganisationID: p.OrganisationID, SourceType: SourceAcquisition, SourceID: &id, JournalDate: purchase,
				Description: "Fixed asset purchase: " + name, CreatedBy: p.UserID,
				Lines: []accountingapp.JournalLineRequest{
					{AccountCode: CodeFixedAssets, Debit: cost, Description: name},
					{AccountCode: from, Credit: cost, Description: name},
				},
			})
			if err != nil {
				return postErr(err)
			}
			journalID = &j.ID
		}
		row := s.pool.Q(ctx).QueryRow(ctx, `
			INSERT INTO fixed_assets (id, organisation_id, code, name, category, purchase_date, in_service_date, cost, residual_value, life_months, method, rate_percent,
				note, created_by, acquisition_journal_id)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
			RETURNING `+assetCols,
			id, p.OrganisationID, strings.TrimSpace(in.Code), name, strings.TrimSpace(in.Category), purchase, inService, cost, residual, in.LifeMonths, method, rate,
			strings.TrimSpace(in.Note), p.UserID, journalID)
		a, err := scanAsset(row)
		if err != nil {
			var pg *pgconn.PgError
			if errors.As(err, &pg) && pg.Code == "23505" {
				return fmt.Errorf("%w: an asset with the code %q already exists", ErrConflict, strings.TrimSpace(in.Code))
			}
			return err
		}
		out = a
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "fixedassets.created", EntityType: "fixed_asset", EntityID: &id,
			AfterState: map[string]any{"name": name, "cost": cost.String(), "method": method, "booked_acquisition": from != ""}, At: s.now()})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// ---- depreciation run ----------------------------------------------------------------------------------------------------------

type dueAsset struct {
	id                        uuid.UUID
	name                      string
	cost, residual, acc, rate decimal.Decimal
	life, done                int
	method                    string
	next                      time.Time // the next month-end still to book
}

// monthsBetween counts calendar months from a to b (both month-ends), a < b.
func monthsBetween(a, b time.Time) int {
	return (b.Year()-a.Year())*12 + int(b.Month()-a.Month())
}

// RunDepreciation books every month up to and including the month containing through, for every active asset that is due. Each month is one
// journal for all assets. It is safe to run twice: months already booked are skipped.
func (s *Service) RunDepreciation(ctx context.Context, p permissions.Principal, through string) (*RunResult, error) {
	if err := s.post(ctx, p); err != nil {
		return nil, err
	}
	t, err := parseDate("through", through)
	if err != nil {
		return nil, err
	}
	limit := monthEnd(t)
	res := &RunResult{}
	total := decimal.Zero
	err = s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		if err := s.ensureAccounts(ctx, p.OrganisationID); err != nil {
			return err
		}
		rows, err := s.pool.Q(ctx).Query(ctx, `
			SELECT a.id, a.name, a.cost, a.residual_value, a.accumulated_depreciation, coalesce(a.rate_percent, 0), a.life_months, a.method,
			       a.in_service_date, a.depreciated_through,
			       (SELECT count(*) FROM fixed_asset_depreciation d WHERE d.asset_id = a.id)
			FROM fixed_assets a WHERE a.organisation_id = $1 AND a.status = 'ACTIVE' AND a.accumulated_depreciation < a.cost - a.residual_value
			ORDER BY a.in_service_date, a.created_at FOR UPDATE OF a`, p.OrganisationID)
		if err != nil {
			return err
		}
		var assets []dueAsset
		for rows.Next() {
			var a dueAsset
			var inService time.Time
			var through *time.Time
			if err := rows.Scan(&a.id, &a.name, &a.cost, &a.residual, &a.acc, &a.rate, &a.life, &a.method, &inService, &through, &a.done); err != nil {
				rows.Close()
				return err
			}
			if through != nil {
				a.next = monthEnd(through.AddDate(0, 0, 1))
			} else {
				a.next = monthEnd(inService)
			}
			assets = append(assets, a)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		// Walk month by month from the earliest due month so each month's journal covers every asset due in it.
		var start time.Time
		for _, a := range assets {
			if !a.next.After(limit) && (start.IsZero() || a.next.Before(start)) {
				start = a.next
			}
		}
		if start.IsZero() {
			return nil
		}
		if monthsBetween(start, limit) >= maxMonthsPerRun {
			return fmt.Errorf("%w: that is more than %d months of depreciation at once; run it up to an earlier month first", ErrInvalid, maxMonthsPerRun)
		}
		for m := start; !m.After(limit); m = monthEnd(m.AddDate(0, 0, 1)) {
			type share struct {
				a      *dueAsset
				amount decimal.Decimal
			}
			var shares []share
			sum := decimal.Zero
			for i := range assets {
				a := &assets[i]
				if !a.next.Equal(m) {
					continue
				}
				amt := monthDepreciation(a.method, a.cost, a.residual, a.acc, a.life, a.done, a.rate)
				a.next = monthEnd(m.AddDate(0, 0, 1))
				if !amt.IsPositive() {
					continue
				}
				shares = append(shares, share{a, amt})
				sum = sum.Add(amt)
			}
			if len(shares) == 0 {
				continue
			}
			j, err := s.accounting.PostTx(ctx, p, accountingapp.JournalRequest{
				OrganisationID: p.OrganisationID, SourceType: SourceDepreciation, JournalDate: m,
				Description: "Depreciation for " + m.Format("January 2006"), CreatedBy: p.UserID,
				Lines: []accountingapp.JournalLineRequest{
					{AccountCode: CodeDepreciationExp, Debit: sum, Description: "Depreciation " + m.Format("2006-01")},
					{AccountCode: CodeAccumulatedDep, Credit: sum, Description: "Depreciation " + m.Format("2006-01")},
				},
			})
			if err != nil {
				return postErr(err)
			}
			for _, sh := range shares {
				id, err := uuid.NewV7()
				if err != nil {
					return err
				}
				if _, err := s.pool.Q(ctx).Exec(ctx, `INSERT INTO fixed_asset_depreciation (id, organisation_id, asset_id, period_end, amount, journal_id) VALUES ($1,$2,$3,$4,$5,$6)`,
					id, p.OrganisationID, sh.a.id, m, sh.amount, j.ID); err != nil {
					return err
				}
				sh.a.acc = sh.a.acc.Add(sh.amount)
				sh.a.done++
				if _, err := s.pool.Q(ctx).Exec(ctx, `UPDATE fixed_assets SET accumulated_depreciation = $3, depreciated_through = $4 WHERE organisation_id = $1 AND id = $2`,
					p.OrganisationID, sh.a.id, sh.a.acc, m); err != nil {
					return err
				}
				res.Entries++
			}
			res.Months++
			total = total.Add(sum)
		}
		res.Total = total.StringFixed(2)
		if res.Months == 0 {
			return nil
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "fixedassets.depreciation_run", EntityType: "organisation", EntityID: &p.OrganisationID,
			AfterState: map[string]any{"through": limit.Format("2006-01-02"), "months": res.Months, "entries": res.Entries, "total": res.Total}, At: s.now()})
	})
	if err != nil {
		return nil, err
	}
	if res.Total == "" {
		res.Total = "0.00"
	}
	return res, nil
}

// ---- disposal ------------------------------------------------------------------------------------------------------------------

type DisposeInput struct {
	Date     string `json:"date"`
	Proceeds string `json:"proceeds"`
	// ProceedsAccount is where the sale money went: "1000" cash or "1010" bank. Not needed when proceeds are zero (scrapped or written off).
	ProceedsAccount string `json:"proceeds_account"`
}

// Dispose removes an asset from the books. Depreciation must already be booked up to the month before the disposal month; the disposal
// month itself takes no charge. The gain or loss is proceeds minus book value, booked to account 5950 (a debit is a loss, a credit a gain).
func (s *Service) Dispose(ctx context.Context, p permissions.Principal, id uuid.UUID, in DisposeInput) (*Asset, error) {
	if err := s.post(ctx, p); err != nil {
		return nil, err
	}
	date, err := parseDate("disposal date", in.Date)
	if err != nil {
		return nil, err
	}
	proceeds := decimal.Zero
	if strings.TrimSpace(in.Proceeds) != "" {
		if proceeds, err = parseMoney("proceeds", in.Proceeds, true); err != nil {
			return nil, err
		}
	}
	account := strings.TrimSpace(in.ProceedsAccount)
	if proceeds.IsPositive() && account != accountingdomain.CodeCash && account != accountingdomain.CodeBank {
		return nil, fmt.Errorf("%w: say whether the proceeds went to cash or bank", ErrInvalid)
	}
	var out Asset
	err = s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		if err := s.ensureAccounts(ctx, p.OrganisationID); err != nil {
			return err
		}
		row := s.pool.Q(ctx).QueryRow(ctx, `SELECT `+assetCols+` FROM fixed_assets WHERE organisation_id = $1 AND id = $2 FOR UPDATE`, p.OrganisationID, id)
		a, err := scanAsset(row)
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("%w: asset", ErrNotFound)
		}
		if err != nil {
			return err
		}
		if a.Status == StatusDisposed {
			return fmt.Errorf("%w: this asset has already been disposed of", ErrConflict)
		}
		inService, _ := time.Parse("2006-01-02", a.InServiceDate)
		if date.Before(inService) {
			return fmt.Errorf("%w: the disposal date is before the asset went into service", ErrInvalid)
		}
		cost, _ := decimal.NewFromString(a.Cost)
		acc, _ := decimal.NewFromString(a.Accumulated)
		// Every month before the disposal month must already be depreciated, or the loss would be overstated.
		due := monthEnd(monthEnd(date).AddDate(0, -1, 0))
		residual := mustDec(a.ResidualValue)
		if acc.LessThan(cost.Sub(residual)) && !due.Before(monthEnd(inService)) {
			through, _ := time.Parse("2006-01-02", a.DepreciatedThrough)
			if a.DepreciatedThrough == "" || through.Before(due) {
				return fmt.Errorf("%w: run depreciation up to %s before disposing of this asset", ErrConflict, due.Format("2 January 2006"))
			}
		}
		book := cost.Sub(acc)
		gain := proceeds.Sub(book) // positive = gain
		lines := []accountingapp.JournalLineRequest{{AccountCode: CodeFixedAssets, Credit: cost, Description: a.Name}}
		if acc.IsPositive() {
			lines = append(lines, accountingapp.JournalLineRequest{AccountCode: CodeAccumulatedDep, Debit: acc, Description: a.Name})
		}
		if proceeds.IsPositive() {
			lines = append(lines, accountingapp.JournalLineRequest{AccountCode: account, Debit: proceeds, Description: a.Name})
		}
		switch {
		case gain.IsPositive():
			lines = append(lines, accountingapp.JournalLineRequest{AccountCode: CodeDisposalGainLoss, Credit: gain, Description: "Gain on disposal of " + a.Name})
		case gain.IsNegative():
			lines = append(lines, accountingapp.JournalLineRequest{AccountCode: CodeDisposalGainLoss, Debit: gain.Neg(), Description: "Loss on disposal of " + a.Name})
		}
		j, err := s.accounting.PostTx(ctx, p, accountingapp.JournalRequest{
			OrganisationID: p.OrganisationID, SourceType: SourceDisposal, SourceID: &id, JournalDate: date,
			Description: "Disposal of fixed asset: " + a.Name, CreatedBy: p.UserID, Lines: lines,
		})
		if err != nil {
			return postErr(err)
		}
		row = s.pool.Q(ctx).QueryRow(ctx, `
			UPDATE fixed_assets SET status = 'DISPOSED', disposed_on = $3, disposal_proceeds = $4, disposal_journal_id = $5
			WHERE organisation_id = $1 AND id = $2 RETURNING `+assetCols, p.OrganisationID, id, date, proceeds, j.ID)
		if out, err = scanAsset(row); err != nil {
			return err
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "fixedassets.disposed", EntityType: "fixed_asset", EntityID: &id,
			AfterState: map[string]any{"date": date.Format("2006-01-02"), "proceeds": proceeds.String(), "gain": gain.String()}, At: s.now()})
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func mustDec(v string) decimal.Decimal {
	d, _ := decimal.NewFromString(v)
	return d
}
