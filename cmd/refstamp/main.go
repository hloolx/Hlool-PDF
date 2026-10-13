// Command refstamp 是本地引擎对齐 harness 的「服务器参考引擎」入口：
// 从 JSON 作业文件直调 internal/pdf.StampPDF（绕过 HTTP 与鉴权），
// 产物供 scripts/verify-local-engine.mjs 与
// web/src/features/generate/localEngine.ts 的输出做逐像素比对。
// 仅供开发对照测试，不参与静态网站的构建、启动或发布。
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	pdfcore "hlool-pdf/internal/pdf"
)

type jobStamp struct {
	Path     string `json:"path"`
	WidthPx  int    `json:"widthPx"`
	HeightPx int    `json:"heightPx"`
}

type composeRef struct {
	File       int `json:"file"`
	PageNumber int `json:"pageNumber"`
	Rotate     int `json:"rotate"`
}

type job struct {
	Name string `json:"name"`
	// Kind: ""/"stamp" 盖章；"compose" 拼接/重排/旋转；"image" 图片转 PDF；
	// "decrypt" 解密（验证本地 qpdf 加密的产物能被 pdfcpu 打开）。
	Kind     string               `json:"kind"`
	Input    string               `json:"input"`
	Inputs   []string             `json:"inputs"`
	Pages    []composeRef         `json:"pages"`
	Output   string               `json:"output"`
	Password string               `json:"password"`
	Stamps   map[string]jobStamp  `json:"stamps"`
	Params   pdfcore.StampOptions `json:"params"`
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: refstamp <jobs.json>")
		os.Exit(2)
	}
	jobsPath := os.Args[1]
	data, err := os.ReadFile(jobsPath)
	if err != nil {
		fatal("read jobs: %v", err)
	}
	var jobs []job
	if err := json.Unmarshal(data, &jobs); err != nil {
		fatal("parse jobs: %v", err)
	}
	// 作业里的相对路径一律相对 jobs.json 所在目录解析，方便 harness 搬家。
	baseDir := filepath.Dir(jobsPath)

	failed := 0
	for _, j := range jobs {
		if err := runJob(baseDir, j); err != nil {
			failed++
			fmt.Printf("FAIL %s: %v\n", j.Name, err)
			continue
		}
		fmt.Printf("ok   %s\n", j.Name)
	}
	if failed > 0 {
		os.Exit(1)
	}
}

func runJob(baseDir string, j job) error {
	output := resolve(baseDir, j.Output)
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		return err
	}
	switch j.Kind {
	case "", "stamp":
		return runStamp(baseDir, j, output)
	case "compose":
		return runCompose(baseDir, j, output)
	case "image":
		return pdfcore.ImageToPDF(resolve(baseDir, j.Input), output)
	case "decrypt":
		return pdfcore.DecryptPDF(resolve(baseDir, j.Input), output, j.Password)
	default:
		return fmt.Errorf("unknown job kind %q", j.Kind)
	}
}

// runStamp 镜像 internal/server.process 的引擎调用序列：
// （可选解密）→ PageInfo → StampPDF。两处必须保持一致，否则参考产物失真。
func runStamp(baseDir string, j job, output string) error {
	input := resolve(baseDir, j.Input)
	working := input
	if j.Password != "" {
		plain := output + ".plain.tmp"
		defer os.Remove(plain)
		if err := pdfcore.DecryptPDF(input, plain, j.Password); err != nil {
			return fmt.Errorf("decrypt: %w", err)
		}
		working = plain
	}

	pages, err := pdfcore.PageInfo(working, "")
	if err != nil {
		return fmt.Errorf("page info: %w", err)
	}

	stamps := make(map[string]pdfcore.StampAsset, len(j.Stamps))
	for id, s := range j.Stamps {
		stamps[id] = pdfcore.StampAsset{Path: resolve(baseDir, s.Path), WidthPx: s.WidthPx, HeightPx: s.HeightPx}
	}

	return pdfcore.StampPDF(working, output, pages, j.Params, stamps)
}

// runCompose 镜像 internal/server.compose 的引擎调用序列：
// 连续同文件段合成 run → ComposePDF → RotatePagesBaked（web 本地对应实现是
// web/src/features/generate/localCompose.ts，两边改动必须同步并跑 harness）。
func runCompose(baseDir string, j job, output string) error {
	paths := make([]string, len(j.Inputs))
	for i, p := range j.Inputs {
		paths[i] = resolve(baseDir, p)
	}
	var runs []pdfcore.ComposeRun
	lastFile := -1
	for _, ref := range j.Pages {
		if ref.File < 0 || ref.File >= len(paths) {
			return fmt.Errorf("page references unknown file %d", ref.File)
		}
		if ref.File != lastFile || len(runs) == 0 {
			runs = append(runs, pdfcore.ComposeRun{Path: paths[ref.File]})
			lastFile = ref.File
		}
		runs[len(runs)-1].Pages = append(runs[len(runs)-1].Pages, ref.PageNumber)
	}

	rotations := map[int]int{}
	for i, ref := range j.Pages {
		rot := ((ref.Rotate % 360) + 360) % 360
		if rot != 0 {
			rotations[i+1] = rot
		}
	}
	if len(rotations) == 0 {
		return pdfcore.ComposePDF(output, runs)
	}
	composed := output + ".composed.tmp"
	defer os.Remove(composed)
	if err := pdfcore.ComposePDF(composed, runs); err != nil {
		return err
	}
	return pdfcore.RotatePagesBaked(composed, output, rotations)
}

func resolve(baseDir, p string) string {
	if p == "" || filepath.IsAbs(p) {
		return p
	}
	return filepath.Join(baseDir, p)
}

func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
