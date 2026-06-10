package storage

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"mime/multipart"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxStampPixels = 50_000_000

// 服务端自生成 id 为 24 hex，浏览器端 crypto.randomUUID 去横线为 32 hex。
var stampIDPattern = regexp.MustCompile(`^stamp_[0-9a-f]{24,64}$`)

type PageInfo struct {
	PageNumber int     `json:"pageNumber"`
	WidthPt    float64 `json:"widthPt"`
	HeightPt   float64 `json:"heightPt"`
	Rotation   int     `json:"rotation"`
}

type PDFFile struct {
	ID        string     `json:"fileId"`
	Name      string     `json:"name"`
	Path      string     `json:"-"`
	Size      int64      `json:"size"`
	PageCount int        `json:"pageCount"`
	Pages     []PageInfo `json:"pages"`
	CreatedAt time.Time  `json:"createdAt"`
}

type StampAsset struct {
	ID       string `json:"stampId"`
	Name     string `json:"name"`
	Path     string `json:"-"`
	URL      string `json:"url"`
	Size     int64  `json:"size"`
	WidthPx  int    `json:"widthPx"`
	HeightPx int    `json:"heightPx"`
	// SessionScoped 表示该印章已被浏览器端 IndexedDB 持久化认领，
	// 服务器只作为本次会话的工作缓存，下次启动可清；false = 旧版遗留
	// （legacy），在前端完成迁移认领前必须保留。
	SessionScoped bool      `json:"sessionScoped"`
	CreatedAt     time.Time `json:"createdAt"`
}

type Job struct {
	ID          string    `json:"jobId"`
	FileID      string    `json:"fileId"`
	Status      string    `json:"status"`
	Progress    int       `json:"progress"`
	Error       string    `json:"error,omitempty"`
	OutputName  string    `json:"outputName,omitempty"`
	ResultPath  string    `json:"-"`
	DownloadURL string    `json:"downloadUrl,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}

type Store struct {
	root   string
	pdfs   map[string]*PDFFile
	stamps map[string]*StampAsset
	jobs   map[string]*Job
	mu     sync.RWMutex
}

func New(root string) (*Store, error) {
	if root == "" {
		root = filepath.Join(os.TempDir(), "hlool-pdf")
	}
	if abs, err := filepath.Abs(root); err == nil {
		root = abs
	}
	for _, dir := range []string{"pdfs", "stamps", "jobs"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			return nil, err
		}
	}
	store := &Store{
		root:   root,
		pdfs:   map[string]*PDFFile{},
		stamps: map[string]*StampAsset{},
		jobs:   map[string]*Job{},
	}
	if err := store.loadManifest(); err != nil {
		return nil, err
	}
	store.wipeSession()
	store.mu.Lock()
	store.saveManifestLocked()
	store.mu.Unlock()
	return store, nil
}

// wipeSession 启动时清空会话数据：pdfs/、jobs/ 全清（含上次运行的各类临时
// 与孤儿文件）；stamps/ 只保留 legacy 印章（sessionScoped=false，等待前端
// 迁入浏览器 IndexedDB 后认领），其余连同孤儿文件一并删除。
func (s *Store) wipeSession() {
	s.mu.Lock()
	cleared := len(s.pdfs) + len(s.jobs)
	s.pdfs = map[string]*PDFFile{}
	s.jobs = map[string]*Job{}
	keep := map[string]struct{}{}
	for id, stamp := range s.stamps {
		if stamp.SessionScoped {
			delete(s.stamps, id)
			cleared++
			continue
		}
		keep[stamp.Path] = struct{}{}
	}
	s.mu.Unlock()

	sweepDir(filepath.Join(s.root, "pdfs"), nil)
	sweepDir(filepath.Join(s.root, "jobs"), nil)
	sweepDir(filepath.Join(s.root, "stamps"), keep)
	if cleared > 0 {
		log.Printf("previous session data cleared (%d records)", cleared)
	}
}

// sweepDir 删除 dir 下不在 keep 集合（与 keep 中路径同构造方式）里的所有普通文件。
func sweepDir(dir string, keep map[string]struct{}) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		if _, ok := keep[path]; ok {
			continue
		}
		_ = os.Remove(path)
	}
}

func (s *Store) Root() string {
	return s.root
}

func (s *Store) SavePDF(header *multipart.FileHeader) (*PDFFile, error) {
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".pdf" {
		return nil, errors.New("only PDF files are supported")
	}
	id := newID("pdf")
	path := filepath.Join(s.root, "pdfs", id+".pdf")
	if err := saveUploadedFile(header, path); err != nil {
		return nil, err
	}
	file := &PDFFile{
		ID:        id,
		Name:      filepath.Base(header.Filename),
		Path:      path,
		Size:      header.Size,
		CreatedAt: time.Now(),
	}
	s.mu.Lock()
	s.pdfs[id] = file
	s.mu.Unlock()
	return file, nil
}

// NewPDFPath 为即将生成的 PDF（如页面拼接产物）预分配 ID 与存储路径。
func (s *Store) NewPDFPath() (string, string) {
	id := newID("pdf")
	return id, filepath.Join(s.root, "pdfs", id+".pdf")
}

// RegisterPDF 把已写入 pdfs 目录的文件登记为新的 PDF 资产。
func (s *Store) RegisterPDF(id, name, path string) (*PDFFile, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	file := &PDFFile{
		ID:        id,
		Name:      name,
		Path:      path,
		Size:      info.Size(),
		CreatedAt: time.Now(),
	}
	s.mu.Lock()
	s.pdfs[id] = file
	s.mu.Unlock()
	return file, nil
}

func (s *Store) SetPDFPages(id string, pages []PageInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if file, ok := s.pdfs[id]; ok {
		file.Pages = pages
		file.PageCount = len(pages)
	}
}

func (s *Store) SetPDFPath(id, path string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if file, ok := s.pdfs[id]; ok {
		file.Path = path
		if info, err := os.Stat(path); err == nil {
			file.Size = info.Size()
		}
	}
}

func (s *Store) PDFWorkPath(id, suffix string) string {
	return filepath.Join(s.root, "pdfs", id+suffix)
}

func (s *Store) RemovePDF(id string) {
	s.mu.Lock()
	file, ok := s.pdfs[id]
	if ok {
		delete(s.pdfs, id)
	}
	s.mu.Unlock()

	paths := []string{
		filepath.Join(s.root, "pdfs", id+".pdf"),
		filepath.Join(s.root, "pdfs", id+".plain.pdf"),
	}
	if ok && file.Path != "" {
		paths = append(paths, file.Path)
	}
	for _, p := range uniquePaths(paths) {
		_ = os.Remove(p)
	}
}

func (s *Store) RemoveStamp(id string) {
	s.mu.Lock()
	stamp, ok := s.stamps[id]
	if ok {
		delete(s.stamps, id)
		s.saveManifestLocked()
	}
	s.mu.Unlock()
	if ok && stamp.Path != "" {
		_ = os.Remove(stamp.Path)
	}
}

// SaveStamp 保存上传的印章。clientID 非空时使用浏览器端生成的稳定 id：
// 同 id 已存在则幂等返回现有记录并认领（claim）为会话印章——这同时服务
// 重水化、升级迁移与多标签页并发三种场景。
func (s *Store) SaveStamp(header *multipart.FileHeader, clientID string) (*StampAsset, error) {
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".png" && ext != ".jpg" && ext != ".jpeg" {
		return nil, errors.New("only PNG and JPG stamp images are supported")
	}
	id := clientID
	if id == "" {
		id = newID("stamp")
	} else if !stampIDPattern.MatchString(id) {
		return nil, errors.New("invalid stamp id")
	}
	if existing := s.claimStamp(id); existing != nil {
		return existing, nil
	}
	final := filepath.Join(s.root, "stamps", id+ext)
	tmp := final + "." + newID("up") + ".tmp"
	if err := saveUploadedFile(header, tmp); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	width, height, format, err := imageSize(tmp)
	if err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	if (ext == ".png" && format != "png") || ((ext == ".jpg" || ext == ".jpeg") && format != "jpeg") {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("stamp file content does not match its extension")
	}
	if width <= 0 || height <= 0 || int64(width)*int64(height) > maxStampPixels {
		_ = os.Remove(tmp)
		return nil, fmt.Errorf("stamp image dimensions are too large")
	}
	stamp := &StampAsset{
		ID:            id,
		Name:          filepath.Base(header.Filename),
		Path:          final,
		URL:           "/api/stamps/" + id + "/image",
		Size:          header.Size,
		WidthPx:       width,
		HeightPx:      height,
		SessionScoped: true,
		CreatedAt:     time.Now(),
	}
	s.mu.Lock()
	if existing, ok := s.stamps[id]; ok {
		// 并发上传同 id 的竞速失败方：认领现有记录，丢弃本次上传体。
		existing.SessionScoped = true
		s.saveManifestLocked()
		copy := *existing
		s.mu.Unlock()
		_ = os.Remove(tmp)
		return &copy, nil
	}
	_ = os.Remove(final) // Windows 上 rename 不能覆盖同名残留
	if err := os.Rename(tmp, final); err != nil {
		s.mu.Unlock()
		_ = os.Remove(tmp)
		return nil, err
	}
	s.stamps[id] = stamp
	s.saveManifestLocked()
	s.mu.Unlock()
	copy := *stamp
	return &copy, nil
}

// claimStamp 把已存在的印章标记为会话级（浏览器端已持久化），幂等。
func (s *Store) claimStamp(id string) *StampAsset {
	s.mu.Lock()
	defer s.mu.Unlock()
	stamp, ok := s.stamps[id]
	if !ok {
		return nil
	}
	if !stamp.SessionScoped {
		stamp.SessionScoped = true
		s.saveManifestLocked()
	}
	copy := *stamp
	return &copy
}

func (s *Store) PDF(id string) (*PDFFile, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	f, ok := s.pdfs[id]
	if !ok {
		return nil, false
	}
	return clonePDF(f), true
}

func (s *Store) PDFs() []*PDFFile {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*PDFFile, 0, len(s.pdfs))
	for _, file := range s.pdfs {
		out = append(out, clonePDF(file))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out
}

func (s *Store) Stamp(id string) (*StampAsset, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	f, ok := s.stamps[id]
	if !ok {
		return nil, false
	}
	copy := *f
	return &copy, true
}

func (s *Store) Stamps() []*StampAsset {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*StampAsset, 0, len(s.stamps))
	for _, stamp := range s.stamps {
		copy := *stamp
		out = append(out, &copy)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out
}

func (s *Store) CreateJob(fileID string) *Job {
	now := time.Now()
	job := &Job{
		ID:        newID("job"),
		FileID:    fileID,
		Status:    "queued",
		Progress:  0,
		CreatedAt: now,
		UpdatedAt: now,
	}
	s.mu.Lock()
	s.jobs[job.ID] = job
	s.mu.Unlock()
	return cloneJob(job)
}

func (s *Store) Job(id string) (*Job, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	j, ok := s.jobs[id]
	if !ok {
		return nil, false
	}
	return cloneJob(j), true
}

func (s *Store) Jobs() []*Job {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Job, 0, len(s.jobs))
	for _, job := range s.jobs {
		out = append(out, cloneJob(job))
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out
}

func (s *Store) UpdateJob(id string, update func(*Job)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if job, ok := s.jobs[id]; ok {
		update(job)
		job.UpdatedAt = time.Now()
	}
}

func (s *Store) JobOutputPath(jobID string) string {
	return filepath.Join(s.root, "jobs", jobID+".pdf")
}

func (s *Store) RemoveJob(id string) {
	s.mu.Lock()
	job, ok := s.jobs[id]
	if ok {
		delete(s.jobs, id)
	}
	s.mu.Unlock()
	if ok && job.ResultPath != "" {
		_ = os.Remove(job.ResultPath)
	}
}

// SaveUploadedFile 把 multipart 上传体落盘到指定路径（供 server 层暂存待转换的图片等）。
func SaveUploadedFile(header *multipart.FileHeader, dest string) error {
	return saveUploadedFile(header, dest)
}

func saveUploadedFile(header *multipart.FileHeader, dest string) error {
	src, err := header.Open()
	if err != nil {
		return err
	}
	defer src.Close()

	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, src)
	return err
}

func imageSize(path string) (int, int, string, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, "", err
	}
	defer f.Close()
	cfg, format, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0, "", err
	}
	return cfg.Width, cfg.Height, format, nil
}

func newID(prefix string) string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return prefix + "_" + hex.EncodeToString([]byte(time.Now().Format("20060102150405.000000000")))
	}
	return prefix + "_" + hex.EncodeToString(b[:])
}

func clonePDF(file *PDFFile) *PDFFile {
	copy := *file
	if file.Pages != nil {
		copy.Pages = append([]PageInfo(nil), file.Pages...)
	}
	return &copy
}

func cloneJob(job *Job) *Job {
	copy := *job
	return &copy
}

func uniquePaths(paths []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		if p == "" {
			continue
		}
		key, err := filepath.Abs(p)
		if err != nil {
			key = p
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, p)
	}
	return out
}
