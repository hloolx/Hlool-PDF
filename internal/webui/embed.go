//go:build embed

package webui

import (
	"embed"
	"io/fs"
)

// all: 前缀必须保留：默认 //go:embed 会静默跳过以 _ 或 . 开头的文件，
// 而 Vite 会产出下划线开头的共享 chunk（如 _commonjsHelpers-*.js）。漏掉它们
// 时入口页能开，但 Worker 内动态 import 该 chunk 会 404 → 本地引擎静默回退云端。
//
//go:embed all:dist
var embedded embed.FS

func Dist() (fs.FS, error) {
	return fs.Sub(embedded, "dist")
}
