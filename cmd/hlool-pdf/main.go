package main

import (
	"context"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/config"
	"hlool-pdf/internal/library"
	"hlool-pdf/internal/server"
	"hlool-pdf/internal/webui"
)

func main() {
	addrFlag := flag.String("addr", "", "override HTTP listen address")
	dataDirFlag := flag.String("data-dir", "", "override data directory")
	webDirFlag := flag.String("web-dir", "", "web UI dist directory")
	openFlag := flag.Bool("open", false, "open the app in the default browser after start")
	flag.Parse()

	openFlagSet := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "open" {
			openFlagSet = true
		}
	})

	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}
	if *addrFlag != "" {
		cfg.Addr = *addrFlag
	}
	if *dataDirFlag != "" {
		if abs, err := filepath.Abs(*dataDirFlag); err == nil {
			cfg.DataDir = abs
		}
	}
	if openFlagSet {
		cfg.OpenBrowser = *openFlag
	}

	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Fatal(err)
	}

	db, err := auth.OpenDB(filepath.Join(cfg.DataDir, "auth.db"))
	if err != nil {
		log.Fatalf("open auth database: %v", err)
	}
	defer db.Close()
	authSvc := auth.NewService(db, auth.Options{SecureCookies: cfg.SecureCookies})

	lib, backend, err := buildLibrary(cfg)
	if err != nil {
		log.Fatalf("init storage backend: %v", err)
	}

	webFS := resolveWebFS(*webDirFlag)
	if webFS == nil {
		log.Printf("web UI not found; serving API-only fallback")
	}

	listener, err := net.Listen("tcp", cfg.Addr)
	if err != nil {
		log.Fatal(err)
	}

	url := displayURL(listener.Addr().String(), cfg.TLSEnabled())
	log.Printf("hlool pdf listening at %s", url)
	log.Printf("storage backend: %s", backend)
	log.Printf("data directory: %s", cfg.DataDir)
	if len(cfg.AllowedHosts) == 0 {
		log.Printf("warning: HLOOL_ALLOWED_HOSTS is empty; any Host header is accepted (set it in production)")
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go backgroundSweeps(ctx, db, lib)

	if cfg.OpenBrowser {
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := openURL(url); err != nil {
				log.Printf("open browser: %v", err)
			}
		}()
	}

	srv := &http.Server{
		Handler: server.New(authSvc, lib, webFS, server.Options{
			CORSOrigins:         cfg.CORSOrigins,
			AllowedHosts:        cfg.AllowedHosts,
			BehindProxy:         cfg.BehindProxy,
			HSTS:                cfg.TLSEnabled() || cfg.BehindProxy,
			AllowGuest:          cfg.AllowGuest,
			MaxProcessBodyBytes: cfg.MaxProcessBodyBytes,
			MaxStampBytes:       cfg.MaxStampBytes,
			MaxConcurrentJobs:   cfg.MaxConcurrentJobs,
		}).Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       10 * time.Minute,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       60 * time.Second,
	}

	serveErr := make(chan error, 1)
	go func() {
		if cfg.TLSEnabled() {
			serveErr <- srv.ServeTLS(listener, cfg.TLSCert, cfg.TLSKey)
		} else {
			serveErr <- srv.Serve(listener)
		}
	}()

	select {
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-ctx.Done():
		stop() // restore default signal handling so a second signal force-quits
		log.Printf("shutdown signal received; draining in-flight requests (up to 20s)")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown: %v", err)
			_ = srv.Close()
		}
	}
}

// buildLibrary selects the S3 or local-filesystem backend based on config.
func buildLibrary(cfg config.Config) (library.Store, string, error) {
	if cfg.UseS3() {
		store, err := library.NewS3Store(context.Background(), library.S3Options{
			Bucket:                cfg.S3.Bucket,
			Region:                cfg.S3.Region,
			Endpoint:              cfg.S3.Endpoint,
			Prefix:                cfg.S3.Prefix,
			ForcePathStyle:        cfg.S3.ForcePathStyle,
			SSE:                   cfg.S3.SSE,
			KMSKeyID:              cfg.S3.KMSKeyID,
			ChecksumWhenSupported: cfg.S3.ChecksumWhenSupported,
		})
		if err != nil {
			return nil, "", err
		}
		return store, fmt.Sprintf("s3 (bucket %s, sse %s)", cfg.S3.Bucket, sseLabel(cfg.S3.SSE)), nil
	}
	store, err := library.NewLocalStore(cfg.DataDir)
	if err != nil {
		return nil, "", err
	}
	return store, "local filesystem", nil
}

// sseLabel renders the configured server-side-encryption mode for the startup log.
func sseLabel(sse string) string {
	if sse == "" || sse == "none" {
		return "off"
	}
	return sse
}

// backgroundSweeps periodically purges expired sessions, burns expired guest
// accounts (their library plus the account row) and clears stale temp dirs (a
// backstop for the per-request read-and-burn cleanup). It returns when ctx is
// cancelled (server shutdown), so it never races the deferred db.Close().
func backgroundSweeps(ctx context.Context, db *auth.DB, lib library.Store) {
	purgeExpiredGuests(ctx, db, lib)
	sweepTempDirs(time.Hour)
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := db.DeleteExpiredSessions(ctx, time.Now()); err != nil {
				log.Printf("session cleanup: %v", err)
			}
			purgeExpiredGuests(ctx, db, lib)
			sweepTempDirs(time.Hour)
		}
	}
}

// purgeExpiredGuests burns every guest account older than auth.GuestTTL: its
// library first, then the account row (whose session cascades away). A library
// error leaves the row for the next sweep rather than orphaning stored data.
func purgeExpiredGuests(ctx context.Context, db *auth.DB, lib library.Store) {
	ids, err := db.ExpiredGuestIDs(ctx, time.Now().Add(-auth.GuestTTL))
	if err != nil {
		log.Printf("guest sweep: %v", err)
		return
	}
	burned := 0
	for _, id := range ids {
		if err := lib.PurgeUser(ctx, id); err != nil {
			log.Printf("guest sweep: purge library: %v", err)
			continue
		}
		if err := db.DeleteUser(ctx, id); err != nil {
			log.Printf("guest sweep: delete account: %v", err)
			continue
		}
		burned++
	}
	if burned > 0 {
		log.Printf("guest sweep: burned %d expired guest account(s)", burned)
	}
}

// sweepTempDirs removes leftover hlool-* working directories older than maxAge.
func sweepTempDirs(maxAge time.Duration) {
	base := os.TempDir()
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasPrefix(name, "hlool-process-") &&
			!strings.HasPrefix(name, "hlool-compose-") &&
			!strings.HasPrefix(name, "hlool-image-") &&
			!strings.HasPrefix(name, "hlool-seam-") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		_ = os.RemoveAll(filepath.Join(base, name))
	}
}

func displayURL(listenAddr string, tls bool) string {
	scheme := "http"
	if tls {
		scheme = "https"
	}
	if host, port, err := net.SplitHostPort(listenAddr); err == nil {
		if host == "::" || host == "" || host == "0.0.0.0" {
			host = "127.0.0.1"
		}
		listenAddr = net.JoinHostPort(host, port)
	}
	return scheme + "://" + listenAddr
}

func resolveWebFS(webDir string) fs.FS {
	if webDir != "" {
		if info, err := os.Stat(webDir); err == nil && info.IsDir() {
			return os.DirFS(webDir)
		}
		log.Printf("web UI directory %q not found", webDir)
	}
	if dist, err := webui.Dist(); err == nil {
		return dist
	}
	dir := filepath.Join("internal", "webui", "dist")
	if info, err := os.Stat(dir); err == nil && info.IsDir() {
		return os.DirFS(dir)
	}
	return nil
}

func openURL(url string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	case "darwin":
		return exec.Command("open", url).Start()
	case "linux":
		return exec.Command("xdg-open", url).Start()
	default:
		return fmt.Errorf("unsupported platform %s", runtime.GOOS)
	}
}
