//go:build !embed

package webui

import (
	"errors"
	"io/fs"
)

var ErrNotEmbedded = errors.New("web UI is not embedded")

func Dist() (fs.FS, error) {
	return nil, ErrNotEmbedded
}
