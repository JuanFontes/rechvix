// Package bankrec reconciles imported bank-statement lines with the receipts and supplier payments already booked. It never posts a
// journal: matching only records that the bank agrees with the books.
package bankrec

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/shopspring/decimal"

	"rechvix/internal/platform/audit"
	"rechvix/internal/platform/database"
	"rechvix/internal/platform/permissions"
)

var (
	ErrInvalid    = errors.New("bankrec: invalid request")
	ErrNotFound   = errors.New("bankrec: not found")
	ErrConflict   = errors.New("bankrec: conflict")
	maxImportRows = 5000
)

const (
	StatusUnmatched = "UNMATCHED"
	StatusMatched   = "MATCHED"
	StatusIgnored   = "IGNORED"
	KindReceipt     = "RECEIPT"
	KindPayment     = "PAYMENT"
	// A statement posts a day or two after the books, so a candidate may be this many days either side of the bank date.
	matchWindowDays = 7
)

type Service struct {
	pool        *database.Pool
	permissions *permissions.Checker
	audit       audit.Recorder
	now         func() time.Time
}

func NewService(pool *database.Pool, p *permissions.Checker, a audit.Recorder) *Service {
	return &Service{pool: pool, permissions: p, audit: a, now: time.Now}
}

func (s *Service) view(ctx context.Context, p permissions.Principal) error {
	return s.permissions.Require(ctx, p, "accounting.view", permissions.Scope{})
}
func (s *Service) reconcile(ctx context.Context, p permissions.Principal) error {
	return s.permissions.Require(ctx, p, "accounting.reconcile", permissions.Scope{})
}

// LineInput is one row of a statement as the user supplies it. Amount is signed: positive money in, negative money out.
type LineInput struct {
	Date        string `json:"date"` // YYYY-MM-DD
	Description string `json:"description"`
	Reference   string `json:"reference"`
	Amount      string `json:"amount"`
}

type ImportResult struct {
	Added      int `json:"added"`
	Duplicates int `json:"duplicates"`
}

type parsedLine struct {
	date        time.Time
	description string
	reference   string
	amount      decimal.Decimal
	hash        string
}

func lineHash(date string, amount decimal.Decimal, description, reference string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{date, amount.StringFixed(6), strings.ToLower(strings.TrimSpace(description)), strings.ToLower(strings.TrimSpace(reference))}, "\x1f")))
	return hex.EncodeToString(sum[:])
}

func parseLines(in []LineInput) ([]parsedLine, error) {
	if len(in) == 0 {
		return nil, fmt.Errorf("%w: the statement has no lines", ErrInvalid)
	}
	if len(in) > maxImportRows {
		return nil, fmt.Errorf("%w: at most %d lines can be imported at once", ErrInvalid, maxImportRows)
	}
	out := make([]parsedLine, 0, len(in))
	for i, l := range in {
		row := i + 1
		d, err := time.Parse("2006-01-02", strings.TrimSpace(l.Date))
		if err != nil {
			return nil, fmt.Errorf("%w: line %d has no valid date (use YYYY-MM-DD)", ErrInvalid, row)
		}
		a, err := decimal.NewFromString(strings.TrimSpace(l.Amount))
		if err != nil || a.IsZero() {
			return nil, fmt.Errorf("%w: line %d needs a non-zero amount", ErrInvalid, row)
		}
		if a.Exponent() < -6 || a.Abs().GreaterThanOrEqual(decimal.New(1, 13)) {
			return nil, fmt.Errorf("%w: line %d has an amount out of range", ErrInvalid, row)
		}
		desc, ref := strings.TrimSpace(l.Description), strings.TrimSpace(l.Reference)
		if len(desc) > 500 || len(ref) > 200 {
			return nil, fmt.Errorf("%w: line %d has a description or reference that is too long", ErrInvalid, row)
		}
		out = append(out, parsedLine{date: d, description: desc, reference: ref, amount: a, hash: lineHash(d.Format("2006-01-02"), a, desc, ref)})
	}
	return out, nil
}

func (s *Service) requireBankAccount(ctx context.Context, orgID, id uuid.UUID) error {
	var active bool
	err := s.pool.Q(ctx).QueryRow(ctx, `SELECT is_active FROM bank_accounts WHERE organisation_id = $1 AND id = $2`, orgID, id).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: bank account", ErrNotFound)
	}
	return err
}

// ImportLines adds statement lines to a bank account. It is safe to run again with the same or an overlapping statement: lines already
// present are counted as duplicates and not added twice.
func (s *Service) ImportLines(ctx context.Context, principal permissions.Principal, bankAccountID uuid.UUID, in []LineInput) (*ImportResult, error) {
	if err := s.reconcile(ctx, principal); err != nil {
		return nil, err
	}
	lines, err := parseLines(in)
	if err != nil {
		return nil, err
	}
	res := &ImportResult{}
	err = s.pool.RunScoped(ctx, principal.OrganisationID, func(ctx context.Context) error {
		if err := s.requireBankAccount(ctx, principal.OrganisationID, bankAccountID); err != nil {
			return err
		}
		seen := map[string]int{}
		for _, l := range lines {
			seen[l.hash]++
			id, err := uuid.NewV7()
			if err != nil {
				return err
			}
			n, err := s.pool.Q(ctx).Exec(ctx, `
				INSERT INTO bank_statement_lines (id, organisation_id, bank_account_id, line_date, description, reference, amount, line_hash, occurrence, imported_by)
				VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
				ON CONFLICT (organisation_id, bank_account_id, line_hash, occurrence) DO NOTHING`,
				id, principal.OrganisationID, bankAccountID, l.date, l.description, l.reference, l.amount, l.hash, seen[l.hash], principal.UserID)
			if err != nil {
				return err
			}
			if n == 1 {
				res.Added++
			} else {
				res.Duplicates++
			}
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: principal.OrganisationID, ActorUserID: &principal.UserID, ActorType: audit.ActorUser,
			Action: "bankrec.statement_imported", EntityType: "bank_account", EntityID: &bankAccountID,
			AfterState: map[string]any{"added": res.Added, "duplicates": res.Duplicates}, At: s.now()})
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

type Candidate struct {
	Kind      string    `json:"kind"`
	ID        uuid.UUID `json:"id"`
	Amount    string    `json:"amount"`
	Date      time.Time `json:"date"`
	Reference string    `json:"reference"`
	Party     string    `json:"party"`
}

type Line struct {
	ID          uuid.UUID   `json:"id"`
	Date        string      `json:"date"`
	Description string      `json:"description"`
	Reference   string      `json:"reference"`
	Amount      string      `json:"amount"`
	Status      string      `json:"status"`
	MatchedKind string      `json:"matched_kind,omitempty"`
	MatchedID   *uuid.UUID  `json:"matched_id,omitempty"`
	Note        string      `json:"note,omitempty"`
	Candidates  []Candidate `json:"candidates,omitempty"`
}

type Summary struct {
	Unmatched      int    `json:"unmatched"`
	Matched        int    `json:"matched"`
	Ignored        int    `json:"ignored"`
	UnmatchedIn    string `json:"unmatched_in"`
	UnmatchedOut   string `json:"unmatched_out"`
	StatementNet   string `json:"statement_net"`
	LinesTotal     int    `json:"lines_total"`
	ReadyToSignOff bool   `json:"ready_to_sign_off"`
}

type ListResult struct {
	Lines   []Line  `json:"lines"`
	Summary Summary `json:"summary"`
}

// List returns a bank account's statement lines (newest first) with, for unmatched lines, the booked receipts or payments they could be.
func (s *Service) List(ctx context.Context, principal permissions.Principal, bankAccountID uuid.UUID, status string, limit int) (*ListResult, error) {
	if err := s.view(ctx, principal); err != nil {
		return nil, err
	}
	status = strings.ToUpper(strings.TrimSpace(status))
	if status != "" && status != StatusUnmatched && status != StatusMatched && status != StatusIgnored {
		return nil, fmt.Errorf("%w: unknown status filter", ErrInvalid)
	}
	if limit <= 0 || limit > 1000 {
		limit = 500
	}
	out := &ListResult{Lines: []Line{}}
	err := s.pool.RunScoped(ctx, principal.OrganisationID, func(ctx context.Context) error {
		if err := s.requireBankAccount(ctx, principal.OrganisationID, bankAccountID); err != nil {
			return err
		}
		rows, err := s.pool.Q(ctx).Query(ctx, `
			SELECT id, to_char(line_date, 'YYYY-MM-DD'), description, reference, amount::text, status, COALESCE(matched_kind,''), matched_id, note
			FROM bank_statement_lines
			WHERE organisation_id = $1 AND bank_account_id = $2 AND ($3 = '' OR status = $3)
			ORDER BY line_date DESC, created_at DESC, id LIMIT $4`, principal.OrganisationID, bankAccountID, status, limit)
		if err != nil {
			return err
		}
		var open []uuid.UUID
		for rows.Next() {
			var l Line
			if err := rows.Scan(&l.ID, &l.Date, &l.Description, &l.Reference, &l.Amount, &l.Status, &l.MatchedKind, &l.MatchedID, &l.Note); err != nil {
				rows.Close()
				return err
			}
			if l.Status == StatusUnmatched {
				open = append(open, l.ID)
			}
			out.Lines = append(out.Lines, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(open) > 0 {
			cands, err := s.candidates(ctx, principal.OrganisationID, open)
			if err != nil {
				return err
			}
			for i := range out.Lines {
				out.Lines[i].Candidates = cands[out.Lines[i].ID]
			}
		}
		return s.pool.Q(ctx).QueryRow(ctx, `
			SELECT count(*) FILTER (WHERE status = 'UNMATCHED'), count(*) FILTER (WHERE status = 'MATCHED'), count(*) FILTER (WHERE status = 'IGNORED'),
			       COALESCE(sum(amount) FILTER (WHERE status = 'UNMATCHED' AND amount > 0), 0)::text,
			       COALESCE(-sum(amount) FILTER (WHERE status = 'UNMATCHED' AND amount < 0), 0)::text,
			       COALESCE(sum(amount), 0)::text, count(*)
			FROM bank_statement_lines WHERE organisation_id = $1 AND bank_account_id = $2`, principal.OrganisationID, bankAccountID).
			Scan(&out.Summary.Unmatched, &out.Summary.Matched, &out.Summary.Ignored, &out.Summary.UnmatchedIn, &out.Summary.UnmatchedOut, &out.Summary.StatementNet, &out.Summary.LinesTotal)
	})
	if err != nil {
		return nil, err
	}
	out.Summary.ReadyToSignOff = out.Summary.LinesTotal > 0 && out.Summary.Unmatched == 0
	return out, nil
}

// candidates finds, for each given unmatched line, the booked receipts (money in) or supplier payments (money out) on the same bank
// account with exactly the same amount within a week of the bank date, that are not already the match of another line. A reversed receipt
// is never offered.
func (s *Service) candidates(ctx context.Context, orgID uuid.UUID, lineIDs []uuid.UUID) (map[uuid.UUID][]Candidate, error) {
	rows, err := s.pool.Q(ctx).Query(ctx, `
		SELECT l.id, 'RECEIPT', r.id, r.amount::text, r.received_at, COALESCE(r.reference_number,''), COALESCE(p.legal_name,'')
		FROM bank_statement_lines l
		JOIN receipts r ON r.organisation_id = l.organisation_id AND r.bank_account_id = l.bank_account_id AND r.amount = l.amount AND r.reversed_at IS NULL
		     AND r.received_at::date BETWEEN l.line_date - $3::int AND l.line_date + $3::int
		LEFT JOIN parties p ON p.id = r.party_id
		WHERE l.organisation_id = $1 AND l.id = ANY($2) AND l.status = 'UNMATCHED' AND l.amount > 0
		  AND NOT EXISTS (SELECT 1 FROM bank_statement_lines m WHERE m.organisation_id = r.organisation_id AND m.status = 'MATCHED' AND m.matched_kind = 'RECEIPT' AND m.matched_id = r.id)
		UNION ALL
		SELECT l.id, 'PAYMENT', y.id, y.amount::text, y.paid_at, COALESCE(y.reference_number,''), COALESCE(p.legal_name,'')
		FROM bank_statement_lines l
		JOIN payments y ON y.organisation_id = l.organisation_id AND y.bank_account_id = l.bank_account_id AND y.amount = -l.amount
		     AND y.paid_at::date BETWEEN l.line_date - $3::int AND l.line_date + $3::int
		LEFT JOIN parties p ON p.id = y.party_id
		WHERE l.organisation_id = $1 AND l.id = ANY($2) AND l.status = 'UNMATCHED' AND l.amount < 0
		  AND NOT EXISTS (SELECT 1 FROM bank_statement_lines m WHERE m.organisation_id = y.organisation_id AND m.status = 'MATCHED' AND m.matched_kind = 'PAYMENT' AND m.matched_id = y.id)
		ORDER BY 1, 5`, orgID, lineIDs, matchWindowDays)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[uuid.UUID][]Candidate{}
	for rows.Next() {
		var lid uuid.UUID
		var c Candidate
		if err := rows.Scan(&lid, &c.Kind, &c.ID, &c.Amount, &c.Date, &c.Reference, &c.Party); err != nil {
			return nil, err
		}
		out[lid] = append(out[lid], c)
	}
	return out, rows.Err()
}

type lineRow struct {
	bankAccountID uuid.UUID
	date          time.Time
	amount        decimal.Decimal
	status        string
	kind          *string
	targetID      *uuid.UUID
}

func (s *Service) lockLine(ctx context.Context, orgID, id uuid.UUID) (*lineRow, error) {
	var r lineRow
	err := s.pool.Q(ctx).QueryRow(ctx, `SELECT bank_account_id, line_date, amount, status, matched_kind, matched_id FROM bank_statement_lines WHERE organisation_id = $1 AND id = $2 FOR UPDATE`, orgID, id).
		Scan(&r.bankAccountID, &r.date, &r.amount, &r.status, &r.kind, &r.targetID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, fmt.Errorf("%w: statement line", ErrNotFound)
	}
	return &r, err
}

func isUniqueViolation(err error) bool {
	var pe *pgconn.PgError
	return errors.As(err, &pe) && pe.Code == "23505"
}

// Match ties a statement line to a booked receipt (money in) or supplier payment (money out). The amounts must be exactly equal, the
// receipt/payment must be on the same bank account and not reversed, and it cannot already be the match of another line. Matching again
// to the same target is a no-op, so a double click is harmless.
func (s *Service) Match(ctx context.Context, principal permissions.Principal, lineID uuid.UUID, kind string, targetID uuid.UUID) error {
	if err := s.reconcile(ctx, principal); err != nil {
		return err
	}
	kind = strings.ToUpper(strings.TrimSpace(kind))
	if kind != KindReceipt && kind != KindPayment {
		return fmt.Errorf("%w: kind must be RECEIPT or PAYMENT", ErrInvalid)
	}
	return s.pool.RunScoped(ctx, principal.OrganisationID, func(ctx context.Context) error {
		l, err := s.lockLine(ctx, principal.OrganisationID, lineID)
		if err != nil {
			return err
		}
		if l.status == StatusMatched && l.kind != nil && *l.kind == kind && l.targetID != nil && *l.targetID == targetID {
			return nil
		}
		if l.status != StatusUnmatched {
			return fmt.Errorf("%w: this line is already %s; undo that first", ErrConflict, strings.ToLower(l.status))
		}
		if (kind == KindReceipt) != l.amount.IsPositive() {
			return fmt.Errorf("%w: money in matches a receipt and money out matches a supplier payment", ErrInvalid)
		}
		var amount decimal.Decimal
		var bank *uuid.UUID
		var reversed bool
		var q string
		if kind == KindReceipt {
			q = `SELECT amount, bank_account_id, reversed_at IS NOT NULL FROM receipts WHERE organisation_id = $1 AND id = $2`
		} else {
			q = `SELECT amount, bank_account_id, false FROM payments WHERE organisation_id = $1 AND id = $2`
		}
		if err := s.pool.Q(ctx).QueryRow(ctx, q, principal.OrganisationID, targetID).Scan(&amount, &bank, &reversed); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("%w: %s", ErrNotFound, strings.ToLower(kind))
			}
			return err
		}
		switch {
		case reversed:
			return fmt.Errorf("%w: that receipt was reversed", ErrConflict)
		case bank == nil || *bank != l.bankAccountID:
			return fmt.Errorf("%w: that %s was booked to a different bank account", ErrConflict, strings.ToLower(kind))
		case !amount.Equal(l.amount.Abs()):
			return fmt.Errorf("%w: the amounts differ (bank %s, books %s)", ErrConflict, l.amount.Abs().StringFixed(2), amount.StringFixed(2))
		}
		if _, err := s.pool.Q(ctx).Exec(ctx, `UPDATE bank_statement_lines SET status = 'MATCHED', matched_kind = $3, matched_id = $4, resolved_by = $5, resolved_at = now() WHERE organisation_id = $1 AND id = $2`,
			principal.OrganisationID, lineID, kind, targetID, principal.UserID); err != nil {
			if isUniqueViolation(err) {
				return fmt.Errorf("%w: that %s is already matched to another statement line", ErrConflict, strings.ToLower(kind))
			}
			return err
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: principal.OrganisationID, ActorUserID: &principal.UserID, ActorType: audit.ActorUser,
			Action: "bankrec.line_matched", EntityType: "bank_statement_line", EntityID: &lineID,
			AfterState: map[string]any{"kind": kind, "target_id": targetID, "amount": l.amount.String()}, At: s.now()})
	})
}

// Unmatch puts a matched line back to unmatched (a wrong match is undone, never edited in place).
func (s *Service) Unmatch(ctx context.Context, principal permissions.Principal, lineID uuid.UUID) error {
	return s.reopen(ctx, principal, lineID, StatusMatched, "bankrec.line_unmatched")
}

// Unignore puts an ignored line back to unmatched.
func (s *Service) Unignore(ctx context.Context, principal permissions.Principal, lineID uuid.UUID) error {
	return s.reopen(ctx, principal, lineID, StatusIgnored, "bankrec.line_unignored")
}

func (s *Service) reopen(ctx context.Context, principal permissions.Principal, lineID uuid.UUID, from, action string) error {
	if err := s.reconcile(ctx, principal); err != nil {
		return err
	}
	return s.pool.RunScoped(ctx, principal.OrganisationID, func(ctx context.Context) error {
		l, err := s.lockLine(ctx, principal.OrganisationID, lineID)
		if err != nil {
			return err
		}
		if l.status == StatusUnmatched {
			return nil
		}
		if l.status != from {
			return fmt.Errorf("%w: this line is %s", ErrConflict, strings.ToLower(l.status))
		}
		if _, err := s.pool.Q(ctx).Exec(ctx, `UPDATE bank_statement_lines SET status = 'UNMATCHED', matched_kind = NULL, matched_id = NULL, note = '', resolved_by = NULL, resolved_at = NULL WHERE organisation_id = $1 AND id = $2`,
			principal.OrganisationID, lineID); err != nil {
			return err
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: principal.OrganisationID, ActorUserID: &principal.UserID, ActorType: audit.ActorUser,
			Action: action, EntityType: "bank_statement_line", EntityID: &lineID, BeforeState: map[string]any{"status": l.status, "target_id": l.targetID}, At: s.now()})
	})
}

// Ignore sets a line aside with a reason (a bank fee already expensed another way, an internal transfer, and so on). The reason is required.
func (s *Service) Ignore(ctx context.Context, principal permissions.Principal, lineID uuid.UUID, note string) error {
	if err := s.reconcile(ctx, principal); err != nil {
		return err
	}
	note = strings.TrimSpace(note)
	if len(note) < 3 || len(note) > 500 {
		return fmt.Errorf("%w: say why this line is ignored (3 to 500 characters)", ErrInvalid)
	}
	return s.pool.RunScoped(ctx, principal.OrganisationID, func(ctx context.Context) error {
		l, err := s.lockLine(ctx, principal.OrganisationID, lineID)
		if err != nil {
			return err
		}
		if l.status == StatusIgnored {
			return nil
		}
		if l.status != StatusUnmatched {
			return fmt.Errorf("%w: this line is already matched; undo that first", ErrConflict)
		}
		if _, err := s.pool.Q(ctx).Exec(ctx, `UPDATE bank_statement_lines SET status = 'IGNORED', note = $3, resolved_by = $4, resolved_at = now() WHERE organisation_id = $1 AND id = $2`,
			principal.OrganisationID, lineID, note, principal.UserID); err != nil {
			return err
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: principal.OrganisationID, ActorUserID: &principal.UserID, ActorType: audit.ActorUser,
			Action: "bankrec.line_ignored", EntityType: "bank_statement_line", EntityID: &lineID, AfterState: map[string]any{"note": note}, At: s.now()})
	})
}
