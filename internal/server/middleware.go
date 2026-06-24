package server

import (
	"errors"
	"log"
	"net"
	"net/http"
	"net/url"
	"runtime/debug"
	"strings"
	"time"
)

// contentSecurityPolicy locks the app to same-origin. blob:/data: are allowed
// for PDF.js (worker + rendered images) and stamp/image previews; style
// 'unsafe-inline' is required by the component styling. The task's mandated
// directives (default-src/connect-src 'self', frame-ancestors 'none') are kept.
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' blob: data:; " +
	"font-src 'self' data:; " +
	"connect-src 'self'; " +
	"worker-src 'self' blob:; " +
	"object-src 'none'; " +
	"base-uri 'self'; " +
	"form-action 'self'; " +
	"frame-ancestors 'none'"

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, redactedPath(r.URL.Path), time.Since(start).Round(time.Millisecond))
	})
}

// withRecover is the outermost guard: it turns a panic in any handler or inner
// middleware (pdfcpu, for one, can panic on malformed input) into a clean 500
// plus a logged stack, instead of an abruptly dropped connection. If the
// response has already started streaming the body is left as-is — only the
// process safety and the log entry are guaranteed.
func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec) // let the server handle its own sentinel
				}
				log.Printf("panic: %s %s: %v\n%s", r.Method, redactedPath(r.URL.Path), rec, debug.Stack())
				writeError(w, http.StatusInternalServerError, errors.New("internal server error"))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// withHostGuard rejects requests whose Host header is not in the allowlist
// (DNS-rebinding guard). An empty allowlist permits any host (local dev).
func withHostGuard(allowed []string, next http.Handler) http.Handler {
	set := map[string]struct{}{}
	for _, h := range allowed {
		if h = strings.ToLower(strings.TrimSpace(h)); h != "" {
			set[h] = struct{}{}
		}
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(set) > 0 && r.URL.Path != "/healthz" {
			if _, ok := set[strings.ToLower(hostWithoutPort(r.Host))]; !ok {
				writeError(w, http.StatusBadRequest, errors.New("host not allowed"))
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func withSecurityHeaders(hsts bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		if hsts {
			h.Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/auth/") {
			h.Set("Cache-Control", "private, no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// withCSRFGuard rejects state-changing requests from a disallowed origin. The
// SameSite=Strict session cookie is the primary defense; this is belt-and-braces.
func withCSRFGuard(corsOrigins []string, behindProxy bool, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if !requestOriginAllowed(r, corsOrigins, behindProxy) {
			writeError(w, http.StatusForbidden, errors.New("request origin is not allowed"))
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withCORS(origins []string, next http.Handler) http.Handler {
	allowedOrigins := map[string]struct{}{}
	allowAny := false
	for _, origin := range origins {
		if origin = strings.TrimSpace(origin); origin == "" {
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
		if origin != "" && w.Header().Get("Access-Control-Allow-Origin") != "" {
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requestOriginAllowed(r *http.Request, allowed []string, behindProxy bool) bool {
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
	if sameRequestOrigin(r, origin, behindProxy) {
		return true
	}
	for _, item := range allowed {
		if strings.TrimSpace(item) == origin {
			return true
		}
	}
	return false
}

func sameRequestOrigin(r *http.Request, origin string, behindProxy bool) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if behindProxy {
		if forwarded := r.Header.Get("X-Forwarded-Proto"); forwarded != "" {
			scheme = strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	return strings.EqualFold(u.Scheme, scheme) && strings.EqualFold(u.Host, r.Host)
}

func hostWithoutPort(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		return h
	}
	return host
}

// redactedPath shortens opaque ids in request paths for logs.
func redactedPath(value string) string {
	parts := strings.Split(value, "/")
	for i, part := range parts {
		if strings.HasPrefix(part, "stamp_") && len(part) > len("stamp_")+6 {
			parts[i] = part[:len("stamp_")+6] + "..."
		}
	}
	return strings.Join(parts, "/")
}
