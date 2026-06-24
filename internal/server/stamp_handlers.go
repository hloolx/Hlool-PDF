package server

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"hlool-pdf/internal/library"
)

// stampIDPattern matches both server-generated ids and browser-generated ones
// (crypto.randomUUID with dashes removed -> 32 hex).
var stampIDPattern = regexp.MustCompile(`^stamp_[0-9a-f]{24,64}$`)

type stampView struct {
	StampID   string    `json:"stampId"`
	Name      string    `json:"name"`
	URL       string    `json:"url"`
	Mime      string    `json:"mime"`
	WidthPx   int       `json:"widthPx"`
	HeightPx  int       `json:"heightPx"`
	CreatedAt time.Time `json:"createdAt"`
}

func toStampView(m library.StampMeta) stampView {
	return stampView{
		StampID:   m.ID,
		Name:      m.Name,
		URL:       "/api/stamps/" + m.ID + "/content",
		Mime:      m.Mime,
		WidthPx:   m.WidthPx,
		HeightPx:  m.HeightPx,
		CreatedAt: m.CreatedAt,
	}
}

func (s *Server) stamps(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		metas, err := s.lib.ListStamps(r.Context(), uid(r))
		if err != nil {
			writeInternalError(w, "list stamps", err)
			return
		}
		views := make([]stampView, 0, len(metas))
		for _, m := range metas {
			views = append(views, toStampView(m))
		}
		writeJSON(w, http.StatusOK, views)
	case http.MethodPost:
		s.uploadStamp(w, r)
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) uploadStamp(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, s.opts.MaxStampBytes)
	if err := r.ParseMultipartForm(multipartMemory); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid upload"))
		return
	}
	defer func() {
		if r.MultipartForm != nil {
			_ = r.MultipartForm.RemoveAll()
		}
	}()
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("a stamp image file is required"))
		return
	}
	data, err := io.ReadAll(file)
	_ = file.Close()
	if err != nil {
		writeError(w, http.StatusBadRequest, errors.New("could not read the uploaded file"))
		return
	}
	widthPx, heightPx, mimeType, err := validateStampImage(data)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	id := strings.TrimSpace(r.FormValue("stampId"))
	if id == "" {
		id = newStampID()
	} else if !stampIDPattern.MatchString(id) {
		writeError(w, http.StatusBadRequest, errors.New("invalid stamp id"))
		return
	}
	name := sanitizeStampName(r.FormValue("name"))
	if name == "" {
		name = sanitizeStampName(header.Filename)
	}
	if name == "" {
		name = "印章"
	}

	meta := library.StampMeta{
		ID:        id,
		Name:      name,
		Mime:      mimeType,
		Size:      int64(len(data)),
		WidthPx:   widthPx,
		HeightPx:  heightPx,
		CreatedAt: time.Now().UTC(),
	}
	if err := s.lib.PutStamp(r.Context(), uid(r), meta, data); err != nil {
		writeInternalError(w, "put stamp", err)
		return
	}
	writeJSON(w, http.StatusCreated, toStampView(meta))
}

func (s *Server) stampByID(w http.ResponseWriter, r *http.Request) {
	id, rest := splitIDPath(r.URL.Path, "/api/stamps/")
	if !stampIDPattern.MatchString(id) {
		writeError(w, http.StatusNotFound, errors.New("stamp not found"))
		return
	}
	switch {
	case rest == "content" && r.Method == http.MethodGet:
		s.streamStamp(w, r, id)
	case rest == "" && r.Method == http.MethodGet:
		meta, err := s.lib.StampMeta(r.Context(), uid(r), id)
		if s.handleStampErr(w, "stamp meta", err) {
			return
		}
		writeJSON(w, http.StatusOK, toStampView(meta))
	case rest == "" && r.Method == http.MethodPatch:
		s.renameStamp(w, r, id)
	case rest == "" && r.Method == http.MethodDelete:
		if err := s.lib.DeleteStamp(r.Context(), uid(r), id); err != nil {
			writeInternalError(w, "delete stamp", err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
	default:
		methodNotAllowed(w)
	}
}

func (s *Server) streamStamp(w http.ResponseWriter, r *http.Request, id string) {
	meta, rc, err := s.lib.GetStamp(r.Context(), uid(r), id)
	if s.handleStampErr(w, "get stamp", err) {
		return
	}
	defer rc.Close()
	if meta.Mime != "" {
		w.Header().Set("Content-Type", meta.Mime)
	}
	_, _ = io.Copy(w, rc)
}

func (s *Server) renameStamp(w http.ResponseWriter, r *http.Request, id string) {
	var body struct {
		Name string `json:"name"`
	}
	if err := readJSON(w, r, &body, maxAuthBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	name := sanitizeStampName(body.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, errors.New("name is required"))
		return
	}
	meta, err := s.lib.SetStampName(r.Context(), uid(r), id, name)
	if s.handleStampErr(w, "rename stamp", err) {
		return
	}
	writeJSON(w, http.StatusOK, toStampView(meta))
}

// handleStampErr writes the right status for a library stamp error and reports
// whether the request has been handled.
func (s *Server) handleStampErr(w http.ResponseWriter, op string, err error) bool {
	switch {
	case err == nil:
		return false
	case errors.Is(err, library.ErrStampNotFound):
		writeError(w, http.StatusNotFound, errors.New("stamp not found"))
	default:
		writeInternalError(w, op, err)
	}
	return true
}

func validateStampImage(data []byte) (width, height int, mimeType string, err error) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return 0, 0, "", errors.New("unsupported image; only PNG and JPG are allowed")
	}
	switch format {
	case "png":
		mimeType = "image/png"
	case "jpeg":
		mimeType = "image/jpeg"
	default:
		return 0, 0, "", errors.New("only PNG and JPG stamp images are supported")
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxStampPixels {
		return 0, 0, "", errors.New("stamp image dimensions are too large")
	}
	return cfg.Width, cfg.Height, mimeType, nil
}

func sanitizeStampName(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	cleaned := strings.TrimSpace(b.String())
	if runes := []rune(cleaned); len(runes) > 200 {
		cleaned = string(runes[:200])
	}
	return cleaned
}

func newStampID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return "stamp_" + hex.EncodeToString(b[:])
}
