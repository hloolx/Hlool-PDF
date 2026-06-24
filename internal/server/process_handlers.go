package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"hlool-pdf/internal/library"
	pdfcore "hlool-pdf/internal/pdf"
	"hlool-pdf/internal/storage"
)

type processParams struct {
	Placements          []pdfcore.Placement `json:"placements"`
	SeamSeals           []pdfcore.SeamSeal  `json:"seamSeals"`
	OutputPassword      string              `json:"outputPassword"`
	OutputOwnerPassword string              `json:"outputOwnerPassword"`
	OutputName          string              `json:"outputName"`
}

// process stamps an uploaded PDF and streams the result back, then deletes every
// temporary file. Nothing is persisted server-side.
func (s *Server) process(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.opts.MaxProcessBodyBytes)
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid upload"))
		return
	}
	defer cleanupMultipart(r)

	var req processParams
	if err := json.Unmarshal([]byte(r.FormValue("params")), &req); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid parameters"))
		return
	}
	if len(req.Placements) > maxPlacementsPerJob {
		writeError(w, http.StatusBadRequest, fmt.Errorf("too many stamp placements; max is %d", maxPlacementsPerJob))
		return
	}
	if len(req.SeamSeals) > maxSeamSealsPerJob {
		writeError(w, http.StatusBadRequest, fmt.Errorf("too many seam seals; max is %d", maxSeamSealsPerJob))
		return
	}
	if len(req.OutputPassword) > maxPasswordLength || len(req.OutputOwnerPassword) > maxPasswordLength {
		writeError(w, http.StatusBadRequest, errors.New("output password is too long"))
		return
	}

	dir, err := os.MkdirTemp("", "hlool-process-*")
	if err != nil {
		writeInternalError(w, "process tempdir", err)
		return
	}
	defer os.RemoveAll(dir)

	inPath := filepath.Join(dir, "in.pdf")
	if _, err := saveFormFile(r, "file", inPath); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("a PDF file is required"))
		return
	}

	working := inPath
	if password := r.FormValue("password"); password != "" {
		plain := filepath.Join(dir, "plain.pdf")
		if err := pdfcore.DecryptPDF(inPath, plain, password); err != nil {
			if pdfcore.IsPasswordError(err) {
				writeCodedError(w, http.StatusBadRequest, "password_required", errors.New("PDF password is incorrect"))
				return
			}
			writeError(w, http.StatusBadRequest, errors.New("the PDF could not be opened"))
			return
		}
		working = plain
	}

	pages, err := pdfcore.PageInfo(working, "")
	if err != nil {
		if r.FormValue("password") == "" && pdfcore.IsPasswordError(err) {
			writeCodedError(w, http.StatusBadRequest, "password_required", errors.New("PDF password is required"))
			return
		}
		writeError(w, http.StatusBadRequest, errors.New("the PDF could not be read"))
		return
	}
	if len(pages) > maxPDFPages {
		writeError(w, http.StatusBadRequest, fmt.Errorf("PDF has too many pages; max is %d", maxPDFPages))
		return
	}

	metas, err := s.collectStampMetas(r.Context(), uid(r), req)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := validateProcessRequest(req, pages, metas); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	stamps, err := s.resolveStampFiles(r.Context(), uid(r), dir, metas)
	if err != nil {
		writeInternalError(w, "resolve stamps", err)
		return
	}

	outPath := filepath.Join(dir, "out.pdf")
	if err := pdfcore.StampPDF(working, outPath, pages, pdfcore.StampOptions{
		Placements:          req.Placements,
		SeamSeals:           req.SeamSeals,
		OutputPassword:      req.OutputPassword,
		OutputOwnerPassword: req.OutputOwnerPassword,
	}, stamps); err != nil {
		writeInternalError(w, "stamp pdf", err)
		return
	}

	name := sanitizeOutputName(req.OutputName)
	if name == "" {
		name = "hlool-pdf.pdf"
	}
	streamPDF(w, outPath, name)
}

type composePageRef struct {
	File       int `json:"file"` // index into the uploaded "file" parts
	PageNumber int `json:"pageNumber"`
	// Rotate is a clockwise rotation in degrees (multiple of 90) baked into this
	// output page after composing; 0 means no rotation.
	Rotate int `json:"rotate"`
}

type composeParams struct {
	Name  string           `json:"name"`
	Pages []composePageRef `json:"pages"`
}

// compose merges/reorders pages from several uploaded PDFs into one and streams
// it back, deleting every temp file afterwards.
func (s *Server) compose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.opts.MaxProcessBodyBytes)
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid upload"))
		return
	}
	defer cleanupMultipart(r)

	var req composeParams
	if err := json.Unmarshal([]byte(r.FormValue("params")), &req); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid parameters"))
		return
	}
	if len(req.Pages) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("at least one page is required"))
		return
	}
	if len(req.Pages) > maxComposePages {
		writeError(w, http.StatusBadRequest, fmt.Errorf("too many pages to compose; max is %d", maxComposePages))
		return
	}
	files := r.MultipartForm.File["file"]
	if len(files) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("at least one PDF is required"))
		return
	}
	if len(files) > maxComposeFiles {
		writeError(w, http.StatusBadRequest, fmt.Errorf("too many source files; max is %d", maxComposeFiles))
		return
	}

	dir, err := os.MkdirTemp("", "hlool-compose-*")
	if err != nil {
		writeInternalError(w, "compose tempdir", err)
		return
	}
	defer os.RemoveAll(dir)

	// Optional single open password, applied to whichever sources are encrypted.
	// Lets reorder/delete/rotate work on password-protected PDFs (read-and-burn:
	// the decrypted copy lives only in this temp dir).
	password := r.FormValue("password")

	paths := make([]string, len(files))
	counts := make([]int, len(files))
	for i, fh := range files {
		p := filepath.Join(dir, fmt.Sprintf("src_%03d.pdf", i))
		if err := saveMultipartFileHeader(fh, p); err != nil {
			writeError(w, http.StatusBadRequest, errors.New("a PDF file could not be read"))
			return
		}
		pages, err := pdfcore.PageInfo(p, "")
		if err != nil && password != "" && pdfcore.IsPasswordError(err) {
			plain := filepath.Join(dir, fmt.Sprintf("plain_%03d.pdf", i))
			if derr := pdfcore.DecryptPDF(p, plain, password); derr != nil {
				if pdfcore.IsPasswordError(derr) {
					writeCodedError(w, http.StatusBadRequest, "password_required", errors.New("PDF password is incorrect"))
					return
				}
				writeError(w, http.StatusBadRequest, errors.New("the PDF could not be opened"))
				return
			}
			p = plain
			pages, err = pdfcore.PageInfo(p, "")
		}
		if err != nil {
			if password == "" && pdfcore.IsPasswordError(err) {
				writeCodedError(w, http.StatusBadRequest, "password_required", errors.New("PDF password is required"))
				return
			}
			writeError(w, http.StatusBadRequest, errors.New("a PDF file could not be read"))
			return
		}
		paths[i] = p
		counts[i] = len(pages)
	}

	runs, err := buildComposeRuns(req.Pages, paths, counts)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	composedPath := filepath.Join(dir, "composed.pdf")
	if err := pdfcore.ComposePDF(composedPath, runs); err != nil {
		writeInternalError(w, "compose pdf", err)
		return
	}

	// Bake any per-page rotations into the composed result (output page i ⇐ req.Pages[i]).
	// Rotation is internalized into page geometry so downstream stays on unrotated pt.
	rotations := map[int]int{}
	for i, ref := range req.Pages {
		rot := ((ref.Rotate % 360) + 360) % 360
		if rot == 0 {
			continue
		}
		if rot%90 != 0 {
			writeError(w, http.StatusBadRequest, errors.New("rotation must be a multiple of 90 degrees"))
			return
		}
		rotations[i+1] = rot
	}
	outPath := composedPath
	if len(rotations) > 0 {
		outPath = filepath.Join(dir, "out.pdf")
		if err := pdfcore.RotatePagesBaked(composedPath, outPath, rotations); err != nil {
			writeInternalError(w, "rotate pages", err)
			return
		}
	}
	outPages, err := pdfcore.PageInfo(outPath, "")
	if err != nil {
		writeInternalError(w, "compose verify", err)
		return
	}
	if len(outPages) > maxPDFPages {
		writeError(w, http.StatusBadRequest, fmt.Errorf("PDF has too many pages; max is %d", maxPDFPages))
		return
	}

	name := sanitizeOutputName(req.Name)
	if name == "" {
		name = "拼接文档.pdf"
	}
	streamPDF(w, outPath, name)
}

// imageToPDF turns a single uploaded image into a one-page A4 PDF and streams it.
func (s *Server) imageToPDF(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.opts.MaxProcessBodyBytes)
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid upload"))
		return
	}
	defer cleanupMultipart(r)

	dir, err := os.MkdirTemp("", "hlool-image-*")
	if err != nil {
		writeInternalError(w, "image tempdir", err)
		return
	}
	defer os.RemoveAll(dir)

	ext := ".png"
	imgPath := filepath.Join(dir, "img"+ext)
	header, err := saveFormFile(r, "file", imgPath)
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("an image file is required"))
		return
	}
	outPath := filepath.Join(dir, "out.pdf")
	if err := pdfcore.ImageToPDF(imgPath, outPath); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("无法识别的图片内容，请使用 PNG / JPG"))
		return
	}
	base := strings.TrimSuffix(filepath.Base(header.Filename), filepath.Ext(header.Filename))
	name := sanitizeOutputName(base)
	if name == "" {
		name = "图片文档.pdf"
	}
	streamPDF(w, outPath, name)
}

/* ---------------- stamp resolution ---------------- */

// collectStampMetas loads metadata for every stamp referenced by the request,
// failing if any is missing.
func (s *Server) collectStampMetas(ctx context.Context, userID string, req processParams) (map[string]library.StampMeta, error) {
	ids := map[string]struct{}{}
	for _, p := range req.Placements {
		ids[p.StampID] = struct{}{}
	}
	for _, seam := range req.SeamSeals {
		ids[seam.StampID] = struct{}{}
	}
	metas := make(map[string]library.StampMeta, len(ids))
	for id := range ids {
		if id == "" {
			return nil, errors.New("stamp id is required")
		}
		meta, err := s.lib.StampMeta(ctx, userID, id)
		if err != nil {
			if errors.Is(err, library.ErrStampNotFound) {
				return nil, errors.New("a referenced stamp was not found")
			}
			return nil, err
		}
		metas[id] = meta
	}
	return metas, nil
}

// resolveStampFiles writes each stamp's bytes into the temp dir and returns the
// pdf-pipeline asset map keyed by stamp id.
func (s *Server) resolveStampFiles(ctx context.Context, userID, dir string, metas map[string]library.StampMeta) (map[string]pdfcore.StampAsset, error) {
	out := make(map[string]pdfcore.StampAsset, len(metas))
	for id, meta := range metas {
		_, rc, err := s.lib.GetStamp(ctx, userID, id)
		if err != nil {
			return nil, err
		}
		path := filepath.Join(dir, "stamp_"+id+stampExt(meta.Mime))
		err = writeReadCloserToFile(rc, path)
		if err != nil {
			return nil, err
		}
		out[id] = pdfcore.StampAsset{Path: path, WidthPx: meta.WidthPx, HeightPx: meta.HeightPx}
	}
	return out, nil
}

func stampExt(mimeType string) string {
	if mimeType == "image/jpeg" {
		return ".jpg"
	}
	return ".png"
}

/* ---------------- compose runs ---------------- */

// buildComposeRuns validates page references and groups consecutive pages from
// the same source file into a single run (preserving order).
func buildComposeRuns(pages []composePageRef, paths []string, counts []int) ([]pdfcore.ComposeRun, error) {
	var runs []pdfcore.ComposeRun
	lastFile := -1
	for _, ref := range pages {
		if ref.File < 0 || ref.File >= len(paths) {
			return nil, errors.New("page references an unknown file")
		}
		if ref.PageNumber < 1 || ref.PageNumber > counts[ref.File] {
			return nil, fmt.Errorf("page %d is out of range", ref.PageNumber)
		}
		if ref.File != lastFile || len(runs) == 0 {
			runs = append(runs, pdfcore.ComposeRun{Path: paths[ref.File]})
			lastFile = ref.File
		}
		runs[len(runs)-1].Pages = append(runs[len(runs)-1].Pages, ref.PageNumber)
	}
	return runs, nil
}

/* ---------------- validation ---------------- */

func validateProcessRequest(req processParams, pages []storage.PageInfo, metas map[string]library.StampMeta) error {
	if len(req.OutputName) > 512 {
		return errors.New("output name is too long")
	}
	pageByNumber := map[int]storage.PageInfo{}
	for _, page := range pages {
		pageByNumber[page.PageNumber] = page
	}
	for _, placement := range req.Placements {
		page, ok := pageByNumber[placement.PageNumber]
		if !ok {
			return fmt.Errorf("page %d is out of range", placement.PageNumber)
		}
		stamp, ok := metas[placement.StampID]
		if !ok {
			return errors.New("a referenced stamp was not found")
		}
		if !finiteAll(placement.XPt, placement.YPt, placement.WidthPt, placement.HeightPt, placement.Rotation, placement.Opacity) {
			return errors.New("stamp placement contains an invalid number")
		}
		if placement.WidthPt <= 0 || placement.HeightPt <= 0 {
			return errors.New("stamp width and height must be greater than zero")
		}
		if placement.WidthPt > page.WidthPt*2 || placement.HeightPt > page.HeightPt*2 {
			return fmt.Errorf("stamp on page %d is too large", placement.PageNumber)
		}
		expectedHeight := placement.WidthPt * float64(stamp.HeightPx) / float64(stamp.WidthPx)
		if math.Abs(expectedHeight-placement.HeightPt) > 2 {
			return errors.New("stamp height must match the image aspect ratio")
		}
		if placement.Rotation < -180 || placement.Rotation > 180 {
			return errors.New("stamp rotation must be between -180 and 180")
		}
		if placement.XPt < -page.WidthPt || placement.XPt > page.WidthPt*2 || placement.YPt < -page.HeightPt || placement.YPt > page.HeightPt*2 {
			return fmt.Errorf("stamp on page %d is outside the allowed coordinate range", placement.PageNumber)
		}
		if placement.Opacity < 0 || placement.Opacity > 1 {
			return errors.New("stamp opacity must be between 0 and 1")
		}
	}
	for _, seam := range req.SeamSeals {
		if _, ok := metas[seam.StampID]; !ok {
			return errors.New("a referenced stamp was not found")
		}
		if seam.Side != "" {
			switch strings.ToLower(strings.TrimSpace(seam.Side)) {
			case "left", "right", "top", "bottom":
			default:
				return errors.New("invalid seam seal side")
			}
		}
		if len(seam.Pages) > 128 {
			return errors.New("seam seal page expression is too long")
		}
		pages, err := parsePageScope(seam.Pages, len(pages))
		if err != nil {
			return err
		}
		if len(pages) < 2 {
			return errors.New("seam seal needs at least two pages")
		}
		if len(pages) > maxPagesPerSeamSeal {
			return fmt.Errorf("too many pages for one seam seal; max is %d", maxPagesPerSeamSeal)
		}
		if !finiteAll(seam.SizePt, seam.PositionPercent, seam.MarginPt, seam.Opacity) {
			return errors.New("seam seal contains an invalid number")
		}
		if seam.SizePt < 0 || seam.SizePt > 2000 {
			return errors.New("seam seal size is out of range")
		}
		if seam.PositionPercent < 0 || seam.PositionPercent > 100 {
			return errors.New("seam seal position must be between 0 and 100")
		}
		if seam.MarginPt < 0 || seam.MarginPt > 1000 {
			return errors.New("seam seal margin is out of range")
		}
		if seam.Opacity < 0 || seam.Opacity > 1 {
			return errors.New("seam seal opacity must be between 0 and 1")
		}
		if seam.MaxSlices < 0 || seam.MaxSlices > 500 {
			return errors.New("seam seal max slices is out of range")
		}
	}
	return nil
}

func parsePageScope(expr string, pageCount int) ([]int, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" || strings.EqualFold(expr, "all") {
		pages := make([]int, pageCount)
		for i := range pages {
			pages[i] = i + 1
		}
		return pages, nil
	}
	pages := map[int]struct{}{}
	for _, raw := range strings.Split(expr, ",") {
		part := strings.TrimSpace(raw)
		if part == "" {
			continue
		}
		if strings.Contains(part, "-") {
			bounds := strings.SplitN(part, "-", 2)
			start, err := parsePositiveInt(bounds[0])
			if err != nil {
				return nil, fmt.Errorf("invalid page range %q", part)
			}
			end, err := parsePositiveInt(bounds[1])
			if err != nil {
				return nil, fmt.Errorf("invalid page range %q", part)
			}
			if end < start {
				start, end = end, start
			}
			for page := start; page <= end; page++ {
				if page < 1 || page > pageCount {
					return nil, fmt.Errorf("page %d is out of range", page)
				}
				pages[page] = struct{}{}
			}
			continue
		}
		page, err := parsePositiveInt(part)
		if err != nil {
			return nil, fmt.Errorf("invalid page %q", part)
		}
		if page < 1 || page > pageCount {
			return nil, fmt.Errorf("page %d is out of range", page)
		}
		pages[page] = struct{}{}
	}
	out := make([]int, 0, len(pages))
	for page := range pages {
		out = append(out, page)
	}
	return out, nil
}

func parsePositiveInt(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, errors.New("empty number")
	}
	n := 0
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, errors.New("invalid number")
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

/* ---------------- file / streaming helpers ---------------- */

func cleanupMultipart(r *http.Request) {
	if r.MultipartForm != nil {
		_ = r.MultipartForm.RemoveAll()
	}
}

func saveFormFile(r *http.Request, field, dest string) (*multipart.FileHeader, error) {
	file, header, err := r.FormFile(field)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if err := writeReaderToFile(file, dest); err != nil {
		return nil, err
	}
	return header, nil
}

func saveMultipartFileHeader(fh *multipart.FileHeader, dest string) error {
	f, err := fh.Open()
	if err != nil {
		return err
	}
	defer f.Close()
	return writeReaderToFile(f, dest)
}

func writeReaderToFile(src io.Reader, dest string) error {
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return err
}

func writeReadCloserToFile(src io.ReadCloser, dest string) error {
	defer src.Close()
	return writeReaderToFile(src, dest)
}

// streamPDF sends the finished PDF to the client. The caller's deferred temp-dir
// cleanup runs after this returns, completing the read-and-burn cycle.
func streamPDF(w http.ResponseWriter, path, name string) {
	f, err := os.Open(path)
	if err != nil {
		writeInternalError(w, "open result", err)
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Content-Disposition", contentDisposition(name, false))
	if info, err := f.Stat(); err == nil {
		w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	}
	_, _ = io.Copy(w, f)
}
