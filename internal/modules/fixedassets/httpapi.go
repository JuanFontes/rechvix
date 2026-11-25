package fixedassets

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	httpx "rechvix/internal/platform/http"
	"rechvix/internal/platform/permissions"
)

type Handlers struct{ svc *Service }

func NewHandlers(svc *Service) *Handlers { return &Handlers{svc: svc} }

func (h *Handlers) Mount(r chi.Router) {
	r.Get("/accounting/fixed-assets", h.list)
	r.Post("/accounting/fixed-assets", h.create)
	r.Post("/accounting/fixed-assets/depreciation", h.run)
	r.Get("/accounting/fixed-assets/{id}/schedule", h.schedule)
	r.Post("/accounting/fixed-assets/{id}/dispose", h.dispose)
}

func principal(r *http.Request) permissions.Principal {
	p, _ := httpx.PrincipalFromContext(r.Context())
	return p
}

func say(err error) string {
	m := err.Error()
	for _, p := range []string{ErrInvalid.Error() + ": ", ErrNotFound.Error() + ": ", ErrConflict.Error() + ": "} {
		m = strings.TrimPrefix(m, p)
	}
	return m
}

func fail(w http.ResponseWriter, r *http.Request, err error) {
	var forbidden *permissions.ErrForbidden
	switch {
	case errors.As(err, &forbidden):
		httpx.WriteError(w, r, httpx.NewForbidden("FORBIDDEN", "You do not have permission to perform this action."))
	case errors.Is(err, ErrInvalid):
		httpx.WriteError(w, r, httpx.NewBadRequest("INVALID_REQUEST", say(err)))
	case errors.Is(err, ErrNotFound):
		httpx.WriteError(w, r, httpx.NewNotFound("NOT_FOUND", say(err)+" was not found."))
	case errors.Is(err, ErrConflict):
		httpx.WriteError(w, r, httpx.NewConflict("CONFLICT", say(err)))
	default:
		httpx.WriteError(w, r, err)
	}
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpx.WriteError(w, r, httpx.NewBadRequest("INVALID_BODY", "Request body is malformed."))
		return false
	}
	return true
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	reg, err := h.svc.List(r.Context(), principal(r))
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, reg)
}

func (h *Handlers) create(w http.ResponseWriter, r *http.Request) {
	var in CreateInput
	if !decode(w, r, &in) {
		return
	}
	a, err := h.svc.Create(r.Context(), principal(r), in)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, a)
}

func (h *Handlers) run(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Through string `json:"through"`
	}
	if !decode(w, r, &in) {
		return
	}
	res, err := h.svc.RunDepreciation(r.Context(), principal(r), in.Through)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

func (h *Handlers) schedule(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, httpx.NewBadRequest("INVALID_ID", "The id in the address is not valid."))
		return
	}
	out, err := h.svc.Schedule(r.Context(), principal(r), id)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handlers) dispose(w http.ResponseWriter, r *http.Request) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, httpx.NewBadRequest("INVALID_ID", "The id in the address is not valid."))
		return
	}
	var in DisposeInput
	if !decode(w, r, &in) {
		return
	}
	a, err := h.svc.Dispose(r.Context(), principal(r), id, in)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, a)
}
