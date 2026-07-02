package server

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/library"
	pdfcore "hlool-pdf/internal/pdf"
)

/* ---------------- harness ---------------- */

type harness struct {
	handler http.Handler
	auth    *auth.Service
	lib     library.Store
	token   string
	uid     string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	db, err := auth.OpenDB(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	lib, err := library.NewLocalStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	authSvc := auth.NewService(db, auth.Options{})
	// Provider store is optional for tests; pass nil.
	srv := New(authSvc, lib, nil, nil, Options{})

	user, err := authSvc.Register(context.Background(), "test", "alice", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	_, token, _, err := authSvc.Login(context.Background(), "test", "alice", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	return &harness{handler: srv.Handler(), auth: authSvc, lib: lib, token: token, uid: user.ID}
}

func (h *harness) do(t *testing.T, method, target, contentType string, body io.Reader, authed bool) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if authed {
		req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: h.token})
	}
	rec := httptest.NewRecorder()
	h.handler.ServeHTTP(rec, req)
	return rec
}

/* ---------------- builders ---------------- */

type filePart struct {
	field, filename string
	content         []byte
}

func buildMultipart(t *testing.T, parts []filePart, fields map[string]string) (*bytes.Buffer, string) {
	t.Helper()
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	for _, p := range parts {
		fw, err := mw.CreateFormFile(p.field, p.filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(p.content); err != nil {
			t.Fatal(err)
		}
	}
	for k, v := range fields {
		if err := mw.WriteField(k, v); err != nil {
			t.Fatal(err)
		}
	}
	_ = mw.Close()
	return &body, mw.FormDataContentType()
}

func makePNG(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// makePDF returns the bytes of a real single-page PDF built from an image.
func makePDF(t *testing.T, w, h int) []byte {
	t.Helper()
	dir := t.TempDir()
	imgPath := filepath.Join(dir, "img.png")
	if err := os.WriteFile(imgPath, makePNG(t, w, h), 0o600); err != nil {
		t.Fatal(err)
	}
	outPath := filepath.Join(dir, "out.pdf")
	if err := pdfcore.ImageToPDF(imgPath, outPath); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

/* ---------------- auth ---------------- */

func TestAuthFlow(t *testing.T) {
	h := newHarness(t)

	// Unauthenticated /auth/me is 401.
	if rec := h.do(t, http.MethodGet, "/auth/me", "", nil, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("me without cookie = %d", rec.Code)
	}
	// Authenticated /auth/me is 200.
	if rec := h.do(t, http.MethodGet, "/auth/me", "", nil, true); rec.Code != http.StatusOK {
		t.Fatalf("me with cookie = %d: %s", rec.Code, rec.Body.String())
	}
	// Protected API rejects anonymous callers.
	if rec := h.do(t, http.MethodGet, "/api/stamps", "", nil, false); rec.Code != http.StatusUnauthorized {
		t.Fatalf("stamps without cookie = %d", rec.Code)
	}
}

// sessionCookie extracts the session cookie from a response, or fails.
func sessionCookie(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == auth.SessionCookieName && c.Value != "" {
			return c
		}
	}
	t.Fatalf("response did not set a session cookie")
	return nil
}

func TestGuestEndpoint(t *testing.T) {
	h := newHarness(t)

	// Guest mode is off by default (Options{}): /auth/guest is forbidden.
	if rec := h.do(t, http.MethodPost, "/auth/guest", "", nil, false); rec.Code != http.StatusForbidden {
		t.Fatalf("guest disabled should be 403, got %d", rec.Code)
	}

	// With guest mode enabled, an anonymous POST mints a guest session.
	guestHandler := New(h.auth, h.lib, nil, nil, Options{AllowGuest: true}).Handler()
	rec := httptest.NewRecorder()
	guestHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/auth/guest", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("guest create = %d: %s", rec.Code, rec.Body.String())
	}
	var gv userView
	_ = json.Unmarshal(rec.Body.Bytes(), &gv)
	if !gv.IsGuest || gv.Username != "" {
		t.Fatalf(`guest view should be {isGuest:true, username:""}, got %#v`, gv)
	}
	cookie := sessionCookie(t, rec)

	// The guest cookie reaches protected APIs and /auth/me reports a guest.
	req := httptest.NewRequest(http.MethodGet, "/api/stamps", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	guestHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("guest should reach /api/stamps, got %d", rec.Code)
	}
	req = httptest.NewRequest(http.MethodGet, "/auth/me", nil)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	guestHandler.ServeHTTP(rec, req)
	var me userView
	_ = json.Unmarshal(rec.Body.Bytes(), &me)
	if rec.Code != http.StatusOK || !me.IsGuest {
		t.Fatalf("me should report guest: %d %#v", rec.Code, me)
	}
}

// TestGuestClaimCarriesLibrary is the core promise: a guest's stamps survive
// registering, because the account is upgraded in place (same uid).
func TestGuestClaimCarriesLibrary(t *testing.T) {
	h := newHarness(t)
	guestHandler := New(h.auth, h.lib, nil, nil, Options{AllowGuest: true}).Handler()

	// Become a guest.
	rec := httptest.NewRecorder()
	guestHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/auth/guest", nil))
	cookie := sessionCookie(t, rec)

	// Guest uploads a stamp.
	body, ct := buildMultipart(t, []filePart{{"file", "g.png", makePNG(t, 24, 24)}}, map[string]string{"name": "g"})
	req := httptest.NewRequest(http.MethodPost, "/api/stamps", body)
	req.Header.Set("Content-Type", ct)
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	guestHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("guest stamp upload = %d: %s", rec.Code, rec.Body.String())
	}

	// Register while holding the guest cookie → claim (upgrade in place).
	req = httptest.NewRequest(http.MethodPost, "/auth/register", strings.NewReader(`{"username":"claimed","password":"supersecret123"}`))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	rec = httptest.NewRecorder()
	guestHandler.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("claim register = %d: %s", rec.Code, rec.Body.String())
	}

	// Log in as the real account; the guest's stamp is still there.
	_, token, _, err := h.auth.Login(context.Background(), "test", "claimed", "supersecret123")
	if err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodGet, "/api/stamps", nil)
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName, Value: token})
	rec = httptest.NewRecorder()
	guestHandler.ServeHTTP(rec, req)
	var list []stampView
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 {
		t.Fatalf("claimed account should keep the guest's stamp, got %#v", list)
	}
}

/* ---------------- stamps ---------------- */

func uploadStamp(t *testing.T, h *harness, name string) stampView {
	t.Helper()
	body, ct := buildMultipart(t, []filePart{{"file", name + ".png", makePNG(t, 50, 50)}}, map[string]string{"name": name})
	rec := h.do(t, http.MethodPost, "/api/stamps", ct, body, true)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload stamp = %d: %s", rec.Code, rec.Body.String())
	}
	var view stampView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	return view
}

func TestStampLifecycle(t *testing.T) {
	h := newHarness(t)
	view := uploadStamp(t, h, "公章")
	if !stampIDPattern.MatchString(view.StampID) || view.WidthPx != 50 {
		t.Fatalf("unexpected stamp view: %#v", view)
	}

	// List.
	rec := h.do(t, http.MethodGet, "/api/stamps", "", nil, true)
	var list []stampView
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 1 || list[0].StampID != view.StampID {
		t.Fatalf("list = %#v", list)
	}

	// Content proxy.
	rec = h.do(t, http.MethodGet, "/api/stamps/"+view.StampID+"/content", "", nil, true)
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "image/png" || rec.Body.Len() == 0 {
		t.Fatalf("content proxy failed: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}

	// Rename.
	rec = h.do(t, http.MethodPatch, "/api/stamps/"+view.StampID, "application/json", strings.NewReader(`{"name":"新名字"}`), true)
	var renamed stampView
	_ = json.Unmarshal(rec.Body.Bytes(), &renamed)
	if rec.Code != http.StatusOK || renamed.Name != "新名字" {
		t.Fatalf("rename failed: %d %#v", rec.Code, renamed)
	}

	// Delete.
	rec = h.do(t, http.MethodDelete, "/api/stamps/"+view.StampID, "", nil, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete = %d", rec.Code)
	}
	rec = h.do(t, http.MethodGet, "/api/stamps/"+view.StampID+"/content", "", nil, true)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("deleted stamp content should be 404, got %d", rec.Code)
	}
}

func TestStampScopingBetweenUsers(t *testing.T) {
	h := newHarness(t)
	uploadStamp(t, h, "alice-seal")

	// A second user must not see alice's stamps.
	if _, err := h.auth.Register(context.Background(), "test", "bob", "supersecret123"); err != nil {
		t.Fatal(err)
	}
	_, bobToken, _, _ := h.auth.Login(context.Background(), "test", "bob", "supersecret123")
	h.token = bobToken
	rec := h.do(t, http.MethodGet, "/api/stamps", "", nil, true)
	var list []stampView
	_ = json.Unmarshal(rec.Body.Bytes(), &list)
	if len(list) != 0 {
		t.Fatalf("bob must not see alice's stamps: %#v", list)
	}
}

/* ---------------- settings ---------------- */

func TestSettingsVersioning(t *testing.T) {
	h := newHarness(t)

	rec := h.do(t, http.MethodGet, "/api/settings", "", nil, true)
	var got libraryView
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if got.Version != 0 {
		t.Fatalf("fresh settings version = %d", got.Version)
	}

	rec = h.do(t, http.MethodPut, "/api/settings", "application/json", strings.NewReader(`{"version":0,"data":{"theme":"dark"}}`), true)
	_ = json.Unmarshal(rec.Body.Bytes(), &got)
	if rec.Code != http.StatusOK || got.Version != 1 {
		t.Fatalf("first put: %d v=%d", rec.Code, got.Version)
	}

	// Stale version conflicts.
	rec = h.do(t, http.MethodPut, "/api/settings", "application/json", strings.NewReader(`{"version":0,"data":{}}`), true)
	if rec.Code != http.StatusConflict {
		t.Fatalf("stale put should conflict, got %d", rec.Code)
	}
}

/* ---------------- process / compose ---------------- */

func TestProcessStampsPDF(t *testing.T) {
	h := newHarness(t)
	stamp := uploadStamp(t, h, "seal")

	params := map[string]any{
		"placements": []map[string]any{{
			"stampId": stamp.StampID, "pageNumber": 1,
			"xPt": 50.0, "yPt": 50.0, "widthPt": 120.0, "heightPt": 120.0,
			"rotation": 0.0, "opacity": 1.0,
		}},
		"outputName": "已盖章",
	}
	paramsJSON, _ := json.Marshal(params)
	body, ct := buildMultipart(t,
		[]filePart{{"file", "in.pdf", makePDF(t, 100, 100)}},
		map[string]string{"params": string(paramsJSON)},
	)
	rec := h.do(t, http.MethodPost, "/api/process", ct, body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("process = %d: %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/pdf" {
		t.Fatalf("expected application/pdf, got %q", ct)
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Fatalf("response is not a PDF")
	}
}

func TestProcessRejectsMissingStamp(t *testing.T) {
	h := newHarness(t)
	params := `{"placements":[{"stampId":"stamp_deadbeefdeadbeefdeadbeef","pageNumber":1,"xPt":1,"yPt":1,"widthPt":100,"heightPt":100,"opacity":1}]}`
	body, ct := buildMultipart(t, []filePart{{"file", "in.pdf", makePDF(t, 100, 100)}}, map[string]string{"params": params})
	rec := h.do(t, http.MethodPost, "/api/process", ct, body, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing stamp, got %d: %s", rec.Code, rec.Body.String())
	}
}

// 无任何印章时应直接导出（拼接 / 纯导出用例），原样回流 PDF。
func TestProcessExportsWithoutStamps(t *testing.T) {
	h := newHarness(t)
	body, ct := buildMultipart(t,
		[]filePart{{"file", "in.pdf", makePDF(t, 100, 100)}},
		map[string]string{"params": `{"placements":[],"seamSeals":[],"outputName":"导出"}`},
	)
	rec := h.do(t, http.MethodPost, "/api/process", ct, body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("export without stamps = %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Fatalf("response is not a PDF")
	}
}

// 无印章但要求加密：直通拷贝后仍要正确加密落盘。
func TestProcessExportsWithoutStampsEncrypted(t *testing.T) {
	h := newHarness(t)
	body, ct := buildMultipart(t,
		[]filePart{{"file", "in.pdf", makePDF(t, 100, 100)}},
		map[string]string{"params": `{"placements":[],"seamSeals":[],"outputPassword":"s3cret","outputName":"导出加密"}`},
	)
	rec := h.do(t, http.MethodPost, "/api/process", ct, body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("encrypted export without stamps = %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Fatalf("response is not a PDF")
	}
}

func TestComposeMergesPDFs(t *testing.T) {
	h := newHarness(t)
	params := `{"name":"merged","pages":[{"file":0,"pageNumber":1},{"file":1,"pageNumber":1}]}`
	body, ct := buildMultipart(t, []filePart{
		{"file", "a.pdf", makePDF(t, 200, 100)},
		{"file", "b.pdf", makePDF(t, 100, 200)},
	}, map[string]string{"params": params})
	rec := h.do(t, http.MethodPost, "/api/compose", ct, body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("compose = %d: %s", rec.Code, rec.Body.String())
	}
	if !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Fatalf("compose response is not a PDF")
	}
}

// dimsOfPDFBytes writes PDF bytes to a temp file and returns its first page's size.
func dimsOfPDFBytes(t *testing.T, data []byte) (w, h float64) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "resp.pdf")
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	pages, err := pdfcore.PageInfo(p, "")
	if err != nil {
		t.Fatalf("page info: %v", err)
	}
	return pages[0].WidthPt, pages[0].HeightPt
}

func TestComposeRotatesPage(t *testing.T) {
	h := newHarness(t)
	src := makePDF(t, 100, 200) // portrait A4
	w0, h0 := dimsOfPDFBytes(t, src)

	params := `{"name":"rotated","pages":[{"file":0,"pageNumber":1,"rotate":90}]}`
	body, ct := buildMultipart(t, []filePart{{"file", "a.pdf", src}}, map[string]string{"params": params})
	rec := h.do(t, http.MethodPost, "/api/compose", ct, body, true)
	if rec.Code != http.StatusOK {
		t.Fatalf("compose+rotate = %d: %s", rec.Code, rec.Body.String())
	}
	w1, h1 := dimsOfPDFBytes(t, rec.Body.Bytes())
	if d := w1 - h0; d < -0.5 || d > 0.5 {
		t.Fatalf("rotated width %.2f should equal original height %.2f", w1, h0)
	}
	if d := h1 - w0; d < -0.5 || d > 0.5 {
		t.Fatalf("rotated height %.2f should equal original width %.2f", h1, w0)
	}
}

func TestComposeRejectsBadRotation(t *testing.T) {
	h := newHarness(t)
	params := `{"name":"bad","pages":[{"file":0,"pageNumber":1,"rotate":45}]}`
	body, ct := buildMultipart(t, []filePart{{"file", "a.pdf", makePDF(t, 100, 200)}}, map[string]string{"params": params})
	rec := h.do(t, http.MethodPost, "/api/compose", ct, body, true)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for 45° rotation, got %d: %s", rec.Code, rec.Body.String())
	}
}

func TestImageToPDFEndpoint(t *testing.T) {
	h := newHarness(t)
	body, ct := buildMultipart(t, []filePart{{"file", "pic.png", makePNG(t, 120, 80)}}, nil)
	rec := h.do(t, http.MethodPost, "/api/image-to-pdf", ct, body, true)
	if rec.Code != http.StatusOK || !bytes.HasPrefix(rec.Body.Bytes(), []byte("%PDF")) {
		t.Fatalf("image-to-pdf = %d: %s", rec.Code, rec.Body.String())
	}
}

/* ---------------- unit ---------------- */

func TestBuildComposeRuns(t *testing.T) {
	paths := []string{"a.pdf", "b.pdf"}
	counts := []int{3, 2}
	runs, err := buildComposeRuns([]composePageRef{
		{File: 0, PageNumber: 1},
		{File: 0, PageNumber: 2},
		{File: 1, PageNumber: 1},
		{File: 0, PageNumber: 3},
		{File: 0, PageNumber: 3},
	}, paths, counts)
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 3 {
		t.Fatalf("expected 3 runs, got %d: %+v", len(runs), runs)
	}
	if len(runs[0].Pages) != 2 || runs[0].Pages[0] != 1 {
		t.Fatalf("run 0 wrong: %+v", runs[0])
	}
	if len(runs[2].Pages) != 2 || runs[2].Pages[0] != 3 {
		t.Fatalf("run 2 should keep duplicated pages: %+v", runs[2])
	}
	if _, err := buildComposeRuns([]composePageRef{{File: 0, PageNumber: 9}}, paths, counts); err == nil {
		t.Fatal("expected out-of-range error")
	}
	if _, err := buildComposeRuns([]composePageRef{{File: 5, PageNumber: 1}}, paths, counts); err == nil {
		t.Fatal("expected unknown-file error")
	}
}

func TestSanitizeOutputName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"合同-已盖章", "合同-已盖章.pdf"},
		{"合同-已盖章.PDF", "合同-已盖章.pdf"},
		{`..\..\evil/name.pdf`, "evilname.pdf"},
		{`a<b>c:d"e|f?g*h.pdf`, "abcdefgh.pdf"},
		{"  name... ", "name.pdf"},
		{"   ", ""},
		{".pdf", ""},
	}
	for _, tc := range cases {
		if got := sanitizeOutputName(tc.in); got != tc.want {
			t.Fatalf("sanitizeOutputName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestContentDisposition(t *testing.T) {
	got := contentDisposition("合同 v2.pdf", false)
	if !strings.HasPrefix(got, "attachment; ") || !strings.Contains(got, `filename="__ v2.pdf"`) {
		t.Fatalf("unexpected disposition: %q", got)
	}
	if !strings.Contains(got, "filename*=UTF-8''%E5%90%88%E5%90%8C%20v2.pdf") {
		t.Fatalf("missing RFC 5987 name: %q", got)
	}
}
