//go:build embed

package webui

import (
	"embed"
	"io/fs"
)

//go:embed dist
var embedded embed.FS

func Dist() (fs.FS, error) {
	return fs.Sub(embedded, "dist")
}
