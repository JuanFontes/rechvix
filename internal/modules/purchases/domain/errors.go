package domain

import "errors"

var (
	ErrNotFound             = errors.New("purchases: not found")
	ErrInvalidDocumentType  = errors.New("purchases: invalid document type")
	ErrDocumentNotDraft     = errors.New("purchases: document is not in DRAFT status")
	ErrDocumentNotFinalized = errors.New("purchases: document is not in FINALIZED status")
	ErrEmptyDocument        = errors.New("purchases: document has no lines")
	ErrDuplicateNumber      = errors.New("purchases: document number already in use for this document type")
	// ErrDuplicateClientRef: a document with this client_ref already exists (the caller should read it back, not create another).
	ErrDuplicateClientRef = errors.New("purchases: a document with this client_ref already exists")
	// ErrClientRefReused: the client_ref belongs to a document that differs from this request (a caller mixing up its own ids).
	ErrClientRefReused = errors.New("purchases: client_ref was already used for a different document")

	// ErrForeignCurrencyUnsupported means a purchase document was created in a currency other than the company's.
	ErrForeignCurrencyUnsupported = errors.New("purchases: foreign-currency purchases are not supported")
)
