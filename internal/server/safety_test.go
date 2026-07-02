package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestLimitJobsRejectsWhenSaturated verifies the heavy-endpoint semaphore: with
// a single slot held, the next request is turned away with 503 + Retry-After +
// the machine-readable server_busy code (so the frontend can back off).
func TestLimitJobsRejectsWhenSaturated(t *testing.T) {
	srv := New(nil, nil, nil, nil, Options{MaxConcurrentJobs: 1})
	srv.jobQueueWait = 50 * time.Millisecond

	started := make(chan struct{})
	release := make(chan struct{})
	handler := srv.limitJobs(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-release
		w.WriteHeader(http.StatusOK)
	})

	go handler(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/process", nil))
	<-started // first job now holds the only slot

	rec := httptest.NewRecorder()
	handler(rec, httptest.NewRequest(http.MethodPost, "/api/process", nil))
	close(release)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("saturated request status = %d, want 503", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("503 must carry a Retry-After header")
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body.Code != "server_busy" {
		t.Fatalf("error code = %q, want server_busy", body.Code)
	}
}

// TestLimitJobsReleasesSlot confirms a finished job frees its slot for the next.
func TestLimitJobsReleasesSlot(t *testing.T) {
	srv := New(nil, nil, nil, nil, Options{MaxConcurrentJobs: 1})
	srv.jobQueueWait = time.Second
	handler := srv.limitJobs(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		handler(rec, httptest.NewRequest(http.MethodPost, "/api/process", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("sequential request %d status = %d, want 200", i, rec.Code)
		}
	}
}

// TestWithRecoverConvertsPanicTo500 verifies a handler panic becomes a clean 500
// instead of a dropped connection.
func TestWithRecoverConvertsPanicTo500(t *testing.T) {
	handler := withRecover(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		panic("boom")
	}))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/process", nil))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("panic status = %d, want 500", rec.Code)
	}
}
