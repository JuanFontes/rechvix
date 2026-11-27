package reminders

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/shopspring/decimal"

	"rechvix/internal/platform/permissions"
)

// Activity is one reminder somebody prepared or handed off by hand. Status never claims delivery.
type Activity struct {
	ID         uuid.UUID  `json:"id"`
	PartyID    uuid.UUID  `json:"party_id"`
	DocumentID *uuid.UUID `json:"sales_document_id,omitempty"`
	Channel    string     `json:"channel"`
	Status     string     `json:"status"`
	WithPDF    bool       `json:"with_pdf"`
	// Outstanding is the balance at the time, as a decimal string, or "" when unknown.
	Outstanding string    `json:"outstanding,omitempty"`
	ClientRef   string    `json:"client_ref"`
	OccurredAt  time.Time `json:"occurred_at"`
}

var (
	channels = map[string]bool{"whatsapp": true, "share": true, "text": true, "email": true, "sms": true, "other": true}
	statuses = map[string]bool{"prepared": true, "share_opened": true, "marked_sent": true, "cancelled": true}
)

// RecordActivity stores one hand-off. Recording the same client_ref again returns the stored row unchanged, so a retried upload books once.
func (s *Service) RecordActivity(ctx context.Context, principal permissions.Principal, in Activity) (*Activity, error) {
	if err := s.permissions.Require(ctx, principal, "sales.view", permissions.Scope{}); err != nil {
		return nil, err
	}
	in.ClientRef = strings.TrimSpace(in.ClientRef)
	if in.PartyID == uuid.Nil || in.ClientRef == "" || len(in.ClientRef) > 100 || !channels[in.Channel] || !statuses[in.Status] {
		return nil, fmt.Errorf("%w: party, client_ref, a known channel and a known status are required", ErrInvalid)
	}
	var out *Activity
	var outstanding any
	if in.Outstanding != "" {
		d, err := decimal.NewFromString(in.Outstanding)
		if err != nil || d.IsNegative() {
			return nil, fmt.Errorf("%w: outstanding must be a non-negative decimal", ErrInvalid)
		}
		outstanding = d
	}
	if in.OccurredAt.IsZero() {
		in.OccurredAt = s.now()
	}
	err := s.pool.RunScoped(ctx, principal.OrganisationID, func(ctx context.Context) error {
		id := uuid.New()
		if _, err := s.pool.Q(ctx).Exec(ctx, `
			INSERT INTO reminder_activity (id, organisation_id, party_id, sales_document_id, channel, status, with_pdf, outstanding, client_ref, occurred_at, created_by)
			VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
			ON CONFLICT (organisation_id, client_ref) DO NOTHING`,
			id, principal.OrganisationID, in.PartyID, in.DocumentID, in.Channel, in.Status, in.WithPDF, outstanding, in.ClientRef, in.OccurredAt, principal.UserID); err != nil {
			return fmt.Errorf("reminders: recording activity: %w", err)
		}
		row, err := s.activityByRef(ctx, principal.OrganisationID, in.ClientRef)
		out = row
		return err
	})
	return out, err
}

func (s *Service) activityByRef(ctx context.Context, org uuid.UUID, ref string) (*Activity, error) {
	var a Activity
	var outstanding *string
	err := s.pool.Q(ctx).QueryRow(ctx, `
		SELECT id, party_id, sales_document_id, channel, status, with_pdf, outstanding::text, client_ref, occurred_at
		FROM reminder_activity WHERE organisation_id = $1 AND client_ref = $2`, org, ref).
		Scan(&a.ID, &a.PartyID, &a.DocumentID, &a.Channel, &a.Status, &a.WithPDF, &outstanding, &a.ClientRef, &a.OccurredAt)
	if err != nil {
		return nil, err
	}
	if outstanding != nil {
		a.Outstanding = *outstanding
	}
	return &a, nil
}

// ListActivity returns the newest hand-offs, optionally for one customer or one invoice.
func (s *Service) ListActivity(ctx context.Context, principal permissions.Principal, partyID, documentID *uuid.UUID) ([]Activity, error) {
	if err := s.permissions.Require(ctx, principal, "sales.view", permissions.Scope{}); err != nil {
		return nil, err
	}
	var out []Activity
	err := s.pool.RunScoped(ctx, principal.OrganisationID, func(ctx context.Context) error {
		rows, err := s.pool.Q(ctx).Query(ctx, `
			SELECT id, party_id, sales_document_id, channel, status, with_pdf, outstanding::text, client_ref, occurred_at
			FROM reminder_activity
			WHERE organisation_id = $1 AND ($2::uuid IS NULL OR party_id = $2) AND ($3::uuid IS NULL OR sales_document_id = $3)
			ORDER BY occurred_at DESC LIMIT 200`, principal.OrganisationID, partyID, documentID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var a Activity
			var outstanding *string
			if err := rows.Scan(&a.ID, &a.PartyID, &a.DocumentID, &a.Channel, &a.Status, &a.WithPDF, &outstanding, &a.ClientRef, &a.OccurredAt); err != nil {
				return err
			}
			if outstanding != nil {
				a.Outstanding = *outstanding
			}
			out = append(out, a)
		}
		return rows.Err()
	})
	return out, err
}
