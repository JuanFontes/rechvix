//go:build integration

package integration

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"rechvix/internal/modules/tagging"
	"rechvix/internal/platform/audit"
	"rechvix/internal/platform/permissions"
)

func newTagging() *tagging.Service {
	return tagging.NewService(sharedPool, permissions.NewChecker(permissions.NewPGStore(sharedPool), sharedPool), audit.NewPGRecorder(sharedPool))
}

func TestTagging_LabelsAttachReplaceAndStayInsideTheOrganisation(t *testing.T) {
	ctx := context.Background()
	fx := setupSalesFixture(t, ctx)
	other := setupSalesFixture(t, ctx)
	svc := newTagging()

	wholesale, err := svc.CreateLabel(ctx, fx.Principal, "Wholesale", "blue")
	if err != nil {
		t.Fatalf("CreateLabel: %v", err)
	}
	vip, err := svc.CreateLabel(ctx, fx.Principal, "VIP", "")
	if err != nil {
		t.Fatalf("CreateLabel: %v", err)
	}
	if _, err := svc.CreateLabel(ctx, fx.Principal, "wholesale", "red"); !errors.Is(err, tagging.ErrConflict) {
		t.Errorf("duplicate name (different case): err = %v, want ErrConflict", err)
	}
	if _, err := svc.CreateLabel(ctx, fx.Principal, "Odd", "chartreuse"); !errors.Is(err, tagging.ErrInvalid) {
		t.Errorf("unknown colour: err = %v, want ErrInvalid", err)
	}

	if err := svc.SetLabels(ctx, fx.Principal, "party", fx.CustomerID, []uuid.UUID{wholesale.ID, vip.ID, vip.ID}); err != nil {
		t.Fatalf("SetLabels: %v", err)
	}
	got, err := svc.Get(ctx, fx.Principal, "PARTY", fx.CustomerID)
	if err != nil || len(got.Labels) != 2 {
		t.Fatalf("Get = %+v, %v; want two labels", got, err)
	}
	// Setting again replaces the set.
	if err := svc.SetLabels(ctx, fx.Principal, "PARTY", fx.CustomerID, []uuid.UUID{vip.ID}); err != nil {
		t.Fatalf("SetLabels: %v", err)
	}
	ids, err := svc.WithLabel(ctx, fx.Principal, "PARTY", wholesale.ID)
	if err != nil || len(ids) != 0 {
		t.Fatalf("WithLabel(wholesale) = %v, %v; want none after replace", ids, err)
	}
	ids, _ = svc.WithLabel(ctx, fx.Principal, "PARTY", vip.ID)
	if len(ids) != 1 || ids[0] != fx.CustomerID {
		t.Fatalf("WithLabel(vip) = %v", ids)
	}
	ls, _ := svc.ListLabels(ctx, fx.Principal)
	for _, l := range ls {
		if l.ID == vip.ID && l.InUse != 1 {
			t.Errorf("VIP in_use = %d, want 1", l.InUse)
		}
	}

	// Another organisation can neither see the contact nor use this organisation's label.
	if _, err := svc.Get(ctx, other.Principal, "PARTY", fx.CustomerID); !errors.Is(err, tagging.ErrNotFound) {
		t.Errorf("other org reading the contact: err = %v, want ErrNotFound", err)
	}
	if err := svc.SetLabels(ctx, other.Principal, "PARTY", other.CustomerID, []uuid.UUID{vip.ID}); !errors.Is(err, tagging.ErrNotFound) {
		t.Errorf("other org using our label: err = %v, want ErrNotFound", err)
	}
	if ls, _ := svc.ListLabels(ctx, other.Principal); len(ls) != 0 {
		t.Errorf("other org sees %d labels", len(ls))
	}

	// Deleting a label takes it off everything.
	if err := svc.DeleteLabel(ctx, fx.Principal, vip.ID); err != nil {
		t.Fatalf("DeleteLabel: %v", err)
	}
	if got, _ := svc.Get(ctx, fx.Principal, "PARTY", fx.CustomerID); len(got.Labels) != 0 {
		t.Errorf("labels left after delete: %+v", got.Labels)
	}
	if _, err := svc.Get(ctx, fx.Principal, "WIDGET", fx.CustomerID); !errors.Is(err, tagging.ErrNotFound) {
		t.Errorf("unknown kind: err = %v, want ErrNotFound", err)
	}
}

func TestTagging_CustomFieldsAreTypeCheckedAndClearable(t *testing.T) {
	ctx := context.Background()
	fx := setupSalesFixture(t, ctx)
	svc := newTagging()
	mk := func(name, typ string, opts ...string) *tagging.FieldDef {
		f, err := svc.CreateField(ctx, fx.Principal, tagging.FieldInput{EntityType: "PARTY", Name: name, Type: typ, Options: opts})
		if err != nil {
			t.Fatalf("CreateField %s: %v", name, err)
		}
		return f
	}
	birthday, manager, credit, tier, vip := mk("Birthday", "DATE"), mk("Account manager", "TEXT"), mk("Credit limit", "NUMBER"), mk("Tier", "CHOICE", "Gold", "Silver"), mk("Key account", "YES_NO")
	if _, err := svc.CreateField(ctx, fx.Principal, tagging.FieldInput{EntityType: "PARTY", Name: "birthday", Type: "TEXT"}); !errors.Is(err, tagging.ErrConflict) {
		t.Errorf("duplicate field name: err = %v, want ErrConflict", err)
	}
	if _, err := svc.CreateField(ctx, fx.Principal, tagging.FieldInput{EntityType: "PARTY", Name: "Size", Type: "CHOICE", Options: []string{"Only one"}}); !errors.Is(err, tagging.ErrInvalid) {
		t.Errorf("one-option choice: err = %v, want ErrInvalid", err)
	}

	if err := svc.SetFields(ctx, fx.Principal, "PARTY", fx.CustomerID, map[uuid.UUID]string{
		birthday.ID: "1990-04-02", manager.ID: " Asha ", credit.ID: "25000.50", tier.ID: "gold", vip.ID: "YES",
	}); err != nil {
		t.Fatalf("SetFields: %v", err)
	}
	got, err := svc.Get(ctx, fx.Principal, "PARTY", fx.CustomerID)
	if err != nil || len(got.Fields) != 5 {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	vals := map[string]string{}
	for _, f := range got.Fields {
		vals[f.Name] = f.Value
	}
	if vals["Birthday"] != "1990-04-02" || vals["Account manager"] != "Asha" || vals["Credit limit"] != "25000.5" || vals["Tier"] != "Gold" || vals["Key account"] != "yes" {
		t.Errorf("stored values = %v", vals)
	}

	for name, v := range map[string]map[uuid.UUID]string{
		"bad date":   {birthday.ID: "02/04/1990"},
		"bad number": {credit.ID: "lots"},
		"bad choice": {tier.ID: "Bronze"},
		"bad yes/no": {vip.ID: "maybe"},
	} {
		if err := svc.SetFields(ctx, fx.Principal, "PARTY", fx.CustomerID, v); !errors.Is(err, tagging.ErrInvalid) {
			t.Errorf("%s: err = %v, want ErrInvalid", name, err)
		}
	}
	// A field for contacts cannot be answered on a product.
	if err := svc.SetFields(ctx, fx.Principal, "PRODUCT", uuid.New(), map[uuid.UUID]string{manager.ID: "x"}); !errors.Is(err, tagging.ErrNotFound) {
		t.Errorf("wrong kind: err = %v, want ErrNotFound", err)
	}

	// An empty answer clears it; the others stay.
	if err := svc.SetFields(ctx, fx.Principal, "PARTY", fx.CustomerID, map[uuid.UUID]string{manager.ID: ""}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _ = svc.Get(ctx, fx.Principal, "PARTY", fx.CustomerID)
	for _, f := range got.Fields {
		if f.Name == "Account manager" && f.Value != "" || f.Name == "Birthday" && f.Value == "" {
			t.Errorf("after clearing: %s = %q", f.Name, f.Value)
		}
	}
	// Deleting a field drops its answers.
	if err := svc.DeleteField(ctx, fx.Principal, birthday.ID); err != nil {
		t.Fatalf("DeleteField: %v", err)
	}
	got, _ = svc.Get(ctx, fx.Principal, "PARTY", fx.CustomerID)
	if len(got.Fields) != 4 {
		t.Errorf("%d fields after delete, want 4", len(got.Fields))
	}
}
