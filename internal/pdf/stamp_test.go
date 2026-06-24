package pdf

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// TestBatchByOpacity locks in the contiguous-run grouping that keeps the
// batched pipeline correct: same adjacent opacity merges, a change starts a new
// pass, and a later return to an earlier opacity is a separate batch (so
// front-to-back order is preserved for overlapping stamps).
func TestBatchByOpacity(t *testing.T) {
	items := []wmItem{
		{page: 1, opacity: 1}, {page: 2, opacity: 1},
		{page: 1, opacity: 0.5},
		{page: 1, opacity: 1}, {page: 3, opacity: 1},
	}
	batches := batchByOpacity(items)
	if got := len(batches); got != 3 {
		t.Fatalf("batches = %d, want 3", got)
	}
	if len(batches[0]) != 2 || len(batches[1]) != 1 || len(batches[2]) != 2 {
		t.Fatalf("batch sizes = %d/%d/%d, want 2/1/2", len(batches[0]), len(batches[1]), len(batches[2]))
	}

	uniform := []wmItem{{opacity: 1}, {opacity: 1}, {opacity: 1}}
	if got := len(batchByOpacity(uniform)); got != 1 {
		t.Fatalf("uniform opacity should collapse to 1 batch, got %d", got)
	}
	if batchByOpacity(nil) != nil {
		t.Fatal("nil items should yield no batches")
	}
}

// TestStampPDFMultiPlacementAndSeam stamps a 3-page PDF with several placements
// (mixed opacity, two on the same page) plus a seam seal, then confirms the
// result is a valid PDF with the page count preserved.
func TestStampPDFMultiPlacementAndSeam(t *testing.T) {
	dir := t.TempDir()
	src := makeMultiPagePDF(t, dir, 3)
	stamp := makeStamp(t, dir, 100, 40)

	pages, err := PageInfo(src, "")
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	if len(pages) != 3 {
		t.Fatalf("source pages = %d, want 3", len(pages))
	}

	out := filepath.Join(dir, "out.pdf")
	opts := StampOptions{
		Placements: []Placement{
			{StampID: "s", PageNumber: 1, XPt: 10, YPt: 10, WidthPt: 50, HeightPt: 20, Opacity: 1},
			{StampID: "s", PageNumber: 2, XPt: 10, YPt: 10, WidthPt: 50, HeightPt: 20, Opacity: 1},
			{StampID: "s", PageNumber: 1, XPt: 30, YPt: 30, WidthPt: 50, HeightPt: 20, Opacity: 0.5},
		},
		SeamSeals: []SeamSeal{
			{StampID: "s", Pages: "1-3", Side: "right", SizePt: 60, PositionPercent: 50, Opacity: 1},
		},
	}
	stamps := map[string]StampAsset{"s": {Path: stamp, WidthPx: 100, HeightPx: 40}}
	if err := StampPDF(src, out, pages, opts, stamps); err != nil {
		t.Fatalf("StampPDF: %v", err)
	}

	outPages, err := PageInfo(out, "")
	if err != nil {
		t.Fatalf("read result: %v", err)
	}
	if len(outPages) != 3 {
		t.Fatalf("result pages = %d, want 3", len(outPages))
	}
	assertNoLeftoverTemps(t, out)
}

// TestStampPDFNoStampsPassthrough verifies the zero-watermark path still emits a
// valid copy of the source.
func TestStampPDFNoStampsPassthrough(t *testing.T) {
	dir := t.TempDir()
	src := makeMultiPagePDF(t, dir, 2)
	pages, err := PageInfo(src, "")
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	out := filepath.Join(dir, "out.pdf")
	if err := StampPDF(src, out, pages, StampOptions{}, nil); err != nil {
		t.Fatalf("StampPDF passthrough: %v", err)
	}
	if outPages, err := PageInfo(out, ""); err != nil || len(outPages) != 2 {
		t.Fatalf("passthrough result pages = %v (err %v), want 2", len(outPages), err)
	}
}

// TestStampPDFEncrypts verifies the optional output password still encrypts the
// stamped result.
func TestStampPDFEncrypts(t *testing.T) {
	dir := t.TempDir()
	src := makeMultiPagePDF(t, dir, 2)
	stamp := makeStamp(t, dir, 80, 40)
	pages, err := PageInfo(src, "")
	if err != nil {
		t.Fatalf("read source: %v", err)
	}
	out := filepath.Join(dir, "out.pdf")
	opts := StampOptions{
		Placements:     []Placement{{StampID: "s", PageNumber: 1, XPt: 10, YPt: 10, WidthPt: 40, HeightPt: 20, Opacity: 1}},
		OutputPassword: "secret-pw",
	}
	stamps := map[string]StampAsset{"s": {Path: stamp, WidthPx: 80, HeightPx: 40}}
	if err := StampPDF(src, out, pages, opts, stamps); err != nil {
		t.Fatalf("StampPDF encrypt: %v", err)
	}
	if _, err := PageInfo(out, ""); !IsPasswordError(err) {
		t.Fatalf("expected password error without password, got %v", err)
	}
	if _, err := PageInfo(out, "secret-pw"); err != nil {
		t.Fatalf("reading with password failed: %v", err)
	}
}

/* ---------------- helpers ---------------- */

func makeStamp(t *testing.T, dir string, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: 200, G: 30, B: 30, A: 255})
		}
	}
	path := filepath.Join(dir, "stamp.png")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := png.Encode(f, img); err != nil {
		t.Fatal(err)
	}
	return path
}

// makeMultiPagePDF builds a `pages`-page PDF by composing that many one-page
// image PDFs.
func makeMultiPagePDF(t *testing.T, dir string, pages int) string {
	t.Helper()
	runs := make([]ComposeRun, 0, pages)
	for i := 0; i < pages; i++ {
		imgPath := makeStamp(t, filepath.Join(t.TempDir()), 300, 400)
		pdfPath := filepath.Join(dir, "page.pdf")
		pdfPath = pdfPath[:len(pdfPath)-4] + string(rune('A'+i)) + ".pdf"
		if err := ImageToPDF(imgPath, pdfPath); err != nil {
			t.Fatal(err)
		}
		runs = append(runs, ComposeRun{Path: pdfPath, Pages: []int{1}})
	}
	out := filepath.Join(dir, "src.pdf")
	if err := ComposePDF(out, runs); err != nil {
		t.Fatal(err)
	}
	return out
}

// assertNoLeftoverTemps fails if any of StampPDF's intermediate .tmp files
// survived next to the output.
func assertNoLeftoverTemps(t *testing.T, out string) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Dir(out))
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Base(out)
	for _, e := range entries {
		name := e.Name()
		if name != base && len(name) > len(base) && name[:len(base)] == base {
			t.Fatalf("leftover temp file: %s", name)
		}
	}
}
