package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"hlool-pdf/internal/auth"
	"hlool-pdf/internal/providers"
)

const oauthStateTTL = 10 * time.Minute

// oauthEndpointDefaults 是各内置提供方的标准端点;admin 只需配置 client_id/secret,
// 也可在 public_config 里用 auth_url/token_url/user_info_url 覆盖(比如自建 LinuxDo 网关)。
type oauthEndpointDefaults struct {
	authURL     string
	tokenURL    string
	userInfoURL string
	scopes      []string
}

var oauthDefaults = map[string]oauthEndpointDefaults{
	"github": {
		authURL:     "https://github.com/login/oauth/authorize",
		tokenURL:    "https://github.com/login/oauth/access_token",
		userInfoURL: "https://api.github.com/user",
		scopes:      []string{"read:user", "user:email"},
	},
	"google": {
		authURL:     "https://accounts.google.com/o/oauth2/v2/auth",
		tokenURL:    "https://oauth2.googleapis.com/token",
		userInfoURL: "https://openidconnect.googleapis.com/v1/userinfo",
		scopes:      []string{"openid", "email", "profile"},
	},
	"linuxdo": {
		authURL:     "https://connect.linux.do/oauth2/authorize",
		tokenURL:    "https://connect.linux.do/oauth2/token",
		userInfoURL: "https://connect.linux.do/api/user",
	},
}

// oauthKnownKinds 按展示顺序列出内置提供方;/auth/config 按此顺序报告可用项。
var oauthKnownKinds = []string{"github", "google", "linuxdo"}

/* ---------------- 一次性 state(内存) ---------------- */

// oauthStateStore 在内存里保存一次性 state。单进程部署下这是最简单可靠的做法:
// 重启即全部失效(用户重新点一次登录即可),无需数据库表和清理任务。
type oauthStateStore struct {
	mu     sync.Mutex
	states map[string]oauthPendingState
}

type oauthPendingState struct {
	provider string
	expires  time.Time
}

func newOAuthStateStore() *oauthStateStore {
	return &oauthStateStore{states: make(map[string]oauthPendingState)}
}

func (st *oauthStateStore) put(state, provider string, expires time.Time) {
	st.mu.Lock()
	defer st.mu.Unlock()
	now := time.Now()
	for k, v := range st.states {
		if v.expires.Before(now) {
			delete(st.states, k)
		}
	}
	st.states[state] = oauthPendingState{provider: provider, expires: expires}
}

// consume 单次取出并校验:无论校验结果如何,state 都立即失效。
func (st *oauthStateStore) consume(state, provider string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	v, ok := st.states[state]
	if ok {
		delete(st.states, state)
	}
	return ok && v.provider == provider && time.Now().Before(v.expires)
}

/* ---------------- handlers ---------------- */

// oauthStart 处理 GET /auth/oauth/{provider}:302 到提供方授权页。
// 浏览器跳转流程里的错误一律用 /?authError= 带回登录页提示,不返回 JSON。
func (s *Server) oauthStart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	kind, _ := oauthKindFromPath(r.URL.Path)
	client, err := s.oauthClient(r.Context(), kind)
	if err != nil {
		s.redirectAuthError(w, r, "该第三方登录未配置")
		return
	}
	state, err := providers.GenerateState()
	if err != nil {
		writeInternalError(w, "oauth state", err)
		return
	}
	s.oauthStates.put(state, kind, time.Now().Add(oauthStateTTL))
	http.Redirect(w, r, client.AuthorizationURL(s.oauthRedirectURI(r, kind), state), http.StatusFound)
}

// oauthCallback 处理 GET /auth/oauth/{provider}/callback:
// 校验一次性 state → 换 token → 拉用户信息 → 走第三方登录接缝 → 种会话 → 回首页。
func (s *Server) oauthCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w)
		return
	}
	kind, _ := oauthKindFromPath(r.URL.Path)
	query := r.URL.Query()
	if query.Get("error") != "" {
		s.redirectAuthError(w, r, "第三方登录已取消")
		return
	}
	code := query.Get("code")
	state := query.Get("state")
	if code == "" || state == "" || !s.oauthStates.consume(state, kind) {
		s.redirectAuthError(w, r, "登录会话已过期，请重新发起登录")
		return
	}
	client, err := s.oauthClient(r.Context(), kind)
	if err != nil {
		s.redirectAuthError(w, r, "该第三方登录未配置")
		return
	}
	token, err := client.ExchangeCode(r.Context(), code, s.oauthRedirectURI(r, kind))
	if err != nil {
		log.Printf("oauth exchange (%s): %v", kind, err)
		s.redirectAuthError(w, r, "第三方登录失败，请重试")
		return
	}
	info, err := client.GetUserInfo(r.Context(), token)
	if err != nil {
		log.Printf("oauth userinfo (%s): %v", kind, err)
		s.redirectAuthError(w, r, "获取第三方账号信息失败，请重试")
		return
	}
	settings, err := s.authSettings(r)
	if err != nil {
		writeInternalError(w, "auth settings", err)
		return
	}
	_, raw, expires, err := s.auth.LoginOrRegisterExternalWithPolicy(r.Context(), auth.ExternalIdentity{
		Provider:    kind,
		Subject:     info.Subject,
		DisplayName: info.Name,
		Email:       info.Email,
	}, settings)
	switch {
	case err == nil:
		s.auth.SetSessionCookie(w, raw, expires)
		http.Redirect(w, r, "/", http.StatusFound)
	case errors.Is(err, auth.ErrRegistrationClosed):
		s.redirectAuthError(w, r, "当前实例未开放注册")
	case isRegistrationInviteError(err):
		s.redirectAuthError(w, r, "当前实例注册需要邀请码，暂不支持第三方直接注册")
	default:
		log.Printf("oauth login (%s): %v", kind, err)
		s.redirectAuthError(w, r, "第三方登录失败，请重试")
	}
}

/* ---------------- provider 装配 ---------------- */

// oauthClient 按 kind 装配 OAuth 客户端:数据库里 kind='oauth'、name=github/google/linuxdo,
// 端点缺省用内置值。凭据不全一律视为未配置。
func (s *Server) oauthClient(ctx context.Context, kind string) (*providers.OAuthProvider, error) {
	def, ok := oauthDefaults[kind]
	if !ok || s.providerStore == nil {
		return nil, providers.ErrOAuthNotConfigured
	}
	list, err := s.providerStore.List(ctx, providers.KindOAuth)
	if err != nil {
		return nil, err
	}
	for _, p := range list {
		if !p.Enabled || !strings.EqualFold(strings.TrimSpace(p.Name), kind) {
			continue
		}
		cfg := providers.OAuthConfig{
			Kind:         kind,
			ClientID:     configString(p.PublicConfig, "client_id"),
			ClientSecret: configString(p.SecretConfig, "client_secret"),
			AuthURL:      firstNonEmpty(configString(p.PublicConfig, "auth_url"), def.authURL),
			TokenURL:     firstNonEmpty(configString(p.PublicConfig, "token_url"), def.tokenURL),
			UserInfoURL:  firstNonEmpty(configString(p.PublicConfig, "user_info_url"), def.userInfoURL),
			Scopes:       def.scopes,
		}
		if raw, ok := p.PublicConfig["scopes"].([]interface{}); ok && len(raw) > 0 {
			scopes := make([]string, 0, len(raw))
			for _, item := range raw {
				if str, ok := item.(string); ok && strings.TrimSpace(str) != "" {
					scopes = append(scopes, strings.TrimSpace(str))
				}
			}
			if len(scopes) > 0 {
				cfg.Scopes = scopes
			}
		}
		if cfg.ClientID == "" || cfg.ClientSecret == "" {
			break
		}
		return providers.NewOAuthProvider(cfg), nil
	}
	return nil, providers.ErrOAuthNotConfigured
}

// enabledOAuthKinds 列出已配置齐全的提供方,供 /auth/config 告知前端显示哪些按钮。
func (s *Server) enabledOAuthKinds(ctx context.Context) []string {
	kinds := []string{}
	if s.providerStore == nil {
		return kinds
	}
	list, err := s.providerStore.List(ctx, providers.KindOAuth)
	if err != nil {
		return kinds
	}
	for _, kind := range oauthKnownKinds {
		for _, p := range list {
			if p.Enabled && strings.EqualFold(strings.TrimSpace(p.Name), kind) &&
				configString(p.PublicConfig, "client_id") != "" &&
				configString(p.SecretConfig, "client_secret") != "" {
				kinds = append(kinds, kind)
				break
			}
		}
	}
	return kinds
}

/* ---------------- 小工具 ---------------- */

func oauthKindFromPath(p string) (kind string, callback bool) {
	rest := strings.TrimPrefix(p, "/auth/oauth/")
	if rest == p {
		return "", false
	}
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	switch len(parts) {
	case 1:
		return parts[0], false
	case 2:
		if parts[1] == "callback" {
			return parts[0], true
		}
	}
	return "", false
}

// redirectAuthError 把浏览器跳转流程中的失败带回登录页,由前端 toast 提示一次。
func (s *Server) redirectAuthError(w http.ResponseWriter, r *http.Request, msg string) {
	http.Redirect(w, r, "/?authError="+url.QueryEscape(msg), http.StatusFound)
}

// oauthRedirectURI 从请求推导回调地址;仅在明确声明反代部署时信任 X-Forwarded-Proto。
func (s *Server) oauthRedirectURI(r *http.Request, kind string) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if s.opts.BehindProxy {
		if proto := r.Header.Get("X-Forwarded-Proto"); proto != "" {
			scheme = strings.ToLower(strings.TrimSpace(strings.Split(proto, ",")[0]))
		}
	}
	return scheme + "://" + r.Host + "/auth/oauth/" + kind + "/callback"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}
