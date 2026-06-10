package storage

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestManifestReloadsPDFStampAndDoneJob(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	pdfPath := filepath.Join(root, "pdfs", "pdf_test.pdf")
	stampPath := filepath.Join(root, "stamps", "stamp_test.png")
	resultPath := filepath.Join(root, "jobs", "job_test.pdf")
	for _, path := range []string{pdfPath, stampPath, resultPath} {
		if err := os.WriteFile(path, []byte("%PDF-1.4\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now().UTC()
	store.mu.Lock()
	store.pdfs["pdf_test"] = &PDFFile{
		ID:        "pdf_test",
		Name:      "test.pdf",
		Path:      pdfPath,
		Size:      9,
		PageCount: 1,
		Pages:     []PageInfo{{PageNumber: 1, WidthPt: 595, HeightPt: 842}},
		CreatedAt: now,
	}
	store.stamps["stamp_test"] = &StampAsset{
		ID:        "stamp_test",
		Name:      "stamp.png",
		Path:      stampPath,
		URL:       "/api/stamps/stamp_test/image",
		Size:      9,
		WidthPx:   120,
		HeightPx:  80,
		CreatedAt: now,
	}
	store.jobs["job_test"] = &Job{
		ID:          "job_test",
		FileID:      "pdf_test",
		Status:      "done",
		Progress:    100,
		ResultPath:  resultPath,
		DownloadURL: "/api/jobs/job_test/download",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	store.saveManifestLocked()
	store.mu.Unlock()

	reloaded, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	pdf, ok := reloaded.PDF("pdf_test")
	if !ok || pdf.Path != pdfPath || pdf.PageCount != 1 {
		t.Fatalf("PDF not restored: %#v, %v", pdf, ok)
	}
	stamp, ok := reloaded.Stamp("stamp_test")
	if !ok || stamp.Path != stampPath || stamp.URL != "/api/stamps/stamp_test/image" {
		t.Fatalf("stamp not restored: %#v, %v", stamp, ok)
	}
	job, ok := reloaded.Job("job_test")
	if !ok || job.Status != "done" || job.ResultPath != resultPath || job.DownloadURL != "/api/jobs/job_test/download" {
		t.Fatalf("job not restored: %#v, %v", job, ok)
	}
}

func TestManifestMarksInterruptedJobFailed(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	store.mu.Lock()
	store.jobs["job_running"] = &Job{
		ID:        "job_running",
		FileID:    "pdf_test",
		Status:    "running",
		Progress:  35,
		CreatedAt: now,
		UpdatedAt: now,
	}
	store.saveManifestLocked()
	store.mu.Unlock()

	reloaded, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	job, ok := reloaded.Job("job_running")
	if !ok {
		t.Fatal("job was not restored")
	}
	if job.Status != "failed" || job.Progress != 100 || job.Error == "" {
		t.Fatalf("interrupted job was not failed: %#v", job)
	}
}
