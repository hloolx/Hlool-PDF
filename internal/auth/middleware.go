package auth

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"
)

type contextKey struct{}

var userKey contextKey

// WithUser stores the authenticated user in the request context.
func WithUser(ctx context.Context, u User) context.Context {
	return context.WithValue(ctx, userKey, u)
}

// UserFrom retrieves the authenticated user previously stored by RequireAuth.
func UserFrom(ctx context.Context) (User, bool) {
	u, ok := ctx.Value(userKey).(User)
	return u, ok
}

// RequireAuth is middleware that rejects unauthenticated requests with 401 and,
// on success, injects the user into the request context.
func (s *Service) RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, err := s.Authenticate(r.Context(), r)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "authentication required"})
			return
		}
		next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), user)))
	})
}

// RequireAdmin authenticates the session and then requires the account to carry
// the admin flag. It intentionally returns 404-style generic text for missing
// privilege details at the server layer, while keeping the status precise.
func (s *Service) RequireAdmin(next http.Handler) http.Handler {
	return s.RequireAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, _ := UserFrom(r.Context())
		if !user.IsAdmin {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": ErrAdminRequired.Error()})
			return
		}
		next.ServeHTTP(w, r)
	}))
}

// ClientIP returns the best-effort client IP for rate limiting. When trustProxy
// is set, the first hop of X-Forwarded-For is honored.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			if first := strings.TrimSpace(strings.Split(xff, ",")[0]); first != "" {
				return first
			}
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
