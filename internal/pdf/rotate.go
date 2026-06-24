package pdf

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"
)

// RotatePagesBaked bakes a clockwise rotation (a multiple of 90°) into each
// requested page and writes the result to outputPath. Unlike pdfcpu's RotateFile —
// which only sets the page's /Rotate flag — this internalizes the rotation into the
// content stream and swaps the MediaBox, leaving /Rotate at 0. The rest of the
// pipeline (placement coordinates, seam geometry, PDF.js rendering) therefore keeps
// operating on plain, unrotated pages whose width/height simply reflect the new
// orientation, preserving the "geometry == effective pt, origin bottom-left"
// invariant the whole app relies on.
//
// This mirrors the transform pdfcpu itself applies when stamping a page that
// carries a /Rotate (see pkg/pdfcpu/stamp.go: "Internalize page rotation into
// content stream"), minus the watermark.
//
// rotations maps a 1-based page number to a rotation in degrees; each value is
// normalized to {0,90,180,270} and 0 is skipped.
func RotatePagesBaked(inputPath, outputPath string, rotations map[int]int) (err error) {
	// pdfcpu surfaces some low-level faults via panic; convert any into an error.
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("rotate pages: %v", r)
		}
	}()

	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}

	ctx, err := api.ReadContextFile(inputPath)
	if err != nil {
		return err
	}
	for pageNr, deg := range rotations {
		rot := ((deg % 360) + 360) % 360
		if rot == 0 {
			continue
		}
		if rot%90 != 0 {
			return fmt.Errorf("rotation must be a multiple of 90, got %d", deg)
		}
		if pageNr < 1 || pageNr > ctx.PageCount {
			return fmt.Errorf("page %d is out of range", pageNr)
		}
		if err := bakePageRotation(ctx, pageNr, rot); err != nil {
			return err
		}
	}
	return api.WriteContextFile(ctx, outputPath)
}

// bakePageRotation internalizes a rotation of rot degrees (90/180/270) into a
// single page's content stream and swaps its box dimensions when needed.
func bakePageRotation(ctx *model.Context, pageNr, rot int) error {
	d, _, inhPAttrs, err := ctx.PageDict(pageNr, false)
	if err != nil {
		return err
	}
	if d == nil {
		return fmt.Errorf("unknown page number %d", pageNr)
	}

	// Effective visible box (CropBox wins over MediaBox when present).
	vp := inhPAttrs.MediaBox
	if inhPAttrs.CropBox != nil {
		vp = inhPAttrs.CropBox
	}
	if vp == nil {
		return fmt.Errorf("page %d has no media box", pageNr)
	}

	// Bake the total (existing + requested) rotation. Working PDFs keep /Rotate at
	// 0, but accounting for an existing rotation keeps this correct for sources that
	// already carry one.
	total := ((inhPAttrs.Rotate+rot)%360 + 360) % 360
	box := types.NewRectangle(vp.LL.X, vp.LL.Y, vp.UR.X, vp.UR.Y)
	if total == 90 || total == 270 {
		w := box.Width()
		box.UR.X = box.LL.X + box.Height()
		box.UR.Y = box.LL.Y + w
	}

	// Wrap existing content in a rotation CTM (q … Q). ContentBytesForPageRotation
	// expects the post-swap box dimensions (matches pdfcpu's own internalization).
	prefix := append([]byte("q "), model.ContentBytesForPageRotation(total, box.Width(), box.Height())...)
	if err := wrapPageContents(ctx, d, prefix, []byte(" Q")); err != nil {
		return err
	}

	d.Update("MediaBox", box.Array())
	d.Update("CropBox", box.Array())
	d.Delete("Rotate")
	return nil
}

// wrapPageContents prepends prefix and appends suffix to a page's content as two
// new content streams, turning Contents into [pre, …existing, post]. Existing
// streams are left untouched (no decode/re-encode), so this is robust regardless of
// their filters. PDF concatenates all content streams of a page, so a q/Q pair
// split across separate streams still brackets the original content correctly.
func wrapPageContents(ctx *model.Context, d types.Dict, prefix, suffix []byte) error {
	pre, err := newContentStream(ctx, prefix)
	if err != nil {
		return err
	}
	post, err := newContentStream(ctx, suffix)
	if err != nil {
		return err
	}

	obj, found := d.Find("Contents")
	if !found || obj == nil {
		d.Update("Contents", types.Array{*pre, *post})
		return nil
	}

	var inner types.Array
	switch o := obj.(type) {
	case types.IndirectRef:
		deref, err := ctx.Dereference(o)
		if err != nil {
			return err
		}
		if arr, ok := deref.(types.Array); ok {
			inner = arr // Contents was an indirect ref to an array of streams.
		} else {
			inner = types.Array{o} // …to a single stream; keep referencing it.
		}
	case types.Array:
		inner = o
	default:
		ir, err := ctx.IndRefForNewObject(o) // inline stream dict — promote to object.
		if err != nil {
			return err
		}
		inner = types.Array{*ir}
	}

	combined := make(types.Array, 0, len(inner)+2)
	combined = append(combined, *pre)
	combined = append(combined, inner...)
	combined = append(combined, *post)
	d.Update("Contents", combined)
	return nil
}

func newContentStream(ctx *model.Context, buf []byte) (*types.IndirectRef, error) {
	sd, err := ctx.NewStreamDictForBuf(buf)
	if err != nil {
		return nil, err
	}
	if err := sd.Encode(); err != nil {
		return nil, err
	}
	return ctx.IndRefForNewObject(*sd)
}
