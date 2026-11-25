package bankrec

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	httpx "rechvix/internal/platform/http"
	"rechvix/internal/platform/permissions"
)

type Handlers struct{ svc *Service }

func NewHandlers(svc *Service) *Handlers { return &Handlers{svc: svc} }

func (h *Handlers) Mount(r chi.Router) {
	r.Get("/accounting/bank-accounts/{id}/statement-lines", h.list)
	r.Post("/accounting/bank-accounts/{id}/statement-lines", h.importLines)
	r.Post("/accounting/bank-statement-lines/{id}/match", h.match)
	r.Post("/accounting/bank-statement-lines/{id}/unmatch", h.unmatch)
	r.Post("/accounting/bank-statement-lines/{id}/ignore", h.ignore)
	r.Post("/accounting/bank-statement-lines/{id}/unignore", h.unignore)
}

func principal(r *http.Request) permissions.Principal {
	p, _ := httpx.PrincipalFromContext(r.Context())
	return p
}

// say drops the package's internal prefix so the user reads "line 1 has no valid date", not "bankrec: invalid request: line 1 ...".
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

func idParam(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	id, err := uuid.Parse(chi.URLParam(r, "id"))
	if err != nil {
		httpx.WriteError(w, r, httpx.NewBadRequest("INVALID_ID", "The id in the address is not valid."))
		return uuid.Nil, false
	}
	return id, true
}

func decode(w http.ResponseWriter, r *http.Request, limit int64, v any) bool {
	dec := json.NewDecoder(io.LimitReader(r.Body, limit))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		httpx.WriteError(w, r, httpx.NewBadRequest("INVALID_BODY", "Request body is malformed."))
		return false
	}
	return true
}

func (h *Handlers) list(w http.ResponseWriter, r *http.Request) {
	id, ok := idParam(w, r)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	out, err := h.svc.List(r.Context(), principal(r), id, r.URL.Query().Get("status"), limit)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handlers) importLines(w http.ResponseWriter, r *http.Request) {
	id, ok := idParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Lines []LineInput `json:"lines"`
	}
	if !decode(w, r, 4<<20, &body) {
		return
	}
	out, err := h.svc.ImportLines(r.Context(), principal(r), id, body.Lines)
	if err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (h *Handlers) match(w http.ResponseWriter, r *http.Request) {
	id, ok := idParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Kind string    `json:"kind"`
		ID   uuid.UUID `json:"id"`
	}
	if !decode(w, r, 4096, &body) {
		return
	}
	if err := h.svc.Match(r.Context(), principal(r), id, body.Kind, body.ID); err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": StatusMatched})
}

func (h *Handlers) unmatch(w http.ResponseWriter, r *http.Request) {
	id, ok := idParam(w, r)
	if !ok {
		return
	}
	if err := h.svc.Unmatch(r.Context(), principal(r), id); err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": StatusUnmatched})
}

func (h *Handlers) unignore(w http.ResponseWriter, r *http.Request) {
	id, ok := idParam(w, r)
	if !ok {
		return
	}
	if err := h.svc.Unignore(r.Context(), principal(r), id); err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": StatusUnmatched})
}

func (h *Handlers) ignore(w http.ResponseWriter, r *http.Request) {
	id, ok := idParam(w, r)
	if !ok {
		return
	}
	var body struct {
		Note string `json:"note"`
	}
	if !decode(w, r, 4096, &body) {
		return
	}
	if err := h.svc.Ignore(r.Context(), principal(r), id, body.Note); err != nil {
		fail(w, r, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": StatusIgnored})
}
