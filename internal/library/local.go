package library

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

// LocalStore keeps the user library on the server's local filesystem, laid out
// as {root}/users/{uid}/stamps/{id} (+ {id}.json sidecar) and
// {root}/users/{uid}/library.json.
type LocalStore struct {
	root  string
	locks keyedMutex
}

// NewLocalStore creates a LocalStore rooted at dataDir/users.
func NewLocalStore(dataDir string) (*LocalStore, error) {
	root := filepath.Join(dataDir, "users")
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	return &LocalStore{root: root}, nil
}

func (s *LocalStore) userDir(uid string) string   { return filepath.Join(s.root, uid) }
func (s *LocalStore) stampsDir(uid string) string { return filepath.Join(s.userDir(uid), "stamps") }
func (s *LocalStore) stampPath(uid, id string) string {
	return filepath.Join(s.stampsDir(uid), id)
}
func (s *LocalStore) stampMetaPath(uid, id string) string {
	return filepath.Join(s.stampsDir(uid), id+".json")
}
func (s *LocalStore) libraryPath(uid string) string {
	return filepath.Join(s.userDir(uid), "library.json")
}

func (s *LocalStore) ListStamps(_ context.Context, uid string) ([]StampMeta, error) {
	if !safeSegment(uid) {
		return nil, errInvalidID
	}
	entries, err := os.ReadDir(s.stampsDir(uid))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	out := make([]StampMeta, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.stampsDir(uid), entry.Name()))
		if err != nil {
			continue
		}
		var meta StampMeta
		if json.Unmarshal(data, &meta) == nil && meta.ID != "" {
			out = append(out, meta)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *LocalStore) PutStamp(_ context.Context, uid string, meta StampMeta, data []byte) error {
	if !safeSegment(uid) || !safeSegment(meta.ID) {
		return errInvalidID
	}
	if err := os.MkdirAll(s.stampsDir(uid), 0o700); err != nil {
		return err
	}
	if err := writeFileAtomic(s.stampPath(uid, meta.ID), data, 0o600); err != nil {
		return err
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return writeFileAtomic(s.stampMetaPath(uid, meta.ID), metaBytes, 0o600)
}

func (s *LocalStore) GetStamp(_ context.Context, uid, id string) (StampMeta, io.ReadCloser, error) {
	if !safeSegment(uid) || !safeSegment(id) {
		return StampMeta{}, nil, errInvalidID
	}
	meta, err := s.readMeta(uid, id)
	if err != nil {
		return StampMeta{}, nil, err
	}
	f, err := os.Open(s.stampPath(uid, id))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return StampMeta{}, nil, ErrStampNotFound
		}
		return StampMeta{}, nil, err
	}
	return meta, f, nil
}

func (s *LocalStore) StampMeta(_ context.Context, uid, id string) (StampMeta, error) {
	if !safeSegment(uid) || !safeSegment(id) {
		return StampMeta{}, errInvalidID
	}
	return s.readMeta(uid, id)
}

func (s *LocalStore) readMeta(uid, id string) (StampMeta, error) {
	data, err := os.ReadFile(s.stampMetaPath(uid, id))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return StampMeta{}, ErrStampNotFound
		}
		return StampMeta{}, err
	}
	var meta StampMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return StampMeta{}, err
	}
	return meta, nil
}

func (s *LocalStore) SetStampName(_ context.Context, uid, id, name string) (StampMeta, error) {
	if !safeSegment(uid) || !safeSegment(id) {
		return StampMeta{}, errInvalidID
	}
	unlock := s.locks.lock(uid)
	defer unlock()
	meta, err := s.readMeta(uid, id)
	if err != nil {
		return StampMeta{}, err
	}
	meta.Name = name
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		return StampMeta{}, err
	}
	if err := writeFileAtomic(s.stampMetaPath(uid, id), metaBytes, 0o600); err != nil {
		return StampMeta{}, err
	}
	return meta, nil
}

func (s *LocalStore) DeleteStamp(_ context.Context, uid, id string) error {
	if !safeSegment(uid) || !safeSegment(id) {
		return errInvalidID
	}
	_ = os.Remove(s.stampPath(uid, id))
	_ = os.Remove(s.stampMetaPath(uid, id))
	return nil
}

func (s *LocalStore) GetLibrary(_ context.Context, uid string) (Library, error) {
	if !safeSegment(uid) {
		return Library{}, errInvalidID
	}
	data, err := os.ReadFile(s.libraryPath(uid))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Library{}, nil
		}
		return Library{}, err
	}
	var lib Library
	if err := json.Unmarshal(data, &lib); err != nil {
		return Library{}, err
	}
	return lib, nil
}

func (s *LocalStore) PutLibrary(_ context.Context, uid string, next Library) (Library, error) {
	if !safeSegment(uid) {
		return Library{}, errInvalidID
	}
	unlock := s.locks.lock(uid)
	defer unlock()
	current, err := s.GetLibrary(context.Background(), uid)
	if err != nil {
		return Library{}, err
	}
	if next.Version != current.Version {
		return Library{}, ErrVersionConflict
	}
	stored := Library{Version: current.Version + 1, Data: next.Data}
	data, err := json.Marshal(stored)
	if err != nil {
		return Library{}, err
	}
	if err := os.MkdirAll(s.userDir(uid), 0o700); err != nil {
		return Library{}, err
	}
	if err := writeFileAtomic(s.libraryPath(uid), data, 0o600); err != nil {
		return Library{}, err
	}
	return stored, nil
}

var errInvalidID = fmt.Errorf("invalid user or stamp id")

// PurgeUser deletes the user's entire directory tree (stamps + settings).
func (s *LocalStore) PurgeUser(_ context.Context, uid string) error {
	if !safeSegment(uid) {
		return errInvalidID
	}
	unlock := s.locks.lock(uid)
	defer unlock()
	if err := os.RemoveAll(s.userDir(uid)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// writeFileAtomic writes via a temp file in the same directory then renames it
// over the destination (removing any stale target first for Windows).
func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	_ = os.Remove(path)
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// keyedMutex provides per-key mutual exclusion without cross-key contention.
type keyedMutex struct {
	mu sync.Mutex
	m  map[string]*sync.Mutex
}

func (k *keyedMutex) lock(key string) func() {
	k.mu.Lock()
	if k.m == nil {
		k.m = map[string]*sync.Mutex{}
	}
	mu, ok := k.m[key]
	if !ok {
		mu = &sync.Mutex{}
		k.m[key] = mu
	}
	k.mu.Unlock()
	mu.Lock()
	return mu.Unlock
}
