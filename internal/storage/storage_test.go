package storage

import (
	"bytes"
	"image"
	"image/png"
	"mime/multipart"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 启动时会话数据全清：pdfs/jobs 的记录与文件、sessionScoped 印章、孤儿文件
// 都被清掉；唯独 legacy 印章（sessionScoped=false，等待浏览器迁移认领）保留。
func TestStartupWipesSessionData(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	pdfPath := filepath.Join(root, "pdfs", "pdf_test.pdf")
	legacyPath := filepath.Join(root, "stamps", "stamp_legacy.png")
	sessionPath := filepath.Join(root, "stamps", "stamp_session.png")
	orphanPath := filepath.Join(root, "stamps", "stamp_orphan.png")
	resultPath := filepath.Join(root, "jobs", "job_test.pdf")
	tempPath := filepath.Join(root, "pdfs", "pdf_test.img.png")
	for _, path := range []string{pdfPath, legacyPath, sessionPath, orphanPath, resultPath, tempPath} {
		if err := os.WriteFile(path, []byte("%PDF-1.4\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	now := time.Now().UTC()
	store.mu.Lock()
	store.pdfs["pdf_test"] = &PDFFile{
		ID: "pdf_test", Name: "test.pdf", Path: pdfPath, Size: 9,
		PageCount: 1, Pages: []PageInfo{{PageNumber: 1, WidthPt: 595, HeightPt: 842}},
		CreatedAt: now,
	}
	store.stamps["stamp_legacy"] = &StampAsset{
		ID: "stamp_legacy", Name: "legacy.png", Path: legacyPath,
		URL: "/api/stamps/stamp_legacy/image", Size: 9, WidthPx: 120, HeightPx: 80,
		SessionScoped: false, CreatedAt: now,
	}
	store.stamps["stamp_session"] = &StampAsset{
		ID: "stamp_session", Name: "session.png", Path: sessionPath,
		URL: "/api/stamps/stamp_session/image", Size: 9, WidthPx: 120, HeightPx: 80,
		SessionScoped: true, CreatedAt: now,
	}
	store.jobs["job_test"] = &Job{
		ID: "job_test", FileID: "pdf_test", Status: "done", Progress: 100,
		ResultPath: resultPath, DownloadURL: "/api/jobs/job_test/download",
		CreatedAt: now, UpdatedAt: now,
	}
	store.saveManifestLocked()
	store.mu.Unlock()

	reloaded, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if files := reloaded.PDFs(); len(files) != 0 {
		t.Fatalf("PDFs should be wiped, got %#v", files)
	}
	if jobs := reloaded.Jobs(); len(jobs) != 0 {
		t.Fatalf("jobs should be wiped, got %#v", jobs)
	}
	stamp, ok := reloaded.Stamp("stamp_legacy")
	if !ok || stamp.Path != legacyPath || stamp.SessionScoped {
		t.Fatalf("legacy stamp must survive the wipe: %#v, %v", stamp, ok)
	}
	if _, ok := reloaded.Stamp("stamp_session"); ok {
		t.Fatal("session stamp should be wiped")
	}
	for _, path := range []string{pdfPath, sessionPath, orphanPath, resultPath, tempPath} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("file should be removed: %s", path)
		}
	}
	if _, err := os.Stat(legacyPath); err != nil {
		t.Fatalf("legacy stamp file should survive: %v", err)
	}
}

func TestSaveStampClientIDIdempotent(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}

	id := "stamp_" + strings.Repeat("ab", 16)
	first, err := store.SaveStamp(pngHeader(t, "seal.png"), id)
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != id || !first.SessionScoped {
		t.Fatalf("unexpected first save: %#v", first)
	}
	second, err := store.SaveStamp(pngHeader(t, "seal.png"), id)
	if err != nil {
		t.Fatal(err)
	}
	if second.ID != id || second.CreatedAt != first.CreatedAt {
		t.Fatalf("second save should return the existing record: %#v", second)
	}
	entries, err := os.ReadDir(filepath.Join(root, "stamps"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected a single stamp file, got %d", len(entries))
	}

	if _, err := store.SaveStamp(pngHeader(t, "seal.png"), "stamp_NOTHEX"); err == nil {
		t.Fatal("invalid client id must be rejected")
	}
	auto, err := store.SaveStamp(pngHeader(t, "seal.png"), "")
	if err != nil {
		t.Fatal(err)
	}
	if !stampIDPattern.MatchString(auto.ID) {
		t.Fatalf("server generated id should match the pattern: %s", auto.ID)
	}
}

// 老印章被同 id 上传认领后翻为 sessionScoped，下次启动即被清。
func TestSaveStampClaimsLegacyStamp(t *testing.T) {
	root := t.TempDir()
	store, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	id := "stamp_" + strings.Repeat("cd", 12)
	legacyPath := filepath.Join(root, "stamps", id+".png")
	if err := os.WriteFile(legacyPath, []byte("png"), 0o600); err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	store.stamps[id] = &StampAsset{
		ID: id, Name: "legacy.png", Path: legacyPath,
		URL: "/api/stamps/" + id + "/image", Size: 3, WidthPx: 10, HeightPx: 10,
		SessionScoped: false, CreatedAt: time.Now().UTC(),
	}
	store.saveManifestLocked()
	store.mu.Unlock()

	claimed, err := store.SaveStamp(pngHeader(t, "legacy.png"), id)
	if err != nil {
		t.Fatal(err)
	}
	if !claimed.SessionScoped || claimed.Name != "legacy.png" {
		t.Fatalf("claim should flip sessionScoped on the existing record: %#v", claimed)
	}

	reloaded, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := reloaded.Stamp(id); ok {
		t.Fatal("claimed stamp should be wiped on next startup")
	}
}

func pngHeader(t *testing.T, name string) *multipart.FileHeader {
	t.Helper()
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(img.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	form, err := multipart.NewReader(&body, w.Boundary()).ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = form.RemoveAll() })
	return form.File["file"][0]
}
