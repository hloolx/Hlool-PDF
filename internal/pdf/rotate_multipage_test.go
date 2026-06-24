package pdf

import (
	"path/filepath"
	"testing"
)

// TestRotateAfterComposeMultiPage mirrors the real recompose flow: a multi-page
// PDF (built like the app builds one — merged single-page sources) is re-collected
// in order and then one page is rotated. Exercises merged page-tree structures the
// single-image fixtures don't.
func TestRotateAfterComposeMultiPage(t *testing.T) {
	a := makeTestPDF(t, 100, 200)
	b := makeTestPDF(t, 200, 100)
	c := makeTestPDF(t, 150, 150)

	merged := filepath.Join(t.TempDir(), "merged.pdf")
	if err := ComposePDF(merged, []ComposeRun{
		{Path: a, Pages: []int{1}},
		{Path: b, Pages: []int{1}},
		{Path: c, Pages: []int{1}},
	}); err != nil {
		t.Fatalf("merge: %v", err)
	}
	if pages, _ := PageInfo(merged, ""); len(pages) != 3 {
		t.Fatalf("merged should have 3 pages, got %d", len(pages))
	}

	// Recompose "rotate page 2": collect all pages in order, then bake the rotation.
	composed := filepath.Join(t.TempDir(), "composed.pdf")
	if err := ComposePDF(composed, []ComposeRun{{Path: merged, Pages: []int{1, 2, 3}}}); err != nil {
		t.Fatalf("recompose collect: %v", err)
	}
	out := filepath.Join(t.TempDir(), "out.pdf")
	if err := RotatePagesBaked(composed, out, map[int]int{2: 90}); err != nil {
		t.Fatalf("rotate page 2 of merged pdf: %v", err)
	}
	pages, err := PageInfo(out, "")
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if len(pages) != 3 {
		t.Fatalf("want 3 pages after rotate, got %d", len(pages))
	}
	if rot, found := pageRotateEntry(t, out); found && rot != 0 {
		t.Fatalf("page 1 /Rotate should be cleared, got %d", rot)
	}
}
