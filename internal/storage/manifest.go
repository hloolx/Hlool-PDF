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

type manifest struct {
	Version int             `json:"version"`
	PDFs    []manifestPDF   `json:"pdfs"`
	Stamps  []manifestStamp `json:"stamps"`
	Jobs    []manifestJob   `json:"jobs"`
}

type manifestPDF struct {
	ID        string     `json:"fileId"`
	Name      string     `json:"name"`
	Path      string     `json:"path"`
	Size      int64      `json:"size"`
	PageCount int        `json:"pageCount"`
	Pages     []PageInfo `json:"pages"`
	CreatedAt time.Time  `json:"createdAt"`
}

type manifestStamp struct {
	ID        string    `json:"stampId"`
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	Size      int64     `json:"size"`
	WidthPx   int       `json:"widthPx"`
	HeightPx  int       `json:"heightPx"`
	CreatedAt time.Time `json:"createdAt"`
}

type manifestJob struct {
	ID         string    `json:"jobId"`
	FileID     string    `json:"fileId"`
	Status     string    `json:"status"`
	Progress   int       `json:"progress"`
	Error      string    `json:"error,omitempty"`
	OutputName string    `json:"outputName,omitempty"`
	ResultPath string    `json:"resultPath,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
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

	for _, f := range m.PDFs {
		p, ok := s.manifestFilePath(f.Path)
		if f.ID == "" || !ok || !fileExists(p) {
			continue
		}
		s.pdfs[f.ID] = &PDFFile{
			ID:        f.ID,
			Name:      f.Name,
			Path:      p,
			Size:      f.Size,
			PageCount: f.PageCount,
			Pages:     append([]PageInfo(nil), f.Pages...),
			CreatedAt: f.CreatedAt,
		}
	}
	for _, stamp := range m.Stamps {
		p, ok := s.manifestFilePath(stamp.Path)
		if stamp.ID == "" || !ok || !fileExists(p) {
			continue
		}
		s.stamps[stamp.ID] = &StampAsset{
			ID:        stamp.ID,
			Name:      stamp.Name,
			Path:      p,
			URL:       "/api/stamps/" + stamp.ID + "/image",
			Size:      stamp.Size,
			WidthPx:   stamp.WidthPx,
			HeightPx:  stamp.HeightPx,
			CreatedAt: stamp.CreatedAt,
		}
	}
	for _, item := range m.Jobs {
		if item.ID == "" {
			continue
		}
		job := &Job{
			ID:         item.ID,
			FileID:     item.FileID,
			Status:     item.Status,
			Progress:   item.Progress,
			Error:      item.Error,
			OutputName: item.OutputName,
			CreatedAt:  item.CreatedAt,
			UpdatedAt:  item.UpdatedAt,
		}
		if item.ResultPath != "" {
			if p, ok := s.manifestFilePath(item.ResultPath); ok {
				job.ResultPath = p
			}
		}
		if job.Status == "queued" || job.Status == "running" {
			job.Status = "failed"
			job.Progress = 100
			job.Error = "server restarted before this job finished"
			job.ResultPath = ""
			job.DownloadURL = ""
		}
		if job.Status == "done" && (job.ResultPath == "" || !fileExists(job.ResultPath)) {
			job.Status = "failed"
			job.Progress = 100
			job.Error = "job result file is missing"
			job.ResultPath = ""
			job.DownloadURL = ""
		}
		if job.Status == "done" {
			job.Progress = 100
			job.DownloadURL = "/api/jobs/" + job.ID + "/download"
		}
		s.jobs[job.ID] = job
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
	for _, id := range sortedKeys(s.pdfs) {
		f := s.pdfs[id]
		m.PDFs = append(m.PDFs, manifestPDF{
			ID:        f.ID,
			Name:      f.Name,
			Path:      s.manifestPathValue(f.Path),
			Size:      f.Size,
			PageCount: f.PageCount,
			Pages:     append([]PageInfo(nil), f.Pages...),
			CreatedAt: f.CreatedAt,
		})
	}
	for _, id := range sortedKeys(s.stamps) {
		stamp := s.stamps[id]
		m.Stamps = append(m.Stamps, manifestStamp{
			ID:        stamp.ID,
			Name:      stamp.Name,
			Path:      s.manifestPathValue(stamp.Path),
			Size:      stamp.Size,
			WidthPx:   stamp.WidthPx,
			HeightPx:  stamp.HeightPx,
			CreatedAt: stamp.CreatedAt,
		})
	}
	for _, id := range sortedKeys(s.jobs) {
		job := s.jobs[id]
		m.Jobs = append(m.Jobs, manifestJob{
			ID:         job.ID,
			FileID:     job.FileID,
			Status:     job.Status,
			Progress:   job.Progress,
			Error:      job.Error,
			OutputName: job.OutputName,
			ResultPath: s.manifestPathValue(job.ResultPath),
			CreatedAt:  job.CreatedAt,
			UpdatedAt:  job.UpdatedAt,
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
