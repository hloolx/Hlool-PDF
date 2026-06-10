package server

import (
	"bytes"
	"encoding/json"
	"image"
	"image/png"
	"math"
	"mime/multipart"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	pdfcore "hlool-pdf/internal/pdf"
	"hlool-pdf/internal/storage"
)

func TestBuildComposeRuns(t *testing.T) {
	store, err := storage.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	makePDF := func(pages int) string {
		id, path := store.NewPDFPath()
		if err := os.WriteFile(path, []byte("%PDF-fake"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := store.RegisterPDF(id, filepath.Base(path), path); err != nil {
			t.Fatal(err)
		}
		infos := make([]storage.PageInfo, pages)
		for i := range infos {
			infos[i] = storage.PageInfo{PageNumber: i + 1, WidthPt: 595, HeightPt: 842}
		}
		store.SetPDFPages(id, infos)
		return id
	}
	a := makePDF(3)
	b := makePDF(2)
	s := New(store, nil, Options{})

	runs, err := s.buildComposeRuns([]composePageRef{
		{FileID: a, PageNumber: 1},
		{FileID: a, PageNumber: 2},
		{FileID: b, PageNumber: 1},
		{FileID: a, PageNumber: 3},
		{FileID: a, PageNumber: 3},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 3 {
		t.Fatalf("expected 3 runs, got %d: %+v", len(runs), runs)
	}
	if len(runs[0].Pages) != 2 || runs[0].Pages[0] != 1 || runs[0].Pages[1] != 2 {
		t.Fatalf("run 0 wrong: %+v", runs[0])
	}
	if len(runs[2].Pages) != 2 || runs[2].Pages[0] != 3 {
		t.Fatalf("run 2 should keep duplicated pages: %+v", runs[2])
	}

	if _, err := s.buildComposeRuns([]composePageRef{{FileID: a, PageNumber: 9}}); err == nil {
		t.Fatal("expected out-of-range error")
	}
	if _, err := s.buildComposeRuns([]composePageRef{{FileID: "missing", PageNumber: 1}}); err == nil {
		t.Fatal("expected missing file error")
	}
}

// approxPt 比较页面尺寸（pt），容忍写出/解析的浮点误差。
func approxPt(got, want float64) bool {
	return math.Abs(got-want) < 0.5
}

// TestImageUploadAndRewrite 覆盖“图片作为页面导入”与“原地并入 / 撤销”全链路：
// 上传 PNG → 固定 A4 单页 PDF（横图横向、竖图竖向）；rewrite 把另一文件的页并入当前
// （fileId 不变）；再裁回原页数即撤销。
func TestImageUploadAndRewrite(t *testing.T) {
	store, err := storage.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	s := New(store, nil, Options{})

	uploadPNG := func(name string, w, h int) storage.PDFFile {
		t.Helper()
		img := image.NewRGBA(image.Rect(0, 0, w, h))
		var pngBuf bytes.Buffer
		if err := png.Encode(&pngBuf, img); err != nil {
			t.Fatal(err)
		}
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		fw, err := mw.CreateFormFile("file", name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(pngBuf.Bytes()); err != nil {
			t.Fatal(err)
		}
		_ = mw.Close()
		req := httptest.NewRequest("POST", "/api/files", &body)
		req.Header.Set("Content-Type", mw.FormDataContentType())
		rec := httptest.NewRecorder()
		s.files(rec, req)
		if rec.Code != 201 {
			t.Fatalf("upload %s: status %d: %s", name, rec.Code, rec.Body.String())
		}
		var file storage.PDFFile
		if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil {
			t.Fatal(err)
		}
		return file
	}

	rewrite := func(id string, pages []composePageRef, wantStatus int) storage.PDFFile {
		t.Helper()
		payload, _ := json.Marshal(rewriteRequest{Pages: pages})
		req := httptest.NewRequest("POST", "/api/files/"+id+"/rewrite", bytes.NewReader(payload))
		rec := httptest.NewRecorder()
		s.fileByID(rec, req)
		if rec.Code != wantStatus {
			t.Fatalf("rewrite: status %d, want %d: %s", rec.Code, wantStatus, rec.Body.String())
		}
		var file storage.PDFFile
		if wantStatus == 200 {
			if err := json.Unmarshal(rec.Body.Bytes(), &file); err != nil {
				t.Fatal(err)
			}
		}
		return file
	}

	a := uploadPNG("扫描件.png", 100, 50)
	if a.PageCount != 1 || a.Name != "扫描件.pdf" {
		t.Fatalf("unexpected image file: %+v", a)
	}
	if len(a.Pages) != 1 || !approxPt(a.Pages[0].WidthPt, pdfcore.A4HeightPt) || !approxPt(a.Pages[0].HeightPt, pdfcore.A4WidthPt) {
		t.Fatalf("landscape image should become a landscape A4 page: %+v", a.Pages)
	}
	b := uploadPNG("第二张.png", 60, 120)
	if len(b.Pages) != 1 || !approxPt(b.Pages[0].WidthPt, pdfcore.A4WidthPt) || !approxPt(b.Pages[0].HeightPt, pdfcore.A4HeightPt) {
		t.Fatalf("portrait image should become a portrait A4 page: %+v", b.Pages)
	}

	merged := rewrite(a.ID, []composePageRef{
		{FileID: a.ID, PageNumber: 1},
		{FileID: b.ID, PageNumber: 1},
	}, 200)
	if merged.ID != a.ID {
		t.Fatalf("rewrite must keep the file id, got %s", merged.ID)
	}
	if merged.PageCount != 2 || len(merged.Pages) != 2 {
		t.Fatalf("expected 2 pages after merge: %+v", merged)
	}
	if !approxPt(merged.Pages[1].WidthPt, pdfcore.A4WidthPt) {
		t.Fatalf("second page should come from file b (portrait A4): %+v", merged.Pages[1])
	}

	undone := rewrite(a.ID, []composePageRef{{FileID: a.ID, PageNumber: 1}}, 200)
	if undone.PageCount != 1 {
		t.Fatalf("undo should trim back to 1 page: %+v", undone)
	}

	rewrite(a.ID, nil, 400)
	rewrite(a.ID, []composePageRef{{FileID: "missing", PageNumber: 1}}, 400)
}

func TestSanitizeOutputName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "合同-已盖章", "合同-已盖章.pdf"},
		{"keeps pdf suffix once", "合同-已盖章.PDF", "合同-已盖章.pdf"},
		{"strips path separators", `..\..\evil/name.pdf`, "evilname.pdf"},
		{"strips reserved chars", `a<b>c:d"e|f?g*h.pdf`, "abcdefgh.pdf"},
		{"strips control chars", "a\x00b\nc.pdf", "abc.pdf"},
		{"trims dots and spaces", "  name... ", "name.pdf"},
		{"empty becomes default", "   ", ""},
		{"only suffix becomes default", ".pdf", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeOutputName(tc.in); got != tc.want {
				t.Fatalf("sanitizeOutputName(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

func TestSanitizeOutputNameLength(t *testing.T) {
	long := strings.Repeat("很", 300) + ".pdf"
	got := sanitizeOutputName(long)
	if !strings.HasSuffix(got, ".pdf") {
		t.Fatalf("expected .pdf suffix, got %q", got)
	}
	if runes := []rune(got); len(runes) > maxOutputNameRunes+len(".pdf") {
		t.Fatalf("expected at most %d runes, got %d", maxOutputNameRunes+len(".pdf"), len(runes))
	}
}

func TestContentDisposition(t *testing.T) {
	got := contentDisposition("合同 v2.pdf", false)
	if !strings.HasPrefix(got, "attachment; ") {
		t.Fatalf("expected attachment disposition, got %q", got)
	}
	if !strings.Contains(got, `filename="__ v2.pdf"`) {
		t.Fatalf("expected ascii fallback, got %q", got)
	}
	if !strings.Contains(got, "filename*=UTF-8''%E5%90%88%E5%90%8C%20v2.pdf") {
		t.Fatalf("expected RFC 5987 encoded name, got %q", got)
	}

	inline := contentDisposition("a.pdf", true)
	if !strings.HasPrefix(inline, "inline; ") {
		t.Fatalf("expected inline disposition, got %q", inline)
	}
}
