package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"log"
	"math/big"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/providers"
)

const (
	emailCodeLength      = 6
	emailCodeTTL         = 10 * time.Minute
	emailCodeMaxAttempts = 5
	emailRateWindow      = 15 * time.Minute
	emailRateMaxSends    = 5
	maxEmailLength       = 254
)

// mailSender 是发验证码邮件的最小接口:生产走 providers.MailClient,测试注入假实现。
type mailSender interface {
	SendVerificationCode(to, code string) error
}

// emailSendCode 处理 POST /auth/email/send-code:{email} → {expiresIn}。
// 响应对「邮箱是否已注册」保持沉默,避免探测账号存在性。
func (s *Server) emailSendCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if err := readJSON(w, r, &req, maxAuthBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	email := providers.NormalizeEmail(req.Email)
	if !validEmail(email) {
		writeCodedError(w, http.StatusBadRequest, "invalid_email", errors.New("邮箱格式不正确"))
		return
	}
	provider, ok := s.enabledMailProvider(r.Context())
	if !ok {
		writeCodedError(w, http.StatusBadRequest, "email_login_disabled", errors.New("邮箱登录未启用"))
		return
	}
	n, err := s.auth.CountRecentEmailLoginCodes(r.Context(), email, s.clientIP(r), emailRateWindow)
	if err != nil {
		writeInternalError(w, "email rate limit", err)
		return
	}
	if n >= emailRateMaxSends {
		writeCodedError(w, http.StatusTooManyRequests, "rate_limited", errors.New("发送太频繁，请稍后再试"))
		return
	}
	code, err := randomDigits(emailCodeLength)
	if err != nil {
		writeInternalError(w, "generate email code", err)
		return
	}
	if _, err := s.auth.StoreEmailLoginCode(r.Context(), email, hashEmailCode(code), s.clientIP(r), emailCodeTTL); err != nil {
		writeInternalError(w, "store email code", err)
		return
	}
	if err := s.mailSender(provider).SendVerificationCode(email, code); err != nil {
		log.Printf("send verification mail: %v", err)
		writeCodedError(w, http.StatusBadGateway, "mail_send_failed", errors.New("邮件发送失败，请稍后再试"))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"expiresIn": int(emailCodeTTL.Seconds())})
}

// emailVerify 处理 POST /auth/email/verify:{email, code} → 会话 cookie + 用户视图。
// 验证通过后走与密码登录同一套第三方登录接缝(email 作为 provider),
// 首次见到的邮箱按策略自动开号。
func (s *Server) emailVerify(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := readJSON(w, r, &req, maxAuthBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	email := providers.NormalizeEmail(req.Email)
	code := strings.TrimSpace(req.Code)
	if !validEmail(email) || len(code) != emailCodeLength || !allDigits(code) {
		writeCodedError(w, http.StatusBadRequest, "invalid_code", errors.New("验证码格式不正确"))
		return
	}
	ok, err := s.auth.ConsumeEmailLoginCode(r.Context(), email, hashEmailCode(code), emailCodeMaxAttempts)
	if err != nil {
		writeInternalError(w, "verify email code", err)
		return
	}
	if !ok {
		writeCodedError(w, http.StatusUnauthorized, "invalid_code", errors.New("验证码错误或已过期"))
		return
	}
	settings, err := s.authSettings(r)
	if err != nil {
		writeInternalError(w, "auth settings", err)
		return
	}
	user, token, expires, err := s.auth.LoginOrRegisterExternalWithPolicy(r.Context(), auth.ExternalIdentity{
		Provider:    "email",
		Subject:     email,
		DisplayName: emailLocalPart(email),
		Email:       email,
	}, settings)
	switch {
	case err == nil:
		s.auth.SetSessionCookie(w, token, expires)
		writeJSON(w, http.StatusOK, newUserView(user))
	case errors.Is(err, auth.ErrRegistrationClosed):
		writeError(w, http.StatusForbidden, err)
	case isRegistrationInviteError(err):
		writeError(w, http.StatusBadRequest, err)
	default:
		writeInternalError(w, "email login", err)
	}
}

/* ---------------- provider 装配 ---------------- */

// enabledMailProvider 返回第一个启用且配置齐全(host + 账号凭据)的 SMTP provider。
// 不存在则视为邮箱登录未开启,/auth/config 也用它来决定前端是否展示入口。
func (s *Server) enabledMailProvider(ctx context.Context) (providers.Provider, bool) {
	if s.providerStore == nil {
		return providers.Provider{}, false
	}
	list, err := s.providerStore.List(ctx, providers.KindMail)
	if err != nil {
		return providers.Provider{}, false
	}
	for _, p := range list {
		if p.Enabled &&
			configString(p.PublicConfig, "host") != "" &&
			configString(p.SecretConfig, "username") != "" &&
			configString(p.SecretConfig, "password") != "" {
			return p, true
		}
	}
	return providers.Provider{}, false
}

// mailSender 允许测试通过 newMailSender 注入假发信器。
func (s *Server) mailSender(p providers.Provider) mailSender {
	if s.newMailSender != nil {
		return s.newMailSender(p)
	}
	return providers.NewMailClient(
		configString(p.PublicConfig, "host"),
		configString(p.SecretConfig, "username"),
		configString(p.SecretConfig, "password"),
		configString(p.PublicConfig, "from"),
		configInt(p.PublicConfig, "port"),
		configBool(p.PublicConfig, "use_tls"),
	)
}

/* ---------------- 小工具 ---------------- */

func validEmail(email string) bool {
	if email == "" || len(email) > maxEmailLength {
		return false
	}
	parsed, err := mail.ParseAddress(email)
	return err == nil && parsed.Address == email
}

// randomDigits 逐位取密码学随机数,避免取模偏差。
func randomDigits(n int) (string, error) {
	var b strings.Builder
	for i := 0; i < n; i++ {
		d, err := rand.Int(rand.Reader, big.NewInt(10))
		if err != nil {
			return "", err
		}
		b.WriteByte(byte('0' + d.Int64()))
	}
	return b.String(), nil
}

func hashEmailCode(code string) string {
	sum := sha256.Sum256([]byte(code))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func emailLocalPart(email string) string {
	if i := strings.IndexByte(email, '@'); i > 0 {
		return email[:i]
	}
	return email
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}

// JSON 里的 provider 配置经过 encoding/json 反序列化,数字统一是 float64、
// 布尔可能被管理端存成字符串;这里做宽松而安全的取值。
func configString(m map[string]interface{}, key string) string {
	if m == nil {
		return ""
	}
	v, _ := m[key].(string)
	return strings.TrimSpace(v)
}

func configInt(m map[string]interface{}, key string) int {
	if m == nil {
		return 0
	}
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(v))
		return n
	}
	return 0
}

func configBool(m map[string]interface{}, key string) bool {
	if m == nil {
		return false
	}
	switch v := m[key].(type) {
	case bool:
		return v
	case string:
		return v == "true" || v == "1"
	case float64:
		return v != 0
	}
	return false
}
