// Package server hosts the hlool-pdf HTTP API and static web UI. PDFs are never
// persisted: /api/process, /api/compose and /api/image-to-pdf work in a
// per-request temp directory and stream the result back (read-and-burn). The
// per-user library (stamps + settings) lives behind library.Store, and every
// /api and library path is derived from the authenticated session's uid.
package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"math"
	"mime"
	"net/http"
	"net/url"
	"path"
	"runtime"
	"strings"
	"time"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/library"
)

const (
	multipartMemory     = 8 << 20
	maxStampPixels      = 50_000_000
	maxPlacementsPerJob = 1000
	maxSeamSealsPerJob  = 20
	maxPagesPerSeamSeal = 500
	maxPasswordLength   = 256
	maxPDFPages         = 1000
	maxComposePages     = 2000
	maxComposeFiles     = 200
	maxOutputNameRunes  = 110
)

// Options carries the HTTP-layer settings derived from the runtime config.
type Options struct {
	CORSOrigins         []string
	AllowedHosts        []string
	BehindProxy         bool
	HSTS                bool
	AllowGuest          bool // legacy server-test shorthand; mapped into AuthDefaults when AuthDefaultsSet is false.
	AuthDefaults        auth.AuthSettings
	AuthDefaultsSet     bool
	MaxProcessBodyBytes int64
	MaxStampBytes       int64
	MaxConcurrentJobs   int
}

// Server bundles the auth service, the pluggable library backend and the web UI.
type Server struct {
	auth         *auth.Service
	lib          library.Store
	webFS        fs.FS
	opts         Options
	jobSem       chan struct{} // bounds concurrent heavy PDF jobs (see limitJobs)
	jobQueueWait time.Duration // how long a heavy request waits for a slot before 503
}

// New builds a Server.
func New(authSvc *auth.Service, lib library.Store, webFS fs.FS, opts Options) *Server {
	if opts.MaxProcessBodyBytes <= 0 {
		opts.MaxProcessBodyBytes = 220 << 20
	}
	if opts.MaxStampBytes <= 0 {
		opts.MaxStampBytes = 20 << 20
	}
	if opts.MaxConcurrentJobs <= 0 {
		opts.MaxConcurrentJobs = runtime.GOMAXPROCS(0)
	}
	// Preserve the old zero-value server behavior: password registration is open
	// unless explicitly disabled by config/admin settings, while guest access
	// stays off for tests that construct Options{} directly.
	if !opts.AuthDefaultsSet {
		opts.AuthDefaults.RegisterEnabled = true
		opts.AuthDefaults.ThirdPartyRegisterEnabled = true
		opts.AuthDefaults.GuestEnabled = opts.AllowGuest
	}
	return &Server{
		auth:         authSvc,
		lib:          lib,
		webFS:        webFS,
		opts:         opts,
		jobSem:       make(chan struct{}, opts.MaxConcurrentJobs),
		jobQueueWait: 10 * time.Second,
	}
}

// Handler returns the fully-wrapped HTTP handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", s.health)

	mux.HandleFunc("/auth/register", s.register)
	mux.HandleFunc("/auth/login", s.login)
	mux.HandleFunc("/auth/logout", s.logout)
	mux.HandleFunc("/auth/guest", s.guest)
	mux.HandleFunc("/auth/me", s.me)
	mux.HandleFunc("/auth/config", s.authConfig)

	mux.Handle("/api/stamps", s.protected(s.stamps))
	mux.Handle("/api/stamps/", s.protected(s.stampByID))
	mux.Handle("/api/settings", s.protected(s.settings))
	mux.Handle("/api/admin/settings", s.adminOnly(s.adminSettings))
	mux.Handle("/api/admin/invites", s.adminOnly(s.adminInvites))
	mux.Handle("/api/admin/invites/", s.adminOnly(s.adminInviteByID))
	mux.Handle("/api/process", s.protected(s.limitJobs(s.process)))
	mux.Handle("/api/compose", s.protected(s.limitJobs(s.compose)))
	mux.Handle("/api/image-to-pdf", s.protected(s.limitJobs(s.imageToPDF)))

	mux.HandleFunc("/", s.web)

	return withRecover(
		withLogging(
			withHostGuard(s.opts.AllowedHosts,
				withCORS(s.opts.CORSOrigins,
					withSecurityHeaders(s.opts.HSTS,
						withCSRFGuard(s.opts.CORSOrigins, s.opts.BehindProxy, mux))))))
}

// protected wraps an API handler with session authentication.
func (s *Server) protected(h http.HandlerFunc) http.Handler {
	return s.auth.RequireAuth(h)
}

func (s *Server) adminOnly(h http.HandlerFunc) http.Handler {
	return s.auth.RequireAdmin(h)
}

func (s *Server) authSettings(r *http.Request) (auth.AuthSettings, error) {
	return s.auth.AuthSettings(r.Context(), s.opts.AuthDefaults)
}

// jobQueueWait is how long a heavy request will wait for a free job slot before
// giving up with 503. Short, so clients fail fast instead of piling up.
// limitJobs caps concurrency on the CPU/memory-heavy PDF endpoints. A request
// grabs a slot (waiting up to s.jobQueueWait), runs, then frees it. When the
// server is saturated it returns 503 with Retry-After so the client can back
// off — this is the backstop against many large uploads OOMing the process.
func (s *Server) limitJobs(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case s.jobSem <- struct{}{}:
		default:
			timer := time.NewTimer(s.jobQueueWait)
			defer timer.Stop()
			select {
			case s.jobSem <- struct{}{}:
			case <-timer.C:
				w.Header().Set("Retry-After", "10")
				writeCodedError(w, http.StatusServiceUnavailable, "server_busy",
					errors.New("server is busy, please retry shortly"))
				return
			case <-r.Context().Done():
				// Client went away while queued; nothing to send.
				return
			}
		}
		defer func() { <-s.jobSem }()
		h(w, r)
	}
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) clientIP(r *http.Request) string {
	return auth.ClientIP(r, s.opts.BehindProxy)
}

func uid(r *http.Request) string {
	u, _ := auth.UserFrom(r.Context())
	return u.ID
}

/* ---------------- static web UI ---------------- */

func (s *Server) web(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
		writeError(w, http.StatusNotFound, errors.New("endpoint not found"))
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

/* ---------------- shared helpers ---------------- */

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

// writeCodedError adds a machine-readable code (e.g. password_required) so the
// frontend can branch on it.
func writeCodedError(w http.ResponseWriter, status int, code string, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error(), "code": code})
}

// writeInternalError logs the underlying error server-side and returns a generic
// message, so internal paths / storage keys never reach the client.
func writeInternalError(w http.ResponseWriter, op string, err error) {
	log.Printf("%s: %v", op, err)
	writeError(w, http.StatusInternalServerError, errors.New("internal server error"))
}

func writeText(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(text))
}

func splitIDPath(p, prefix string) (string, string) {
	rest := strings.TrimPrefix(p, prefix)
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) == 1 {
		return parts[0], ""
	}
	return parts[0], parts[1]
}

func finiteAll(values ...float64) bool {
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return false
		}
	}
	return true
}

// sanitizeOutputName cleans a user-supplied download filename: it drops control
// characters and path separators, caps the length and normalizes the .pdf
// suffix. An empty result means "use the default name".
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

// contentDisposition emits both an ASCII fallback and the RFC 5987 UTF-8 name so
// non-ASCII filenames download correctly.
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
