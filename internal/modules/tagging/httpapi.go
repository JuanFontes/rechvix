package tagging

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
	r.Get("/settings/labels", h.listLabels)
	r.Post("/settings/labels", h.createLabel)
	r.Delete("/settings/labels/{id}", h.deleteLabel)
	r.Get("/settings/custom-fields", h.listFields)
	r.Post("/settings/custom-fields", h.createField)
	r.Delete("/settings/custom-fields/{id}", h.deleteField)
	r.Get("/tags/{kind}/{id}", h.get)
	r.Put("/tags/{kind}/{id}/labels", h.setLabels)
	r.Put("/tags/{kind}/{id}/fields", h.setFields)
	r.Get("/labels/{id}/items", h.withLabel)
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

func id(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	v, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, httpx.NewBadRequest("INVALID_ID", "The id in the address is not valid."))
		return uuid.Nil, false
	}
	return v, true
}

func (h *Handlers) listLabels(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ListLabels(r.Context(), principal(r))
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handlers) createLabel(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name   string `json:"name"`
		Colour string `json:"colour"`
	}
	if !decode(w, r, &in) {
		return
	}
	l, err := h.svc.CreateLabel(r.Context(), principal(r), in.Name, in.Colour)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, l)
}

func (h *Handlers) deleteLabel(w http.ResponseWriter, r *http.Request) {
	v, ok := id(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteLabel(r.Context(), principal(r), v); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) listFields(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ListFields(r.Context(), principal(r), r.URL.Query().Get("kind"))
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handlers) createField(w http.ResponseWriter, r *http.Request) {
	var in FieldInput
	if !decode(w, r, &in) {
		return
	}
	f, err := h.svc.CreateField(r.Context(), principal(r), in)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusCreated, f)
}

func (h *Handlers) deleteField(w http.ResponseWriter, r *http.Request) {
	v, ok := id(w, r)
	if !ok {
		return
	}
	if err := h.svc.DeleteField(r.Context(), principal(r), v); err != nil {
		fail(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handlers) get(w http.ResponseWriter, r *http.Request) {
	v, ok := id(w, r)
	if !ok {
		return
	}
	out, err := h.svc.Get(r.Context(), principal(r), chi.URLParam(r, "kind"), v)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handlers) setLabels(w http.ResponseWriter, r *http.Request) {
	v, ok := id(w, r)
	if !ok {
		return
	}
	var in struct {
		LabelIDs []uuid.UUID `json:"label_ids"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := h.svc.SetLabels(r.Context(), principal(r), chi.URLParam(r, "kind"), v, in.LabelIDs); err != nil {
		fail(w, r, err)
		return
	}
	h.get(w, r)
}

func (h *Handlers) setFields(w http.ResponseWriter, r *http.Request) {
	v, ok := id(w, r)
	if !ok {
		return
	}
	var in struct {
		Values map[uuid.UUID]string `json:"values"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := h.svc.SetFields(r.Context(), principal(r), chi.URLParam(r, "kind"), v, in.Values); err != nil {
		fail(w, r, err)
		return
	}
	h.get(w, r)
}

func (h *Handlers) withLabel(w http.ResponseWriter, r *http.Request) {
	v, ok := id(w, r)
	if !ok {
		return
	}
	out, err := h.svc.WithLabel(r.Context(), principal(r), r.URL.Query().Get("kind"), v)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}
