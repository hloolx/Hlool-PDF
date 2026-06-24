package pdf

import (
	"errors"
	"fmt"
	"image"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/pdfcpu/pdfcpu/pkg/api"
	pdfcpulib "github.com/pdfcpu/pdfcpu/pkg/pdfcpu"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/types"

	"hlool-pdf/internal/storage"
)

type Placement struct {
	StampID    string  `json:"stampId"`
	PageNumber int     `json:"pageNumber"`
	XPt        float64 `json:"xPt"`
	YPt        float64 `json:"yPt"`
	WidthPt    float64 `json:"widthPt"`
	HeightPt   float64 `json:"heightPt"`
	Rotation   float64 `json:"rotation"`
	Opacity    float64 `json:"opacity"`
}

type SeamSeal struct {
	StampID         string  `json:"stampId"`
	Pages           string  `json:"pages"`
	Side            string  `json:"side"`
	SizePt          float64 `json:"sizePt"`
	PositionPercent float64 `json:"positionPercent"`
	MarginPt        float64 `json:"marginPt"`
	Opacity         float64 `json:"opacity"`
	MaxSlices       int     `json:"maxSlices"`
	// RandomSeed 非 0 时启用确定性随机分割：前端用同一算法做所见即所得预览。
	RandomSeed uint32 `json:"randomSeed"`
}

type StampOptions struct {
	Placements          []Placement `json:"placements"`
	SeamSeals           []SeamSeal  `json:"seamSeals"`
	OutputPassword      string      `json:"outputPassword"`
	OutputOwnerPassword string      `json:"outputOwnerPassword"`
}

type StampAsset struct {
	Path     string
	WidthPx  int
	HeightPx int
}

func PageInfo(path, password string) ([]storage.PageInfo, error) {
	conf := readConf(password)
	if err := api.ValidateFile(path, conf); err != nil {
		return nil, err
	}
	dims, err := pageDimsFile(path, conf)
	if err != nil {
		return nil, err
	}
	pages := make([]storage.PageInfo, 0, len(dims))
	for i, dim := range dims {
		pages = append(pages, storage.PageInfo{
			PageNumber: i + 1,
			WidthPt:    dim.Width,
			HeightPt:   dim.Height,
			Rotation:   0,
		})
	}
	return pages, nil
}

// IsPasswordError 判断 pdfcpu 的报错是否属于“缺少或错误的打开密码”。
func IsPasswordError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, pdfcpulib.ErrWrongPassword) {
		return true
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "password") || strings.Contains(msg, "encrypted")
}

func DecryptPDF(inputPath, outputPath, password string) error {
	if password == "" {
		return fmt.Errorf("password is required")
	}
	return api.DecryptFile(inputPath, outputPath, readConf(password))
}

// wmItem is one resolved watermark bound to a page, carrying its opacity so the
// pipeline can batch watermarks that share an opacity into a single pass.
type wmItem struct {
	page    int
	wm      *model.Watermark
	opacity float64
}

func StampPDF(inputPath, outputPath string, pages []storage.PageInfo, options StampOptions, stamps map[string]StampAsset) error {
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}

	workOutput := outputPath
	if options.OutputPassword != "" {
		workOutput = outputPath + ".plain.tmp"
		defer os.Remove(workOutput)
	}

	// Resolve every placement and seam-seal slice into one flat, ordered list of
	// page-bound watermarks. Order is preserved (placements first, then seals) so
	// the visual stacking matches the historical per-step pipeline.
	var (
		items    []wmItem
		cleanups []func()
	)
	defer func() {
		for _, c := range cleanups {
			c()
		}
	}()

	for _, placement := range options.Placements {
		wm, opacity, err := buildPlacementWatermark(placement, stamps)
		if err != nil {
			return err
		}
		items = append(items, wmItem{page: placement.PageNumber, wm: wm, opacity: opacity})
	}
	for _, seal := range options.SeamSeals {
		sealItems, cleanup, err := buildSeamWatermarks(pages, seal, stamps)
		if cleanup != nil {
			cleanups = append(cleanups, cleanup)
		}
		if err != nil {
			return err
		}
		items = append(items, sealItems...)
	}

	if len(items) == 0 {
		// 没有任何盖章步骤：把源 PDF 直通拷贝为产物（仍支持改名/加密）。
		if err := copyFile(inputPath, workOutput); err != nil {
			return err
		}
	} else if err := applyWatermarks(inputPath, workOutput, items); err != nil {
		return err
	}

	if options.OutputPassword != "" {
		owner := options.OutputOwnerPassword
		if owner == "" {
			owner = options.OutputPassword
		}
		conf := model.NewAESConfiguration(options.OutputPassword, owner, 256)
		conf.Permissions = model.PermissionsAll
		if err := api.EncryptFile(workOutput, outputPath, conf); err != nil {
			return err
		}
	}
	return nil
}

// applyWatermarks stamps every watermark in items onto the PDF. pdfcpu's
// slice-map applies a single shared opacity per pass, so items are split into
// runs of equal (adjacent) opacity and each run is stamped in one read-write
// pass. In the common case (everything fully opaque) that is exactly one pass
// for the whole job, replacing the old one-pass-per-stamp pipeline.
func applyWatermarks(inputPath, outputPath string, items []wmItem) error {
	batches := batchByOpacity(items)
	current := inputPath
	tmpFiles := make([]string, 0, len(batches))
	defer func() {
		for _, p := range tmpFiles {
			_ = os.Remove(p)
		}
	}()
	for i, batch := range batches {
		m := make(map[int][]*model.Watermark, len(batch))
		for _, it := range batch {
			m[it.page] = append(m[it.page], it.wm)
		}
		dest := outputPath
		if i < len(batches)-1 {
			dest = outputPath + fmt.Sprintf(".%02d.tmp", i)
			tmpFiles = append(tmpFiles, dest)
		}
		if err := api.AddWatermarksSliceMapFile(current, dest, m, model.NewDefaultConfiguration()); err != nil {
			return err
		}
		current = dest
	}
	return nil
}

// batchByOpacity groups consecutive items that share an opacity. Splitting only
// on change (rather than gathering all equal opacities) preserves exact
// front-to-back order, which matters when stamps of different opacity overlap.
func batchByOpacity(items []wmItem) [][]wmItem {
	var batches [][]wmItem
	for _, it := range items {
		if n := len(batches); n > 0 && batches[n-1][0].opacity == it.opacity {
			batches[n-1] = append(batches[n-1], it)
			continue
		}
		batches = append(batches, []wmItem{it})
	}
	return batches
}

// copyFile 原样复制文件内容（无章导出 / 直通的产物落盘）。
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// buildPlacementWatermark resolves one placement into a page-bound watermark.
// It performs no PDF I/O — the watermark is applied later in a batched pass.
func buildPlacementWatermark(placement Placement, stamps map[string]StampAsset) (*model.Watermark, float64, error) {
	stamp, ok := stamps[placement.StampID]
	if !ok {
		return nil, 0, fmt.Errorf("stamp %q not found", placement.StampID)
	}
	if placement.PageNumber < 1 {
		return nil, 0, fmt.Errorf("invalid page number %d", placement.PageNumber)
	}
	if placement.WidthPt <= 0 {
		return nil, 0, fmt.Errorf("stamp width must be greater than zero")
	}
	opacity := normalizedOpacity(placement.Opacity)
	scale := placement.WidthPt / float64(stamp.WidthPx)
	if scale <= 0 || math.IsNaN(scale) || math.IsInf(scale, 0) {
		return nil, 0, fmt.Errorf("invalid stamp scale")
	}
	desc := watermarkDesc(placement.XPt, placement.YPt, scale, placement.Rotation, opacity)
	wm, err := api.ImageWatermark(stamp.Path, desc, true, false, types.POINTS)
	if err != nil {
		return nil, 0, err
	}
	return wm, opacity, nil
}

// buildSeamWatermarks resolves one seam seal (骑缝章) into its per-page watermark
// slices. It returns a cleanup that removes the temporary sliced-image files;
// the caller must invoke it only after the watermarks have been applied.
func buildSeamWatermarks(pages []storage.PageInfo, seal SeamSeal, stamps map[string]StampAsset) ([]wmItem, func(), error) {
	stamp, ok := stamps[seal.StampID]
	if !ok {
		return nil, nil, fmt.Errorf("stamp %q not found", seal.StampID)
	}
	selected, err := selectedPages(seal.Pages, len(pages))
	if err != nil {
		return nil, nil, err
	}
	if len(selected) < 2 {
		return nil, nil, fmt.Errorf("seam seal needs at least two pages")
	}
	maxSlices := seal.MaxSlices
	if maxSlices <= 0 {
		maxSlices = 20
	}
	if seal.SizePt <= 0 {
		seal.SizePt = 120
	}
	seal.Side = strings.ToLower(strings.TrimSpace(seal.Side))
	switch seal.Side {
	case "left", "right", "top", "bottom":
	default:
		seal.Side = "right"
	}
	if seal.PositionPercent < 0 || seal.PositionPercent > 100 {
		seal.PositionPercent = 50
	}
	opacity := normalizedOpacity(seal.Opacity)

	pieces, cleanup, err := buildSeamPieces(stamp.Path, selected, maxSlices, seal.Side, seal.RandomSeed)
	if err != nil {
		return nil, nil, err
	}

	items := make([]wmItem, 0, len(selected))
	for i, pageNo := range selected {
		if pageNo < 1 || pageNo > len(pages) {
			return nil, cleanup, fmt.Errorf("page %d is out of range", pageNo)
		}
		page := pages[pageNo-1]
		piece := pieces[i]
		x, y, scale := seamPlacement(page, piece, seal)
		desc := watermarkDesc(x, y, scale, 0, opacity)
		wm, err := api.ImageWatermark(piece.Path, desc, true, false, types.POINTS)
		if err != nil {
			return nil, cleanup, err
		}
		items = append(items, wmItem{page: pageNo, wm: wm, opacity: opacity})
	}
	return items, cleanup, nil
}

type seamPiece struct {
	Path     string
	WidthPx  int
	HeightPx int
}

// mulberry32 是与前端逐位一致的种子伪随机数发生器（uint32 回绕运算）。
func mulberry32(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6D2B79F5
		t := a
		t = (t ^ (t >> 15)) * (t | 1)
		t = (t + (t^(t>>7))*(t|61)) ^ t
		return float64(t^(t>>14)) / 4294967296.0
	}
}

// sliceBoundaries 计算一组切片的边界（0..axisPixels 共 groupSize+1 个）。
// rng 为 nil 时为均匀等分（与历史行为一致）；否则在等分点附近做受限抖动，
// 并保证每片宽度不小于段宽的 30%。前端 web/src/features/seam/slices.ts 为同一实现。
func sliceBoundaries(axisPixels, groupSize int, rng func() float64) []int {
	out := make([]int, groupSize+1)
	if rng == nil || groupSize <= 1 {
		for i := 0; i <= groupSize; i++ {
			out[i] = axisPixels * i / groupSize
		}
		return out
	}
	segment := float64(axisPixels) / float64(groupSize)
	minWidth := math.Max(2, segment*0.3)
	prev := 0.0
	for i := 1; i < groupSize; i++ {
		even := float64(axisPixels) * float64(i) / float64(groupSize)
		jitter := (rng()*2 - 1) * segment * 0.35
		raw := even + jitter
		lo := prev + minWidth
		hi := float64(axisPixels) - float64(groupSize-i)*minWidth
		if raw < lo {
			raw = lo
		}
		if raw > hi {
			raw = hi
		}
		out[i] = int(math.Floor(raw))
		prev = raw
	}
	out[0] = 0
	out[groupSize] = axisPixels
	return out
}

func buildSeamPieces(imagePath string, pages []int, maxSlices int, side string, randomSeed uint32) ([]seamPiece, func(), error) {
	src, err := loadRGBA(imagePath)
	if err != nil {
		return nil, func() {}, err
	}
	bounds := src.Bounds()
	pageCount := len(pages)
	pieces := make([]seamPiece, pageCount)
	axisPixels := bounds.Dx()
	if side == "top" || side == "bottom" {
		axisPixels = bounds.Dy()
	}
	if axisPixels < 1 {
		return nil, func() {}, fmt.Errorf("stamp image is empty")
	}
	if maxSlices > axisPixels {
		maxSlices = axisPixels
	}
	tmpDir, err := os.MkdirTemp("", "hlool-seam-*")
	if err != nil {
		return nil, func() {}, err
	}
	cleanup := func() { _ = os.RemoveAll(tmpDir) }

	var rng func() float64
	if randomSeed != 0 {
		rng = mulberry32(randomSeed)
	}
	groupStart := 0
	for groupStart < pageCount {
		groupEnd := groupStart + maxSlices
		if groupEnd > pageCount {
			groupEnd = pageCount
		}
		groupSize := groupEnd - groupStart
		cuts := sliceBoundaries(axisPixels, groupSize, rng)
		for i := 0; i < groupSize; i++ {
			var crop image.Rectangle
			if side == "top" || side == "bottom" {
				crop = image.Rect(bounds.Min.X, bounds.Min.Y+cuts[i], bounds.Max.X, bounds.Min.Y+cuts[i+1])
			} else {
				crop = image.Rect(bounds.Min.X+cuts[i], bounds.Min.Y, bounds.Min.X+cuts[i+1], bounds.Max.Y)
			}
			if crop.Dx() < 1 || crop.Dy() < 1 {
				crop = crop.Union(image.Rect(crop.Min.X, crop.Min.Y, crop.Min.X+1, crop.Min.Y+1))
			}
			out := image.NewRGBA(image.Rect(0, 0, crop.Dx(), crop.Dy()))
			draw.Draw(out, out.Bounds(), src, crop.Min, draw.Src)
			path := filepath.Join(tmpDir, fmt.Sprintf("piece_%04d.png", groupStart+i))
			if err := savePNG(path, out); err != nil {
				cleanup()
				return nil, func() {}, err
			}
			pieces[groupStart+i] = seamPiece{Path: path, WidthPx: out.Bounds().Dx(), HeightPx: out.Bounds().Dy()}
		}
		groupStart = groupEnd
	}
	return pieces, cleanup, nil
}

// A4 页面尺寸（pt），图片导入为页面时统一使用。
const (
	A4WidthPt  = 595.27
	A4HeightPt = 841.89
)

// ImageToPDF 把单张图片转为一页 PDF：页面固定为 A4（横图横向、竖图竖向），
// 图片等比缩放到页面内并居中，不裁切、不变形。
func ImageToPDF(imagePath, outputPath string) error {
	f, err := os.Open(imagePath)
	if err != nil {
		return err
	}
	cfg, _, err := image.DecodeConfig(f)
	_ = f.Close()
	if err != nil {
		return fmt.Errorf("unsupported image: %w", err)
	}
	if cfg.Width < 1 || cfg.Height < 1 || int64(cfg.Width)*int64(cfg.Height) > 80_000_000 {
		return fmt.Errorf("image dimensions are out of range")
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	pageW, pageH := A4WidthPt, A4HeightPt
	if cfg.Width > cfg.Height {
		pageW, pageH = A4HeightPt, A4WidthPt
	}
	imp := pdfcpulib.DefaultImportConfig()
	imp.PageDim = &types.Dim{Width: pageW, Height: pageH}
	imp.PageSize = ""
	imp.UserDim = true
	// 默认 pos:full 会让页面尺寸跟随图片；居中锚点 + 相对缩放 1 才是“等比充满 A4 并居中”。
	imp.Pos = types.Center
	imp.Scale = 1
	imp.ScaleAbs = false
	return api.ImportImagesFile([]string{imagePath}, outputPath, imp, model.NewDefaultConfiguration())
}

// ComposeRun 表示拼接序列中来自同一文件的一段连续页（保持给定顺序，可重复）。
type ComposeRun struct {
	Path  string
	Pages []int
}

// ComposePDF 把多个来源的页面按给定顺序拼成一个新 PDF（页面整理 / 多文件合并）。
func ComposePDF(outputPath string, runs []ComposeRun) error {
	if len(runs) == 0 {
		return fmt.Errorf("at least one page is required")
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o755); err != nil {
		return err
	}
	conf := model.NewDefaultConfiguration()
	tmpDir, err := os.MkdirTemp("", "hlool-compose-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(tmpDir) }()

	parts := make([]string, 0, len(runs))
	for i, run := range runs {
		if len(run.Pages) == 0 {
			continue
		}
		selection := make([]string, len(run.Pages))
		for j, page := range run.Pages {
			selection[j] = strconv.Itoa(page)
		}
		dest := filepath.Join(tmpDir, fmt.Sprintf("part_%04d.pdf", i))
		if len(runs) == 1 {
			dest = outputPath
		}
		if err := api.CollectFile(run.Path, dest, selection, conf); err != nil {
			return err
		}
		parts = append(parts, dest)
	}
	if len(runs) == 1 {
		return nil
	}
	return api.MergeCreateFile(parts, outputPath, false, model.NewDefaultConfiguration())
}

func seamPlacement(page storage.PageInfo, piece seamPiece, seal SeamSeal) (x, y, scale float64) {
	if seal.Side == "top" || seal.Side == "bottom" {
		widthPt := seal.SizePt
		heightPt := widthPt * float64(piece.HeightPx) / float64(piece.WidthPx)
		x = (page.WidthPt - widthPt) * seal.PositionPercent / 100
		if seal.Side == "top" {
			y = page.HeightPt - heightPt - seal.MarginPt
		} else {
			y = seal.MarginPt
		}
		return x, y, widthPt / float64(piece.WidthPx)
	}
	heightPt := seal.SizePt
	widthPt := heightPt * float64(piece.WidthPx) / float64(piece.HeightPx)
	if seal.Side == "left" {
		x = seal.MarginPt
	} else {
		x = page.WidthPt - widthPt - seal.MarginPt
	}
	y = (page.HeightPt - heightPt) * (100 - seal.PositionPercent) / 100
	return x, y, widthPt / float64(piece.WidthPx)
}

func selectedPages(expr string, pageCount int) ([]int, error) {
	expr = strings.TrimSpace(expr)
	if expr == "" || strings.EqualFold(expr, "all") {
		expr = "1-" + fmt.Sprint(pageCount)
	}
	selection, err := api.ParsePageSelection(expr)
	if err != nil {
		return nil, err
	}
	set, err := api.PagesForPageSelection(pageCount, selection, true, false)
	if err != nil {
		return nil, err
	}
	pages := make([]int, 0, len(set))
	for page := range set {
		pages = append(pages, page)
	}
	sort.Ints(pages)
	return pages, nil
}

func pageDimsFile(path string, conf *model.Configuration) ([]types.Dim, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return api.PageDims(f, conf)
}

func readConf(password string) *model.Configuration {
	conf := model.NewDefaultConfiguration()
	if password != "" {
		conf.UserPW = password
		conf.OwnerPW = password
	}
	return conf
}

func normalizedOpacity(opacity float64) float64 {
	if opacity <= 0 || opacity > 1 {
		return 1
	}
	return opacity
}

func watermarkDesc(x, y, scale, rotation, opacity float64) string {
	return fmt.Sprintf("pos:bl, off:%0.3f %0.3f, scale:%0.6f abs, rot:%0.3f, op:%0.3f", x, y, scale, rotation, opacity)
}

func loadRGBA(path string) (*image.RGBA, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return nil, err
	}
	b := img.Bounds()
	out := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Bounds(), img, b.Min, draw.Src)
	return out, nil
}

func savePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}
