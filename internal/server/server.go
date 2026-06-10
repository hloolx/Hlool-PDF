package server

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"math"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	pdfcore "hlool-pdf/internal/pdf"
	"hlool-pdf/internal/storage"
)

const maxPDFUploadSize = 200 << 20
const maxStampUploadSize = 20 << 20
const multipartMemory = 8 << 20
const defaultMaxJobBodySize = 4 << 20
const maxPlacementsPerJob = 1000
const maxSeamSealsPerJob = 20
const maxPagesPerSeamSeal = 500
const maxPasswordLength = 256
const maxPDFPages = 1000

type Options struct {
	AuthUsername      string
	AuthPassword      string
	CORSOrigins       []string
	MaxConcurrentJobs int
	MaxJobBodySize    int64
}

type Server struct {
	store    *storage.Store
	webFS    fs.FS
	options  Options
	jobSlots chan struct{}
}

type createJobRequest struct {
	FileID              string              `json:"fileId"`
	Placements          []pdfcore.Placement `json:"placements"`
	SeamSeals           []pdfcore.SeamSeal  `json:"seamSeals"`
	OutputPassword      string              `json:"outputPassword"`
	OutputOwnerPassword string              `json:"outputOwnerPassword"`
	OutputName          string              `json:"outputName"`
}

func New(store *storage.Store, webFS fs.FS, options Options) *Server {
	if options.MaxConcurrentJobs <= 0 {
		options.MaxConcurrentJobs = 2
	}
	if options.MaxJobBodySize <= 0 {
		options.MaxJobBodySize = defaultMaxJobBodySize
	}
	return &Server{
		store:    store,
		webFS:    webFS,
		options:  options,
		jobSlots: make(chan struct{}, options.MaxConcurrentJobs),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.health)
	mux.HandleFunc("/api/files", s.files)
	mux.HandleFunc("/api/files/compose", s.composeFiles)
	mux.HandleFunc("/api/files/", s.fileByID)
	mux.HandleFunc("/api/stamps", s.stamps)
	mux.HandleFunc("/api/stamps/", s.stampByID)
	mux.HandleFunc("/api/jobs", s.jobs)
	mux.HandleFunc("/api/jobs/", s.jobByID)
	mux.HandleFunc("/", s.web)
	return withCORS(withCSRFGuard(withBasicAuth(withSecurityHeaders(withLogging(mux)), s.options), s.options), s.options.CORSOrigins)
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) files(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, s.store.PDFs())
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	header, cleanup, err := uploadedFile(w, r, "file", maxPDFUploadSize)
	defer cleanup()
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if isPageImageName(header.Filename) {
		s.createFileFromImage(w, header)
		return
	}
	file, err := s.store.SavePDF(header)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	password := strings.TrimSpace(r.FormValue("password"))
	workingPath := file.Path
	if password != "" {
		plainPath := s.store.PDFWorkPath(file.ID, ".plain.pdf")
		if err := pdfcore.DecryptPDF(file.Path, plainPath, password); err != nil {
			s.store.RemovePDF(file.ID)
			if pdfcore.IsPasswordError(err) {
				writeCodedError(w, http.StatusBadRequest, "password_required", errors.New("PDF password is incorrect"))
				return
			}
			writeError(w, http.StatusBadRequest, err)
			return
		}
		s.store.SetPDFPath(file.ID, plainPath)
		workingPath = plainPath
	}
	pages, err := pdfcore.PageInfo(workingPath, "")
	if err != nil {
		s.store.RemovePDF(file.ID)
		if password == "" && pdfcore.IsPasswordError(err) {
			writeCodedError(w, http.StatusBadRequest, "password_required", errors.New("PDF password is required"))
			return
		}
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(pages) > maxPDFPages {
		s.store.RemovePDF(file.ID)
		writeError(w, http.StatusBadRequest, fmt.Errorf("PDF has too many pages; max is %d", maxPDFPages))
		return
	}
	s.store.SetPDFPages(file.ID, pages)
	file, _ = s.store.PDF(file.ID)
	writeJSON(w, http.StatusCreated, file)
}

// isPageImageName 判断上传文件是否是可作为页面导入的图片（WebP 由前端先转码为 PNG）。
func isPageImageName(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg":
		return true
	}
	return false
}

// createFileFromImage 把上传的图片转成单页 PDF 并登记为工作区文件（“图片作为页面”导入）。
func (s *Server) createFileFromImage(w http.ResponseWriter, header *multipart.FileHeader) {
	id, outPath := s.store.NewPDFPath()
	imgPath := s.store.PDFWorkPath(id, ".img"+strings.ToLower(filepath.Ext(header.Filename)))
	if err := storage.SaveUploadedFile(header, imgPath); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	defer os.Remove(imgPath)
	if err := pdfcore.ImageToPDF(imgPath, outPath); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	base := strings.TrimSuffix(filepath.Base(header.Filename), filepath.Ext(header.Filename))
	name := sanitizeOutputName(base)
	if name == "" {
		name = "图片文档.pdf"
	}
	file, err := s.store.RegisterPDF(id, name, outPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	pages, err := pdfcore.PageInfo(outPath, "")
	if err != nil {
		s.store.RemovePDF(id)
		writeError(w, http.StatusBadRequest, err)
		return
	}
	s.store.SetPDFPages(id, pages)
	file, _ = s.store.PDF(file.ID)
	writeJSON(w, http.StatusCreated, file)
}

const maxComposePages = 2000

type composePageRef struct {
	FileID     string `json:"fileId"`
	PageNumber int    `json:"pageNumber"`
}

type composeRequest struct {
	Name  string           `json:"name"`
	Pages []composePageRef `json:"pages"`
}

// composeFiles 处理页面整理 / 多文件拼接：按给定页序生成一个新 PDF 并登记为工作区文件。
func (s *Server) composeFiles(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.options.MaxJobBodySize)
	var req composeRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
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
	runs, err := s.buildComposeRuns(req.Pages)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	name := sanitizeOutputName(req.Name)
	if name == "" {
		name = "拼接文档.pdf"
	}

	id, outPath := s.store.NewPDFPath()
	if err := pdfcore.ComposePDF(outPath, runs); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	file, err := s.store.RegisterPDF(id, name, outPath)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	pages, err := pdfcore.PageInfo(outPath, "")
	if err != nil {
		s.store.RemovePDF(file.ID)
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(pages) > maxPDFPages {
		s.store.RemovePDF(file.ID)
		writeError(w, http.StatusBadRequest, fmt.Errorf("PDF has too many pages; max is %d", maxPDFPages))
		return
	}
	s.store.SetPDFPages(file.ID, pages)
	file, _ = s.store.PDF(file.ID)
	writeJSON(w, http.StatusCreated, file)
}

// buildComposeRuns 校验页引用并把连续来自同一文件的页合并成一段 run（保持顺序）。
func (s *Server) buildComposeRuns(pages []composePageRef) ([]pdfcore.ComposeRun, error) {
	var runs []pdfcore.ComposeRun
	lastFileID := ""
	for _, ref := range pages {
		file, ok := s.store.PDF(ref.FileID)
		if !ok {
			return nil, errors.New("PDF file not found")
		}
		if ref.PageNumber < 1 || ref.PageNumber > file.PageCount {
			return nil, fmt.Errorf("page %d is out of range", ref.PageNumber)
		}
		if ref.FileID != lastFileID || len(runs) == 0 {
			runs = append(runs, pdfcore.ComposeRun{Path: file.Path})
			lastFileID = ref.FileID
		}
		runs[len(runs)-1].Pages = append(runs[len(runs)-1].Pages, ref.PageNumber)
	}
	return runs, nil
}

func (s *Server) fileByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(r.URL.Path, "/api/files/")
	file, ok := s.store.PDF(id)
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("PDF file not found"))
		return
	}
	if rest == "" && r.Method == http.MethodDelete {
		s.store.RemovePDF(id)
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
		return
	}
	if rest == "" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, file)
		return
	}
	if rest == "content" && r.Method == http.MethodGet {
		http.ServeFile(w, r, file.Path)
		return
	}
	if rest == "rewrite" && r.Method == http.MethodPost {
		s.rewriteFile(w, r, file)
		return
	}
	methodNotAllowed(w)
}

type rewriteRequest struct {
	Pages []composePageRef `json:"pages"`
}

// rewriteFile 原地重写文件内容：按给定页序（可引用任意工作区文件）重新拼接，
// fileId 保持不变，前端按 fileId 保存的盖章配置因此得以延续。
// 用于“把新导入的 PDF / 图片并入当前文件”及其撤销（裁回原页数）。
func (s *Server) rewriteFile(w http.ResponseWriter, r *http.Request, file *storage.PDFFile) {
	r.Body = http.MaxBytesReader(w, r.Body, s.options.MaxJobBodySize)
	var req rewriteRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
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
	runs, err := s.buildComposeRuns(req.Pages)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	tmp := s.store.PDFWorkPath(file.ID, ".rewrite.tmp.pdf")
	defer os.Remove(tmp)
	if err := pdfcore.ComposePDF(tmp, runs); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	pages, err := pdfcore.PageInfo(tmp, "")
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if len(pages) > maxPDFPages {
		writeError(w, http.StatusBadRequest, fmt.Errorf("PDF has too many pages; max is %d", maxPDFPages))
		return
	}
	// 拼接读取源文件已经完成，把产物改名顶替到规范路径（同一文件 ID 的内容就地更新）。
	canonical := s.store.PDFWorkPath(file.ID, ".pdf")
	if err := os.Rename(tmp, canonical); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	oldPath := file.Path
	s.store.SetPDFPath(file.ID, canonical)
	if oldPath != "" && oldPath != canonical {
		_ = os.Remove(oldPath)
	}
	s.store.SetPDFPages(file.ID, pages)
	updated, _ := s.store.PDF(file.ID)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) stamps(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, s.store.Stamps())
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	header, cleanup, err := uploadedFile(w, r, "file", maxStampUploadSize)
	defer cleanup()
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	stamp, err := s.store.SaveStamp(header)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, http.StatusCreated, stamp)
}

func (s *Server) stampByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(r.URL.Path, "/api/stamps/")
	stamp, ok := s.store.Stamp(id)
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("stamp image not found"))
		return
	}
	if rest == "" && r.Method == http.MethodDelete {
		s.store.RemoveStamp(id)
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
		return
	}
	if rest == "" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, stamp)
		return
	}
	if rest == "image" && r.Method == http.MethodGet {
		http.ServeFile(w, r, stamp.Path)
		return
	}
	methodNotAllowed(w)
}

func (s *Server) jobs(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, s.store.Jobs())
		return
	}
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.options.MaxJobBodySize)
	var req createJobRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	file, ok := s.store.PDF(req.FileID)
	if !ok {
		writeError(w, http.StatusBadRequest, errors.New("PDF file not found"))
		return
	}
	if len(req.Placements) == 0 && len(req.SeamSeals) == 0 {
		writeError(w, http.StatusBadRequest, errors.New("at least one stamp or seam seal is required"))
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
	if err := s.validateJobRequest(req, file); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if !s.tryAcquireJobSlot() {
		writeError(w, http.StatusTooManyRequests, errors.New("too many PDF jobs are already running"))
		return
	}
	job := s.store.CreateJob(file.ID)
	if outputName := sanitizeOutputName(req.OutputName); outputName != "" {
		s.store.UpdateJob(job.ID, func(j *storage.Job) { j.OutputName = outputName })
		if updated, ok := s.store.Job(job.ID); ok {
			job = updated
		}
	}
	go s.runStampJob(job.ID, file, pdfcore.StampOptions{
		Placements:          req.Placements,
		SeamSeals:           req.SeamSeals,
		OutputPassword:      req.OutputPassword,
		OutputOwnerPassword: req.OutputOwnerPassword,
	})
	writeJSON(w, http.StatusCreated, job)
}

func (s *Server) jobByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(r.URL.Path, "/api/jobs/")
	job, ok := s.store.Job(id)
	if !ok {
		writeError(w, http.StatusNotFound, errors.New("job not found"))
		return
	}
	if rest == "" && r.Method == http.MethodDelete {
		s.store.RemoveJob(id)
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
		return
	}
	if rest == "" && r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, job)
		return
	}
	if rest == "download" && r.Method == http.MethodGet {
		if job.Status != "done" || job.ResultPath == "" {
			writeError(w, http.StatusBadRequest, errors.New("job result is not ready"))
			return
		}
		name := job.OutputName
		if name == "" {
			name = "hlool-pdf-" + job.ID + ".pdf"
		}
		inline := r.URL.Query().Get("inline") == "1"
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Content-Disposition", contentDisposition(name, inline))
		http.ServeFile(w, r, job.ResultPath)
		return
	}
	methodNotAllowed(w)
}

func (s *Server) runStampJob(jobID string, file *storage.PDFFile, options pdfcore.StampOptions) {
	defer s.releaseJobSlot()
	defer func() {
		if v := recover(); v != nil {
			s.failJob(jobID, fmt.Errorf("PDF job panicked: %v", v))
		}
	}()

	s.store.UpdateJob(jobID, func(job *storage.Job) {
		job.Status = "running"
		job.Progress = 10
	})
	stamps := map[string]pdfcore.StampAsset{}
	addStamp := func(stampID string) bool {
		if _, ok := stamps[stampID]; ok {
			return true
		}
		stamp, ok := s.store.Stamp(stampID)
		if !ok {
			s.failJob(jobID, fmt.Errorf("stamp %s not found", stampID))
			return false
		}
		stamps[stampID] = pdfcore.StampAsset{
			Path:     stamp.Path,
			WidthPx:  stamp.WidthPx,
			HeightPx: stamp.HeightPx,
		}
		return true
	}
	for _, placement := range options.Placements {
		if !addStamp(placement.StampID) {
			return
		}
	}
	for _, seam := range options.SeamSeals {
		if !addStamp(seam.StampID) {
			return
		}
	}
	s.store.UpdateJob(jobID, func(job *storage.Job) {
		job.Progress = 35
	})
	out := s.store.JobOutputPath(jobID)
	if err := pdfcore.StampPDF(file.Path, out, file.Pages, options, stamps); err != nil {
		s.failJob(jobID, err)
		return
	}
	s.store.UpdateJob(jobID, func(job *storage.Job) {
		job.Status = "done"
		job.Progress = 100
		job.ResultPath = out
		job.DownloadURL = "/api/jobs/" + jobID + "/download"
	})
}

func (s *Server) tryAcquireJobSlot() bool {
	select {
	case s.jobSlots <- struct{}{}:
		return true
	default:
		return false
	}
}

func (s *Server) releaseJobSlot() {
	select {
	case <-s.jobSlots:
	default:
	}
}

func (s *Server) failJob(jobID string, err error) {
	s.store.UpdateJob(jobID, func(job *storage.Job) {
		job.Status = "failed"
		job.Progress = 100
		job.Error = err.Error()
	})
}

func (s *Server) web(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeError(w, http.StatusNotFound, errors.New("API endpoint not found"))
		return
	}
	if s.webFS == nil {
		writeText(w, http.StatusOK, "hlool pdf API is running. Build the web UI to serve the app.")
		return
	}
	cleanPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if cleanPath == "" || cleanPath == "." {
		cleanPath = "index.html"
	}
	if fs.ValidPath(cleanPath) {
		if info, err := fs.Stat(s.webFS, cleanPath); err == nil && !info.IsDir() {
			serveFSFile(w, r, s.webFS, cleanPath)
			return
		}
	}
	if cleanPath != "index.html" && (strings.HasPrefix(cleanPath, "assets/") || path.Ext(cleanPath) != "") {
		writeError(w, http.StatusNotFound, errors.New("web asset not found"))
		return
	}
	if cleanPath != "index.html" && !acceptsHTML(r) {
		writeError(w, http.StatusNotFound, errors.New("web route not found"))
		return
	}
	serveFSFile(w, r, s.webFS, "index.html")
}

func acceptsHTML(r *http.Request) bool {
	accept := r.Header.Get("Accept")
	return accept == "" || strings.Contains(accept, "text/html") || strings.Contains(accept, "*/*")
}

func serveFSFile(w http.ResponseWriter, r *http.Request, webFS fs.FS, name string) {
	data, err := fs.ReadFile(webFS, name)
	if err != nil {
		writeError(w, http.StatusNotFound, errors.New("web asset not found"))
		return
	}
	if typ := mime.TypeByExtension(path.Ext(name)); typ != "" {
		w.Header().Set("Content-Type", typ)
	}
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(data))
}

func uploadedFile(w http.ResponseWriter, r *http.Request, field string, maxSize int64) (*multipart.FileHeader, func(), error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		return nil, func() {}, err
	}
	cleanup := func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}
	file, header, err := r.FormFile(field)
	if err != nil {
		cleanup()
		return nil, func() {}, err
	}
	_ = file.Close()
	return (*multipartFileHeader)(header), cleanup, nil
}

type multipartFileHeader = multipart.FileHeader

func splitIDPath(path, prefix string) (string, string) {
	rest := strings.TrimPrefix(path, prefix)
	parts := strings.SplitN(rest, "/", 2)
	id := parts[0]
	if len(parts) == 1 {
		return id, ""
	}
	return id, parts[1]
}

func methodNotAllowed(w http.ResponseWriter) {
	writeError(w, http.StatusMethodNotAllowed, errors.New("method not allowed"))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// writeCodedError 额外携带机器可读的 code，前端据此做交互（如按需弹出密码框）。
func writeCodedError(w http.ResponseWriter, status int, code string, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error(), "code": code})
}

const maxOutputNameRunes = 110

// sanitizeOutputName 清洗用户提供的下载文件名：
// 去除控制字符与路径分隔符，限制长度，并统一补上 .pdf 后缀。
// 清洗后为空则返回 ""，表示沿用默认文件名。
func sanitizeOutputName(name string) string {
	var b strings.Builder
	for _, r := range name {
		switch {
		case r < 0x20 || r == 0x7f:
		case strings.ContainsRune(`\/:*?"<>|`, r):
		default:
			b.WriteRune(r)
		}
	}
	cleaned := strings.TrimSpace(b.String())
	if lower := strings.ToLower(cleaned); strings.HasSuffix(lower, ".pdf") {
		cleaned = cleaned[:len(cleaned)-len(".pdf")]
	}
	cleaned = strings.Trim(cleaned, ". ")
	if runes := []rune(cleaned); len(runes) > maxOutputNameRunes {
		cleaned = string(runes[:maxOutputNameRunes])
	}
	if cleaned == "" {
		return ""
	}
	return cleaned + ".pdf"
}

// contentDisposition 同时给出 ASCII 兜底名与 RFC 5987 编码的 UTF-8 文件名（中文名可正确落盘）。
func contentDisposition(name string, inline bool) string {
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	fallback := make([]rune, 0, len(name))
	for _, r := range name {
		if r >= 0x20 && r < 0x7f && r != '"' && r != '\\' {
			fallback = append(fallback, r)
		} else {
			fallback = append(fallback, '_')
		}
	}
	return fmt.Sprintf("%s; filename=%q; filename*=UTF-8''%s", disposition, string(fallback), url.PathEscape(name))
}

func writeText(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(text))
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, redactedPath(r.URL.Path), time.Since(start).Round(time.Millisecond))
	})
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "private, no-store")
		}
		next.ServeHTTP(w, r)
	})
}

func withBasicAuth(next http.Handler, options Options) http.Handler {
	if options.AuthUsername == "" && options.AuthPassword == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		username, password, ok := r.BasicAuth()
		if !ok || subtle.ConstantTimeCompare([]byte(username), []byte(options.AuthUsername)) != 1 || subtle.ConstantTimeCompare([]byte(password), []byte(options.AuthPassword)) != 1 {
			w.Header().Set("WWW-Authenticate", `Basic realm="hlool pdf"`)
			writeError(w, http.StatusUnauthorized, errors.New("authentication required"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withCSRFGuard(next http.Handler, options Options) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		if !requestOriginAllowed(r, options.CORSOrigins) {
			writeError(w, http.StatusForbidden, errors.New("request origin is not allowed"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withCORS(next http.Handler, origins []string) http.Handler {
	allowedOrigins := map[string]struct{}{}
	allowAny := false
	for _, origin := range origins {
		origin = strings.TrimSpace(origin)
		if origin == "" {
			continue
		}
		if origin == "*" {
			allowAny = true
			continue
		}
		allowedOrigins[origin] = struct{}{}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowAny && origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", "*")
		} else if _, ok := allowedOrigins[origin]; ok {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		if origin != "" && (allowAny || headerHasValue(w.Header(), "Access-Control-Allow-Origin")) {
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func headerHasValue(header http.Header, key string) bool {
	return header.Get(key) != ""
}

func (s *Server) validateJobRequest(req createJobRequest, file *storage.PDFFile) error {
	if len(req.OutputPassword) > maxPasswordLength || len(req.OutputOwnerPassword) > maxPasswordLength {
		return fmt.Errorf("output password is too long")
	}
	if len(req.OutputName) > 512 {
		return fmt.Errorf("output name is too long")
	}
	pageByNumber := map[int]storage.PageInfo{}
	for _, page := range file.Pages {
		pageByNumber[page.PageNumber] = page
	}
	for _, placement := range req.Placements {
		page, ok := pageByNumber[placement.PageNumber]
		if !ok {
			return fmt.Errorf("page %d is out of range", placement.PageNumber)
		}
		if placement.StampID == "" {
			return fmt.Errorf("stamp id is required")
		}
		stamp, ok := s.store.Stamp(placement.StampID)
		if !ok {
			return fmt.Errorf("stamp %s not found", placement.StampID)
		}
		if !finiteAll(placement.XPt, placement.YPt, placement.WidthPt, placement.HeightPt, placement.Rotation, placement.Opacity) {
			return fmt.Errorf("stamp placement contains an invalid number")
		}
		if placement.WidthPt <= 0 || placement.HeightPt <= 0 {
			return fmt.Errorf("stamp width and height must be greater than zero")
		}
		if placement.WidthPt > page.WidthPt*2 || placement.HeightPt > page.HeightPt*2 {
			return fmt.Errorf("stamp on page %d is too large", placement.PageNumber)
		}
		expectedHeight := placement.WidthPt * float64(stamp.HeightPx) / float64(stamp.WidthPx)
		if math.Abs(expectedHeight-placement.HeightPt) > 2 {
			return fmt.Errorf("stamp height must match the image aspect ratio")
		}
		if placement.Rotation < -180 || placement.Rotation > 180 {
			return fmt.Errorf("stamp rotation must be between -180 and 180")
		}
		if placement.XPt < -page.WidthPt || placement.XPt > page.WidthPt*2 || placement.YPt < -page.HeightPt || placement.YPt > page.HeightPt*2 {
			return fmt.Errorf("stamp on page %d is outside the allowed coordinate range", placement.PageNumber)
		}
		if placement.Opacity < 0 || placement.Opacity > 1 {
			return fmt.Errorf("stamp opacity must be between 0 and 1")
		}
	}
	for _, seam := range req.SeamSeals {
		if seam.StampID == "" {
			return fmt.Errorf("stamp id is required")
		}
		if _, ok := s.store.Stamp(seam.StampID); !ok {
			return fmt.Errorf("stamp %s not found", seam.StampID)
		}
		if seam.Side != "" {
			switch strings.ToLower(strings.TrimSpace(seam.Side)) {
			case "left", "right", "top", "bottom":
			default:
				return fmt.Errorf("invalid seam seal side")
			}
		}
		if len(seam.Pages) > 128 {
			return fmt.Errorf("seam seal page expression is too long")
		}
		pages, err := parsePageScope(seam.Pages, file.PageCount)
		if err != nil {
			return err
		}
		if len(pages) < 2 {
			return fmt.Errorf("seam seal needs at least two pages")
		}
		if len(pages) > maxPagesPerSeamSeal {
			return fmt.Errorf("too many pages for one seam seal; max is %d", maxPagesPerSeamSeal)
		}
		if !finiteAll(seam.SizePt, seam.PositionPercent, seam.MarginPt, seam.Opacity) {
			return fmt.Errorf("seam seal contains an invalid number")
		}
		if seam.SizePt < 0 || seam.SizePt > 2000 {
			return fmt.Errorf("seam seal size is out of range")
		}
		if seam.PositionPercent < 0 || seam.PositionPercent > 100 {
			return fmt.Errorf("seam seal position must be between 0 and 100")
		}
		if seam.MarginPt < 0 || seam.MarginPt > 1000 {
			return fmt.Errorf("seam seal margin is out of range")
		}
		if seam.Opacity < 0 || seam.Opacity > 1 {
			return fmt.Errorf("seam seal opacity must be between 0 and 1")
		}
		if seam.MaxSlices < 0 || seam.MaxSlices > 500 {
			return fmt.Errorf("seam seal max slices is out of range")
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
		return 0, fmt.Errorf("empty number")
	}
	n := 0
	for _, r := range value {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("invalid number")
		}
		n = n*10 + int(r-'0')
	}
	return n, nil
}

func finiteAll(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

func requestOriginAllowed(r *http.Request, allowed []string) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		referer := strings.TrimSpace(r.Header.Get("Referer"))
		if referer == "" {
			return true
		}
		u, err := url.Parse(referer)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return false
		}
		origin = u.Scheme + "://" + u.Host
	}
	if sameRequestOrigin(r, origin) {
		return true
	}
	for _, item := range allowed {
		item = strings.TrimSpace(item)
		if item == origin {
			return true
		}
	}
	return false
}

func sameRequestOrigin(r *http.Request, origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded != "" {
		scheme = strings.Split(forwarded, ",")[0]
		scheme = strings.TrimSpace(scheme)
	}
	return strings.EqualFold(u.Scheme, scheme) && strings.EqualFold(u.Host, r.Host)
}

func redactedPath(value string) string {
	parts := strings.Split(value, "/")
	for i, part := range parts {
		for _, prefix := range []string{"pdf_", "stamp_", "job_"} {
			if strings.HasPrefix(part, prefix) && len(part) > len(prefix)+6 {
				parts[i] = prefix + part[len(prefix):len(prefix)+6] + "..."
			}
		}
	}
	return strings.Join(parts, "/")
}
