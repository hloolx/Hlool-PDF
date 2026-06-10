package storage

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const manifestVersion = 1

// manifest 只承载印章索引：pdfs/jobs 是会话数据，启动即清不再持久化
// （旧版本 manifest 里的 pdfs/jobs 键在反序列化时被忽略）。
type manifest struct {
	Version int             `json:"version"`
	Stamps  []manifestStamp `json:"stamps"`
}

type manifestStamp struct {
	ID            string    `json:"stampId"`
	Name          string    `json:"name"`
	Path          string    `json:"path"`
	Size          int64     `json:"size"`
	WidthPx       int       `json:"widthPx"`
	HeightPx      int       `json:"heightPx"`
	SessionScoped bool      `json:"sessionScoped,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
}

func (s *Store) loadManifest() error {
	data, err := os.ReadFile(s.manifestPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var m manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}
	if m.Version > manifestVersion {
		return errors.New("storage manifest was written by a newer hlool pdf version")
	}

	for _, stamp := range m.Stamps {
		p, ok := s.manifestFilePath(stamp.Path)
		if stamp.ID == "" || !ok || !fileExists(p) {
			continue
		}
		s.stamps[stamp.ID] = &StampAsset{
			ID:            stamp.ID,
			Name:          stamp.Name,
			Path:          p,
			URL:           "/api/stamps/" + stamp.ID + "/image",
			Size:          stamp.Size,
			WidthPx:       stamp.WidthPx,
			HeightPx:      stamp.HeightPx,
			SessionScoped: stamp.SessionScoped,
			CreatedAt:     stamp.CreatedAt,
		}
	}
	return nil
}

func (s *Store) saveManifestLocked() {
	if err := s.writeManifestLocked(); err != nil {
		log.Printf("save storage manifest: %v", err)
	}
}

func (s *Store) writeManifestLocked() error {
	m := manifest{Version: manifestVersion}
	for _, id := range sortedKeys(s.stamps) {
		stamp := s.stamps[id]
		m.Stamps = append(m.Stamps, manifestStamp{
			ID:            stamp.ID,
			Name:          stamp.Name,
			Path:          s.manifestPathValue(stamp.Path),
			Size:          stamp.Size,
			WidthPx:       stamp.WidthPx,
			HeightPx:      stamp.HeightPx,
			SessionScoped: stamp.SessionScoped,
			CreatedAt:     stamp.CreatedAt,
		})
	}

	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmpPath := s.manifestPath() + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmpPath, s.manifestPath())
}

func (s *Store) manifestPath() string {
	return filepath.Join(s.root, "manifest.json")
}

func (s *Store) manifestPathValue(p string) string {
	if p == "" {
		return ""
	}
	rel, err := filepath.Rel(s.root, p)
	if err != nil || !safeRelativePath(rel) {
		return ""
	}
	return filepath.ToSlash(rel)
}

func (s *Store) manifestFilePath(rel string) (string, bool) {
	if !safeRelativePath(rel) {
		return "", false
	}
	return filepath.Join(s.root, filepath.FromSlash(rel)), true
}

func safeRelativePath(p string) bool {
	if p == "" || filepath.IsAbs(p) {
		return false
	}
	clean := filepath.Clean(filepath.FromSlash(p))
	return clean != "." && clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}

func sortedKeys[T any](m map[string]*T) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
