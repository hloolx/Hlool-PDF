package pdf

import (
	"image"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"testing"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// makeTestPDF renders a w×h PNG and converts it to a one-page PDF, returning the
// path. ImageToPDF lays the image onto an A4 page (portrait for tall images,
// landscape for wide ones), so the page dimensions are deterministic.
func makeTestPDF(t *testing.T, w, h int) string {
	t.Helper()
	dir := t.TempDir()
	imgPath := filepath.Join(dir, "img.png")
	f, err := os.Create(imgPath)
	if err != nil {
		t.Fatalf("create png: %v", err)
	}
	if err := png.Encode(f, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		f.Close()
		t.Fatalf("encode png: %v", err)
	}
	f.Close()
	pdfPath := filepath.Join(dir, "in.pdf")
	if err := ImageToPDF(imgPath, pdfPath); err != nil {
		t.Fatalf("image to pdf: %v", err)
	}
	return pdfPath
}

func pageDims(t *testing.T, path string) (w, h float64) {
	t.Helper()
	pages, err := PageInfo(path, "")
	if err != nil {
		t.Fatalf("page info: %v", err)
	}
	if len(pages) != 1 {
		t.Fatalf("expected 1 page, got %d", len(pages))
	}
	return pages[0].WidthPt, pages[0].HeightPt
}

// pageRotateEntry returns the page's own /Rotate value and whether the entry exists.
func pageRotateEntry(t *testing.T, path string) (int, bool) {
	t.Helper()
	ctx, err := api.ReadContextFile(path)
	if err != nil {
		t.Fatalf("read context: %v", err)
	}
	d, _, _, err := ctx.PageDict(1, false)
	if err != nil {
		t.Fatalf("page dict: %v", err)
	}
	obj, found := d.Find("Rotate")
	if !found {
		return 0, false
	}
	if n, ok := obj.(types.Integer); ok {
		return n.Value(), true
	}
	return 0, true
}

func approxEq(a, b float64) bool { return math.Abs(a-b) < 0.5 }

func TestRotatePagesBaked90SwapsDimensionsAndClearsFlag(t *testing.T) {
	in := makeTestPDF(t, 100, 200) // tall image → portrait A4
	w0, h0 := pageDims(t, in)
	if w0 >= h0 {
		t.Fatalf("expected a portrait page, got %.2f×%.2f", w0, h0)
	}

	out := filepath.Join(t.TempDir(), "rot.pdf")
	if err := RotatePagesBaked(in, out, map[int]int{1: 90}); err != nil {
		t.Fatalf("rotate: %v", err)
	}

	w1, h1 := pageDims(t, out)
	if !approxEq(w1, h0) || !approxEq(h1, w0) {
		t.Fatalf("dimensions not swapped: before %.2f×%.2f, after %.2f×%.2f", w0, h0, w1, h1)
	}

	// Crucial: rotation must be BAKED, not left as a /Rotate flag. (PageInfo alone
	// can't tell the two apart, since pdfcpu's PageDims swaps dims for flagged pages.)
	if rot, found := pageRotateEntry(t, out); found && rot != 0 {
		t.Fatalf("expected /Rotate cleared (baked), got %d (found=%v)", rot, found)
	}
}

func TestRotatePagesBaked180KeepsDimensions(t *testing.T) {
	in := makeTestPDF(t, 100, 200)
	w0, h0 := pageDims(t, in)

	out := filepath.Join(t.TempDir(), "rot.pdf")
	if err := RotatePagesBaked(in, out, map[int]int{1: 180}); err != nil {
		t.Fatalf("rotate: %v", err)
	}

	w1, h1 := pageDims(t, out)
	if !approxEq(w1, w0) || !approxEq(h1, h0) {
		t.Fatalf("180° must keep dimensions: before %.2f×%.2f, after %.2f×%.2f", w0, h0, w1, h1)
	}
	if rot, found := pageRotateEntry(t, out); found && rot != 0 {
		t.Fatalf("expected /Rotate cleared, got %d", rot)
	}
}

func TestRotatePagesBaked270Swaps(t *testing.T) {
	in := makeTestPDF(t, 200, 100) // wide image → landscape A4
	w0, h0 := pageDims(t, in)
	if w0 <= h0 {
		t.Fatalf("expected a landscape page, got %.2f×%.2f", w0, h0)
	}
	out := filepath.Join(t.TempDir(), "rot.pdf")
	if err := RotatePagesBaked(in, out, map[int]int{1: 270}); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	w1, h1 := pageDims(t, out)
	if !approxEq(w1, h0) || !approxEq(h1, w0) {
		t.Fatalf("270° must swap dimensions: before %.2f×%.2f, after %.2f×%.2f", w0, h0, w1, h1)
	}
}

func TestRotatePagesBakedZeroIsNoop(t *testing.T) {
	in := makeTestPDF(t, 100, 200)
	w0, h0 := pageDims(t, in)
	out := filepath.Join(t.TempDir(), "rot.pdf")
	// 0 and 360 normalize to no rotation; output must still be a valid 1-page PDF.
	if err := RotatePagesBaked(in, out, map[int]int{1: 360}); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	w1, h1 := pageDims(t, out)
	if !approxEq(w1, w0) || !approxEq(h1, h0) {
		t.Fatalf("no-op rotation changed dimensions: %.2f×%.2f → %.2f×%.2f", w0, h0, w1, h1)
	}
}

func TestRotatePagesBakedRejectsNonRightAngle(t *testing.T) {
	in := makeTestPDF(t, 100, 200)
	out := filepath.Join(t.TempDir(), "rot.pdf")
	if err := RotatePagesBaked(in, out, map[int]int{1: 45}); err == nil {
		t.Fatal("expected error for non-90° rotation")
	}
}

func TestRotatePagesBakedRejectsOutOfRangePage(t *testing.T) {
	in := makeTestPDF(t, 100, 200)
	out := filepath.Join(t.TempDir(), "rot.pdf")
	if err := RotatePagesBaked(in, out, map[int]int{5: 90}); err == nil {
		t.Fatal("expected error for out-of-range page")
	}
}
