package main

import (
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"hlool-pdf/internal/server"
	"hlool-pdf/internal/storage"
	"hlool-pdf/internal/webui"
)

func main() {
	mode := flag.String("mode", envOr("HLOOL_MODE", "desktop"), "run mode: desktop or web")
	addr := flag.String("addr", envOr("HLOOL_ADDR", ""), "HTTP listen address")
	dataDir := flag.String("data-dir", envOr("HLOOL_DATA_DIR", ""), "data directory")
	webDir := flag.String("web-dir", envOr("HLOOL_WEB_DIR", ""), "web UI dist directory")
	authUser := flag.String("auth-user", envOr("HLOOL_AUTH_USER", ""), "basic auth username")
	authPassword := flag.String("auth-password", envOr("HLOOL_AUTH_PASSWORD", ""), "basic auth password")
	trustProxyAuth := flag.Bool("trust-proxy-auth", envBool("HLOOL_TRUST_PROXY_AUTH", false), "allow web mode without built-in auth because a trusted reverse proxy handles authentication")
	corsOrigins := flag.String("cors-origins", envOr("HLOOL_CORS_ORIGINS", ""), "comma-separated allowed CORS origins")
	maxJobs := flag.Int("max-jobs", envInt("HLOOL_MAX_JOBS", 2), "maximum concurrent PDF jobs")
	maxJobBodyMB := flag.Int64("max-job-body-mb", envInt64("HLOOL_MAX_JOB_BODY_MB", 4), "maximum JSON job request size in MiB")
	openBrowser := flag.Bool("open", false, "open the app in the default browser after start")
	flag.Parse()
	openFlagSet := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "open" {
			openFlagSet = true
		}
	})

	if *addr == "" {
		if *mode == "web" {
			*addr = "0.0.0.0:" + envOr("PORT", "8080")
		} else {
			*addr = "127.0.0.1:8088"
		}
	}
	if *dataDir == "" {
		if *mode == "web" {
			*dataDir = "/data"
		} else {
			*dataDir = defaultDesktopDataDir()
		}
	}
	if *mode == "desktop" && !openFlagSet {
		*openBrowser = true
	}
	if (*authUser == "") != (*authPassword == "") {
		log.Fatal("basic auth requires both username and password")
	}
	if *mode != "desktop" && *mode != "web" {
		log.Fatal("mode must be desktop or web")
	}
	if *mode == "web" && *authUser == "" && *authPassword == "" && !*trustProxyAuth {
		log.Fatal("web mode requires HLOOL_AUTH_USER/HLOOL_AUTH_PASSWORD or HLOOL_TRUST_PROXY_AUTH=1")
	}

	store, err := storage.New(*dataDir)
	if err != nil {
		log.Fatal(err)
	}
	webFS := resolveWebFS(*webDir)
	if webFS == nil {
		log.Printf("web UI not found; serving API-only fallback")
	}

	listener, err := net.Listen("tcp", *addr)
	if err != nil {
		log.Fatal(err)
	}
	actualAddr := listener.Addr().String()
	if host, port, err := net.SplitHostPort(actualAddr); err == nil {
		if host == "::" || host == "" {
			host = "127.0.0.1"
		}
		actualAddr = net.JoinHostPort(host, port)
	}
	url := "http://" + actualAddr
	log.Printf("hlool pdf listening at %s", url)
	log.Printf("data directory: %s", store.Root())
	if *mode == "web" && *trustProxyAuth {
		log.Printf("web mode is trusting an upstream reverse proxy for authentication")
	}

	if *openBrowser {
		go func() {
			time.Sleep(300 * time.Millisecond)
			if err := openURL(url); err != nil {
				log.Printf("open browser: %v", err)
			}
		}()
	}

	srv := &http.Server{
		Handler: server.New(store, webFS, server.Options{
			AuthUsername:      *authUser,
			AuthPassword:      *authPassword,
			CORSOrigins:       splitCSV(*corsOrigins),
			MaxConcurrentJobs: *maxJobs,
			MaxJobBodySize:    *maxJobBodyMB << 20,
		}).Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		ReadTimeout:       10 * time.Minute,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       60 * time.Second,
	}
	if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
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
	for _, dir := range []string{
		filepath.Join("internal", "webui", "dist"),
		filepath.Join("web", "dist"),
	} {
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			return os.DirFS(dir)
		}
	}
	return nil
}

func defaultDesktopDataDir() string {
	if dir, err := os.UserConfigDir(); err == nil && dir != "" {
		return filepath.Join(dir, "hlool-pdf")
	}
	return filepath.Join(".", ".hlool-data")
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	v, err := strconv.Atoi(envOr(key, ""))
	if err != nil {
		return fallback
	}
	return v
}

func envInt64(key string, fallback int64) int64 {
	v, err := strconv.ParseInt(envOr(key, ""), 10, 64)
	if err != nil {
		return fallback
	}
	return v
}

func envBool(key string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(envOr(key, ""))) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}

func splitCSV(value string) []string {
	if value == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
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
