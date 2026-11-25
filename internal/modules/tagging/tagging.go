// Package tagging holds labels and custom fields: organisation-defined ways to mark and describe contacts, products and documents
// without changing their tables.
package tagging

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

	"rechvix/internal/platform/audit"
	"rechvix/internal/platform/database"
	"rechvix/internal/platform/permissions"
)

var (
	ErrInvalid  = errors.New("tagging: invalid request")
	ErrNotFound = errors.New("tagging: not found")
	ErrConflict = errors.New("tagging: conflict")
)

const (
	maxLabels        = 100
	maxFieldsPerType = 30
	maxLabelsPerItem = 20
)

// entityKinds maps each taggable entity to its table and the permissions that gate seeing and changing its tags.
var entityKinds = map[string]struct{ table, view, edit string }{
	"PARTY":             {"parties", "contacts.view", "contacts.manage"},
	"PRODUCT":           {"products", "catalogue.view", "catalogue.manage"},
	"SALES_DOCUMENT":    {"sales_documents", "sales.view", "sales.create"},
	"PURCHASE_DOCUMENT": {"purchase_documents", "purchase.view", "purchase.create"},
}

var colours = map[string]bool{"grey": true, "red": true, "orange": true, "yellow": true, "green": true, "teal": true, "blue": true, "purple": true, "pink": true}
var fieldTypes = map[string]bool{"TEXT": true, "NUMBER": true, "DATE": true, "YES_NO": true, "CHOICE": true}

type Service struct {
	pool        *database.Pool
	permissions *permissions.Checker
	audit       audit.Recorder
	now         func() time.Time
}

func NewService(pool *database.Pool, p *permissions.Checker, a audit.Recorder) *Service {
	return &Service{pool: pool, permissions: p, audit: a, now: time.Now}
}

func (s *Service) require(ctx context.Context, p permissions.Principal, code string) error {
	return s.permissions.Require(ctx, p, code, permissions.Scope{})
}

func kind(entityType string) (string, struct{ table, view, edit string }, error) {
	t := strings.ToUpper(strings.TrimSpace(entityType))
	k, ok := entityKinds[t]
	if !ok {
		return "", k, fmt.Errorf("%w: unknown kind %q", ErrNotFound, entityType)
	}
	return t, k, nil
}

func uniqueViolation(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

// ---- labels --------------------------------------------------------------------------------------------------------------------

type Label struct {
	ID     uuid.UUID `json:"id"`
	Name   string    `json:"name"`
	Colour string    `json:"colour"`
	InUse  int       `json:"in_use"`
}

func (s *Service) ListLabels(ctx context.Context, p permissions.Principal) ([]Label, error) {
	if err := s.require(ctx, p, "settings.view"); err != nil {
		return nil, err
	}
	out := []Label{}
	err := s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		rows, err := s.pool.Q(ctx).Query(ctx, `
			SELECT l.id, l.name, l.colour, (SELECT count(*) FROM label_assignments a WHERE a.label_id = l.id)
			FROM labels l WHERE l.organisation_id = $1 ORDER BY lower(l.name)`, p.OrganisationID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var l Label
			if err := rows.Scan(&l.ID, &l.Name, &l.Colour, &l.InUse); err != nil {
				return err
			}
			out = append(out, l)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Service) CreateLabel(ctx context.Context, p permissions.Principal, name, colour string) (*Label, error) {
	if err := s.require(ctx, p, "settings.manage"); err != nil {
		return nil, err
	}
	name = strings.TrimSpace(name)
	if colour == "" {
		colour = "grey"
	}
	if name == "" || len([]rune(name)) > 40 || !colours[colour] {
		return nil, fmt.Errorf("%w: give the label a name of up to 40 characters and pick one of the colours", ErrInvalid)
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	l := &Label{ID: id, Name: name, Colour: colour}
	err = s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		var n int
		if err := s.pool.Q(ctx).QueryRow(ctx, `SELECT count(*) FROM labels WHERE organisation_id = $1`, p.OrganisationID).Scan(&n); err != nil {
			return err
		}
		if n >= maxLabels {
			return fmt.Errorf("%w: you can have at most %d labels", ErrConflict, maxLabels)
		}
		if _, err := s.pool.Q(ctx).Exec(ctx, `INSERT INTO labels (id, organisation_id, name, colour, created_by) VALUES ($1,$2,$3,$4,$5)`, id, p.OrganisationID, name, colour, p.UserID); err != nil {
			if uniqueViolation(err) {
				return fmt.Errorf("%w: a label called %q already exists", ErrConflict, name)
			}
			return err
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "tagging.label_created", EntityType: "label", EntityID: &id, AfterState: map[string]any{"name": name}, At: s.now()})
	})
	if err != nil {
		return nil, err
	}
	return l, nil
}

func (s *Service) DeleteLabel(ctx context.Context, p permissions.Principal, id uuid.UUID) error {
	if err := s.require(ctx, p, "settings.manage"); err != nil {
		return err
	}
	return s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		n, err := s.pool.Q(ctx).Exec(ctx, `DELETE FROM labels WHERE organisation_id = $1 AND id = $2`, p.OrganisationID, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: label", ErrNotFound)
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "tagging.label_deleted", EntityType: "label", EntityID: &id, At: s.now()})
	})
}

// ---- custom field definitions --------------------------------------------------------------------------------------------------

type FieldDef struct {
	ID         uuid.UUID `json:"id"`
	EntityType string    `json:"entity_type"`
	Name       string    `json:"name"`
	Type       string    `json:"type"`
	Options    []string  `json:"options,omitempty"`
}

type FieldInput struct {
	EntityType string   `json:"entity_type"`
	Name       string   `json:"name"`
	Type       string   `json:"type"`
	Options    []string `json:"options"`
}

func (s *Service) ListFields(ctx context.Context, p permissions.Principal, entityType string) ([]FieldDef, error) {
	if err := s.require(ctx, p, "settings.view"); err != nil {
		return nil, err
	}
	filter := ""
	if strings.TrimSpace(entityType) != "" {
		t, _, err := kind(entityType)
		if err != nil {
			return nil, err
		}
		filter = t
	}
	out := []FieldDef{}
	err := s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		rows, err := s.pool.Q(ctx).Query(ctx, `
			SELECT id, entity_type, name, field_type, options FROM custom_field_definitions
			WHERE organisation_id = $1 AND ($2 = '' OR entity_type = $2) ORDER BY entity_type, position, lower(name)`, p.OrganisationID, filter)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var f FieldDef
			if err := rows.Scan(&f.ID, &f.EntityType, &f.Name, &f.Type, &f.Options); err != nil {
				return err
			}
			out = append(out, f)
		}
		return rows.Err()
	})
	return out, err
}

func (s *Service) CreateField(ctx context.Context, p permissions.Principal, in FieldInput) (*FieldDef, error) {
	if err := s.require(ctx, p, "settings.manage"); err != nil {
		return nil, err
	}
	t, _, err := kind(in.EntityType)
	if err != nil {
		return nil, fmt.Errorf("%w: choose where the field applies (contacts, products, sales or purchase documents)", ErrInvalid)
	}
	name := strings.TrimSpace(in.Name)
	ft := strings.ToUpper(strings.TrimSpace(in.Type))
	if name == "" || len([]rune(name)) > 60 || !fieldTypes[ft] {
		return nil, fmt.Errorf("%w: give the field a name of up to 60 characters and a type", ErrInvalid)
	}
	opts := []string{}
	if ft == "CHOICE" {
		seen := map[string]bool{}
		for _, o := range in.Options {
			o = strings.TrimSpace(o)
			if o == "" || seen[strings.ToLower(o)] {
				continue
			}
			if len([]rune(o)) > 100 {
				return nil, fmt.Errorf("%w: a choice can be at most 100 characters", ErrInvalid)
			}
			seen[strings.ToLower(o)] = true
			opts = append(opts, o)
		}
		if len(opts) < 2 || len(opts) > 50 {
			return nil, fmt.Errorf("%w: a choice field needs between 2 and 50 different choices", ErrInvalid)
		}
	}
	id, err := uuid.NewV7()
	if err != nil {
		return nil, err
	}
	def := &FieldDef{ID: id, EntityType: t, Name: name, Type: ft, Options: opts}
	err = s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		var n int
		if err := s.pool.Q(ctx).QueryRow(ctx, `SELECT count(*) FROM custom_field_definitions WHERE organisation_id = $1 AND entity_type = $2`, p.OrganisationID, t).Scan(&n); err != nil {
			return err
		}
		if n >= maxFieldsPerType {
			return fmt.Errorf("%w: at most %d custom fields for each kind", ErrConflict, maxFieldsPerType)
		}
		if _, err := s.pool.Q(ctx).Exec(ctx, `INSERT INTO custom_field_definitions (id, organisation_id, entity_type, name, field_type, options, position, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
			id, p.OrganisationID, t, name, ft, opts, n, p.UserID); err != nil {
			if uniqueViolation(err) {
				return fmt.Errorf("%w: a field called %q already exists here", ErrConflict, name)
			}
			return err
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "tagging.field_created", EntityType: "custom_field", EntityID: &id, AfterState: map[string]any{"name": name, "type": ft, "entity": t}, At: s.now()})
	})
	if err != nil {
		return nil, err
	}
	return def, nil
}

// DeleteField removes the field and every answer given to it.
func (s *Service) DeleteField(ctx context.Context, p permissions.Principal, id uuid.UUID) error {
	if err := s.require(ctx, p, "settings.manage"); err != nil {
		return err
	}
	return s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		n, err := s.pool.Q(ctx).Exec(ctx, `DELETE FROM custom_field_definitions WHERE organisation_id = $1 AND id = $2`, p.OrganisationID, id)
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("%w: field", ErrNotFound)
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "tagging.field_deleted", EntityType: "custom_field", EntityID: &id, At: s.now()})
	})
}

// ---- tags on one entity --------------------------------------------------------------------------------------------------------

type FieldValue struct {
	FieldDef
	Value string `json:"value"`
}

type Tags struct {
	Labels []Label      `json:"labels"`
	Fields []FieldValue `json:"fields"`
}

func (s *Service) requireEntity(ctx context.Context, orgID uuid.UUID, table string, id uuid.UUID) error {
	var ok bool
	err := s.pool.Q(ctx).QueryRow(ctx, `SELECT true FROM `+table+` WHERE organisation_id = $1 AND id = $2`, orgID, id).Scan(&ok)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%w: the item", ErrNotFound)
	}
	return err
}

func (s *Service) Get(ctx context.Context, p permissions.Principal, entityType string, id uuid.UUID) (*Tags, error) {
	t, k, err := kind(entityType)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, p, k.view); err != nil {
		return nil, err
	}
	out := &Tags{Labels: []Label{}, Fields: []FieldValue{}}
	err = s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		if err := s.requireEntity(ctx, p.OrganisationID, k.table, id); err != nil {
			return err
		}
		rows, err := s.pool.Q(ctx).Query(ctx, `
			SELECT l.id, l.name, l.colour FROM label_assignments a JOIN labels l ON l.id = a.label_id
			WHERE a.organisation_id = $1 AND a.entity_type = $2 AND a.entity_id = $3 ORDER BY lower(l.name)`, p.OrganisationID, t, id)
		if err != nil {
			return err
		}
		for rows.Next() {
			var l Label
			if err := rows.Scan(&l.ID, &l.Name, &l.Colour); err != nil {
				rows.Close()
				return err
			}
			out.Labels = append(out.Labels, l)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		rows, err = s.pool.Q(ctx).Query(ctx, `
			SELECT d.id, d.entity_type, d.name, d.field_type, d.options, coalesce(v.value, '')
			FROM custom_field_definitions d LEFT JOIN custom_field_values v ON v.field_id = d.id AND v.entity_id = $3
			WHERE d.organisation_id = $1 AND d.entity_type = $2 ORDER BY d.position, lower(d.name)`, p.OrganisationID, t, id)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var f FieldValue
			if err := rows.Scan(&f.ID, &f.EntityType, &f.Name, &f.Type, &f.Options, &f.Value); err != nil {
				return err
			}
			out.Fields = append(out.Fields, f)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SetLabels replaces the labels on an entity with exactly ids.
func (s *Service) SetLabels(ctx context.Context, p permissions.Principal, entityType string, id uuid.UUID, ids []uuid.UUID) error {
	t, k, err := kind(entityType)
	if err != nil {
		return err
	}
	if err := s.require(ctx, p, k.edit); err != nil {
		return err
	}
	uniq := map[uuid.UUID]bool{}
	for _, l := range ids {
		uniq[l] = true
	}
	if len(uniq) > maxLabelsPerItem {
		return fmt.Errorf("%w: at most %d labels on one item", ErrInvalid, maxLabelsPerItem)
	}
	return s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		if err := s.requireEntity(ctx, p.OrganisationID, k.table, id); err != nil {
			return err
		}
		for l := range uniq {
			var ok bool
			if err := s.pool.Q(ctx).QueryRow(ctx, `SELECT true FROM labels WHERE organisation_id = $1 AND id = $2`, p.OrganisationID, l).Scan(&ok); err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					return fmt.Errorf("%w: label", ErrNotFound)
				}
				return err
			}
		}
		if _, err := s.pool.Q(ctx).Exec(ctx, `DELETE FROM label_assignments WHERE organisation_id = $1 AND entity_type = $2 AND entity_id = $3`, p.OrganisationID, t, id); err != nil {
			return err
		}
		for l := range uniq {
			if _, err := s.pool.Q(ctx).Exec(ctx, `INSERT INTO label_assignments (organisation_id, label_id, entity_type, entity_id) VALUES ($1,$2,$3,$4)`, p.OrganisationID, l, t, id); err != nil {
				return err
			}
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "tagging.labels_set", EntityType: strings.ToLower(t), EntityID: &id, AfterState: map[string]any{"count": len(uniq)}, At: s.now()})
	})
}

func checkValue(def FieldDef, v string) (string, error) {
	v = strings.TrimSpace(v)
	bad := func(what string) error { return fmt.Errorf("%w: %q needs %s", ErrInvalid, def.Name, what) }
	switch def.Type {
	case "TEXT":
		if len([]rune(v)) > 500 {
			return "", bad("500 characters or fewer")
		}
	case "NUMBER":
		d, err := decimal.NewFromString(v)
		if err != nil || d.Exponent() < -6 || d.Abs().GreaterThanOrEqual(decimal.New(1, 15)) {
			return "", bad("a number")
		}
		return d.String(), nil
	case "DATE":
		if _, err := time.Parse("2006-01-02", v); err != nil {
			return "", bad("a date as YYYY-MM-DD")
		}
	case "YES_NO":
		switch strings.ToLower(v) {
		case "yes", "no":
			return strings.ToLower(v), nil
		}
		return "", bad("yes or no")
	case "CHOICE":
		for _, o := range def.Options {
			if strings.EqualFold(o, v) {
				return o, nil
			}
		}
		return "", bad("one of: " + strings.Join(def.Options, ", "))
	}
	return v, nil
}

// SetFields saves the given answers; an empty answer clears the field. Fields not mentioned are left alone.
func (s *Service) SetFields(ctx context.Context, p permissions.Principal, entityType string, id uuid.UUID, values map[uuid.UUID]string) error {
	t, k, err := kind(entityType)
	if err != nil {
		return err
	}
	if err := s.require(ctx, p, k.edit); err != nil {
		return err
	}
	return s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		if err := s.requireEntity(ctx, p.OrganisationID, k.table, id); err != nil {
			return err
		}
		for fid, raw := range values {
			var def FieldDef
			err := s.pool.Q(ctx).QueryRow(ctx, `SELECT id, entity_type, name, field_type, options FROM custom_field_definitions WHERE organisation_id = $1 AND id = $2 AND entity_type = $3`,
				p.OrganisationID, fid, t).Scan(&def.ID, &def.EntityType, &def.Name, &def.Type, &def.Options)
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("%w: field", ErrNotFound)
			}
			if err != nil {
				return err
			}
			if strings.TrimSpace(raw) == "" {
				if _, err := s.pool.Q(ctx).Exec(ctx, `DELETE FROM custom_field_values WHERE field_id = $1 AND entity_id = $2`, fid, id); err != nil {
					return err
				}
				continue
			}
			v, err := checkValue(def, raw)
			if err != nil {
				return err
			}
			if _, err := s.pool.Q(ctx).Exec(ctx, `
				INSERT INTO custom_field_values (organisation_id, field_id, entity_type, entity_id, value, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
				ON CONFLICT (field_id, entity_id) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
				p.OrganisationID, fid, t, id, v, p.UserID); err != nil {
				return err
			}
		}
		return s.audit.Record(ctx, audit.Entry{OrganisationID: p.OrganisationID, ActorUserID: &p.UserID, ActorType: audit.ActorUser,
			Action: "tagging.fields_set", EntityType: strings.ToLower(t), EntityID: &id, AfterState: map[string]any{"fields": len(values)}, At: s.now()})
	})
}

// WithLabel lists the ids of every entity of one kind carrying a label, for filtering a list screen.
func (s *Service) WithLabel(ctx context.Context, p permissions.Principal, entityType string, labelID uuid.UUID) ([]uuid.UUID, error) {
	t, k, err := kind(entityType)
	if err != nil {
		return nil, err
	}
	if err := s.require(ctx, p, k.view); err != nil {
		return nil, err
	}
	out := []uuid.UUID{}
	err = s.pool.RunScoped(ctx, p.OrganisationID, func(ctx context.Context) error {
		rows, err := s.pool.Q(ctx).Query(ctx, `SELECT entity_id FROM label_assignments WHERE organisation_id = $1 AND label_id = $2 AND entity_type = $3 LIMIT 5000`, p.OrganisationID, labelID, t)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var e uuid.UUID
			if err := rows.Scan(&e); err != nil {
				return err
			}
			out = append(out, e)
		}
		return rows.Err()
	})
	return out, err
}
