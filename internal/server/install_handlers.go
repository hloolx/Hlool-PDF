package server

import (
	"crypto/subtle"
	"errors"
	"log"
	"net"
	"net/http"

	"hlool-pdf/internal/auth"
)

// 首次安装向导(软引导):实例里还没有任何管理员时,/auth/config 会带上
// needsInstall,登录页据此优先渲染初始化界面;既有的登录/注册/游客入口不封锁,
// 防抢注靠 /auth/install 自身的门槛 —— 本机访问直接放行,远程访问必须携带
// 启动日志里打印的一次性初始化令牌。

// needsInstall 报告当前是否处于「未初始化」状态。管理员一旦存在便永远为 false,
// 用原子布尔做正向缓存,之后不再查库。
func (s *Server) needsInstall(r *http.Request) bool {
	if s.installedFlag.Load() {
		return false
	}
	has, err := s.auth.HasAdmin(r.Context())
	if err != nil {
		// 查库失败时按「已初始化」处理:宁可少展示一次向导,也不能让故障锁死登录页。
		log.Printf("check install state: %v", err)
		return false
	}
	if has {
		s.installedFlag.Store(true)
	}
	return !has
}

// requestFromLoopback 判定请求是否来自本机(尊重 BehindProxy 的真实 IP 解析)。
func (s *Server) requestFromLoopback(r *http.Request) bool {
	ip := net.ParseIP(s.clientIP(r))
	return ip != nil && ip.IsLoopback()
}

// install 处理 POST /auth/install:创建首个管理员、写入访问开关、直接登录。
func (s *Server) install(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		methodNotAllowed(w)
		return
	}
	if !s.needsInstall(r) {
		writeCodedError(w, http.StatusConflict, "already_installed", errors.New("实例已完成初始化"))
		return
	}
	var req struct {
		Token           string `json:"token"`
		Username        string `json:"username"`
		Password        string `json:"password"`
		GuestEnabled    bool   `json:"guestEnabled"`
		RegisterEnabled bool   `json:"registerEnabled"`
	}
	if err := readJSON(w, r, &req, maxAuthBody); err != nil {
		writeError(w, http.StatusBadRequest, errors.New("invalid request body"))
		return
	}
	if !s.requestFromLoopback(r) {
		// 远程初始化必须持有启动日志里的一次性令牌;没配令牌就只允许本机。
		if s.opts.SetupToken == "" ||
			subtle.ConstantTimeCompare([]byte(req.Token), []byte(s.opts.SetupToken)) != 1 {
			writeCodedError(w, http.StatusForbidden, "setup_token_invalid",
				errors.New("初始化令牌不正确，请查看服务器启动日志"))
			return
		}
	}

	user, _, err := s.auth.EnsureAdmin(r.Context(), req.Username, req.Password)
	switch {
	case err == nil:
	case errors.Is(err, auth.ErrInvalidUsername), errors.Is(err, auth.ErrWeakPassword):
		writeError(w, http.StatusBadRequest, err)
		return
	default:
		writeInternalError(w, "install admin", err)
		return
	}

	// 访问开关落库:以部署默认值为底,只覆盖向导里问过的两项。
	settings := s.opts.AuthDefaults
	settings.GuestEnabled = req.GuestEnabled
	settings.RegisterEnabled = req.RegisterEnabled
	if err := s.auth.PutAuthSettings(r.Context(), settings); err != nil {
		writeInternalError(w, "install settings", err)
		return
	}
	s.installedFlag.Store(true)

	_, token, expires, err := s.auth.Login(r.Context(), s.clientIP(r), req.Username, req.Password)
	if err != nil {
		// 管理员已建好,登录失败只影响本次会话:让用户回登录页手动登录。
		writeJSON(w, http.StatusCreated, newUserView(user))
		return
	}
	s.auth.SetSessionCookie(w, token, expires)
	writeJSON(w, http.StatusCreated, newUserView(user))
}
