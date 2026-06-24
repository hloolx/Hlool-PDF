package library

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

// Compile-time proof both backends satisfy the Store interface.
var (
	_ Store = (*LocalStore)(nil)
	_ Store = (*S3Store)(nil)
)

func TestLocalStoreStampRoundTrip(t *testing.T) {
	ctx := context.Background()
	store, err := NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	uid := "user01"
	meta := StampMeta{
		ID: "stamp_abc", Name: "seal.png", Mime: "image/png",
		Size: 4, WidthPx: 10, HeightPx: 10, CreatedAt: time.Now().UTC(),
	}
	if err := store.PutStamp(ctx, uid, meta, []byte("\x89PNG")); err != nil {
		t.Fatal(err)
	}

	list, err := store.ListStamps(ctx, uid)
	if err != nil || len(list) != 1 || list[0].ID != "stamp_abc" {
		t.Fatalf("list = %#v, err=%v", list, err)
	}

	gotMeta, rc, err := store.GetStamp(ctx, uid, "stamp_abc")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(data, []byte("\x89PNG")) || gotMeta.Name != "seal.png" {
		t.Fatalf("unexpected content/meta: %q / %#v", data, gotMeta)
	}

	renamed, err := store.SetStampName(ctx, uid, "stamp_abc", "公章")
	if err != nil || renamed.Name != "公章" {
		t.Fatalf("rename failed: %#v, %v", renamed, err)
	}
	again, _ := store.StampMeta(ctx, uid, "stamp_abc")
	if again.Name != "公章" {
		t.Fatalf("rename not persisted: %#v", again)
	}

	if err := store.DeleteStamp(ctx, uid, "stamp_abc"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.GetStamp(ctx, uid, "stamp_abc"); err != ErrStampNotFound {
		t.Fatalf("expected ErrStampNotFound, got %v", err)
	}
}

func TestLocalStoreIsolatesUsers(t *testing.T) {
	ctx := context.Background()
	store, _ := NewLocalStore(t.TempDir())
	meta := StampMeta{ID: "stamp_x", Name: "x", Mime: "image/png", CreatedAt: time.Now()}
	if err := store.PutStamp(ctx, "alice", meta, []byte("a")); err != nil {
		t.Fatal(err)
	}
	bobList, err := store.ListStamps(ctx, "bob")
	if err != nil || len(bobList) != 0 {
		t.Fatalf("bob must not see alice's stamps: %#v, %v", bobList, err)
	}
}

func TestLocalStoreLibraryVersioning(t *testing.T) {
	ctx := context.Background()
	store, _ := NewLocalStore(t.TempDir())
	uid := "user01"

	empty, err := store.GetLibrary(ctx, uid)
	if err != nil || empty.Version != 0 {
		t.Fatalf("fresh library should be version 0: %#v, %v", empty, err)
	}

	stored, err := store.PutLibrary(ctx, uid, Library{Version: 0, Data: json.RawMessage(`{"theme":"dark"}`)})
	if err != nil || stored.Version != 1 {
		t.Fatalf("first put should bump to version 1: %#v, %v", stored, err)
	}

	// Stale version is rejected.
	if _, err := store.PutLibrary(ctx, uid, Library{Version: 0, Data: json.RawMessage(`{}`)}); err != ErrVersionConflict {
		t.Fatalf("expected version conflict, got %v", err)
	}

	// Correct version succeeds.
	next, err := store.PutLibrary(ctx, uid, Library{Version: 1, Data: json.RawMessage(`{"theme":"light"}`)})
	if err != nil || next.Version != 2 {
		t.Fatalf("expected version 2: %#v, %v", next, err)
	}
}

func TestLocalStoreRejectsUnsafeSegments(t *testing.T) {
	ctx := context.Background()
	store, _ := NewLocalStore(t.TempDir())
	if _, err := store.ListStamps(ctx, "../etc"); err != errInvalidID {
		t.Fatalf("traversal uid must be rejected, got %v", err)
	}
	if _, _, err := store.GetStamp(ctx, "user01", "../secret"); err != errInvalidID {
		t.Fatalf("traversal stamp id must be rejected, got %v", err)
	}
	meta := StampMeta{ID: "bad/id", Name: "x", CreatedAt: time.Now()}
	if err := store.PutStamp(ctx, "user01", meta, []byte("a")); err != errInvalidID {
		t.Fatalf("slash in id must be rejected, got %v", err)
	}
}

func TestLocalStorePurgeUser(t *testing.T) {
	ctx := context.Background()
	store, _ := NewLocalStore(t.TempDir())
	uid := "guest01"
	meta := StampMeta{ID: "stamp_p", Name: "x", Mime: "image/png", CreatedAt: time.Now().UTC()}
	if err := store.PutStamp(ctx, uid, meta, []byte("a")); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PutLibrary(ctx, uid, Library{Version: 0, Data: json.RawMessage(`{"k":1}`)}); err != nil {
		t.Fatal(err)
	}

	if err := store.PurgeUser(ctx, uid); err != nil {
		t.Fatalf("purge: %v", err)
	}
	list, err := store.ListStamps(ctx, uid)
	if err != nil || len(list) != 0 {
		t.Fatalf("stamps should be gone after purge: %#v, %v", list, err)
	}
	lib, err := store.GetLibrary(ctx, uid)
	if err != nil || lib.Version != 0 {
		t.Fatalf("library should reset after purge: %#v, %v", lib, err)
	}

	// Purging a user with nothing stored is not an error, and unsafe ids are
	// still rejected.
	if err := store.PurgeUser(ctx, "nobody"); err != nil {
		t.Fatalf("purge of empty user should be a no-op, got %v", err)
	}
	if err := store.PurgeUser(ctx, "../etc"); err != errInvalidID {
		t.Fatalf("traversal uid must be rejected, got %v", err)
	}
}
