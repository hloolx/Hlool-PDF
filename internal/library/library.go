// Package library is the per-user "library" storage layer: stamps (image bytes
// plus metadata) and a free-form settings blob. It exposes a single Store
// interface with two interchangeable backends — a server local filesystem and
// S3 (or any S3-compatible object store). Every key/path is derived server-side
// from the authenticated uid; callers never supply paths.
package library

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"time"
)

// ErrStampNotFound is returned when a stamp id does not exist for the user.
var ErrStampNotFound = errors.New("stamp not found")

// ErrVersionConflict is returned by PutLibrary when the supplied version does
// not match the stored one (optimistic concurrency).
var ErrVersionConflict = errors.New("library version conflict")

// StampMeta is the metadata describing a stored stamp image.
type StampMeta struct {
	ID        string    `json:"stampId"`
	Name      string    `json:"name"`
	Mime      string    `json:"mime"`
	Size      int64     `json:"size"`
	WidthPx   int       `json:"widthPx"`
	HeightPx  int       `json:"heightPx"`
	CreatedAt time.Time `json:"createdAt"`
}

// Library is the user's free-form settings document. Data is opaque to the
// backend — it is owned and interpreted by the frontend. Version implements
// optimistic concurrency: a writer must echo the version it last read.
type Library struct {
	Version int             `json:"version"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Store is the pluggable per-user library backend.
type Store interface {
	// ListStamps returns the user's stamp metadata (newest first).
	ListStamps(ctx context.Context, uid string) ([]StampMeta, error)
	// PutStamp writes (or overwrites) a stamp's bytes and metadata.
	PutStamp(ctx context.Context, uid string, meta StampMeta, data []byte) error
	// GetStamp returns a stamp's metadata and a reader over its bytes. The
	// caller must Close the reader. Returns ErrStampNotFound if absent.
	GetStamp(ctx context.Context, uid, id string) (StampMeta, io.ReadCloser, error)
	// StampMeta returns just the metadata. Returns ErrStampNotFound if absent.
	StampMeta(ctx context.Context, uid, id string) (StampMeta, error)
	// SetStampName renames a stamp and returns the updated metadata.
	SetStampName(ctx context.Context, uid, id, name string) (StampMeta, error)
	// DeleteStamp removes a stamp. Deleting a missing stamp is not an error.
	DeleteStamp(ctx context.Context, uid, id string) error
	// GetLibrary returns the settings document (a zero-value Library when none).
	GetLibrary(ctx context.Context, uid string) (Library, error)
	// PutLibrary stores the settings document. The next.Version must equal the
	// currently-stored version or ErrVersionConflict is returned; on success
	// the stored version is incremented and the new Library returned.
	PutLibrary(ctx context.Context, uid string, next Library) (Library, error)
	// PurgeUser removes everything stored for uid (every stamp and the settings
	// document). Used to burn a guest's library when its account expires.
	// Purging a user with nothing stored is not an error.
	PurgeUser(ctx context.Context, uid string) error
}

// segmentPattern restricts uid / stamp-id to characters that are always safe in
// both filesystem paths and S3 keys, eliminating traversal and separator tricks.
var segmentPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// safeSegment reports whether s is a safe single path/key segment.
func safeSegment(s string) bool { return segmentPattern.MatchString(s) }
