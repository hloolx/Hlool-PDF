# hlool pdf

![hlool pdf README banner](svg/readme-banner.svg)

**优雅顺手的 PDF 盖章工作台。** 拖入 PDF 或图片，把印章直接放到页面上，骑缝章切片实时预览，多文件配置可以一键应用并批量生成。

`hlool pdf` 可以作为本地 Windows 桌面程序运行，也可以部署成带认证边界的 Web 服务。

## Highlights

- **Direct stamping**: drag stamps from the shelf to the PDF page, resize, rotate, snap, undo and redo.
- **Seam seal preview**: true page-slice preview for right/left/top/bottom seam seals, including deterministic random slicing.
- **Batch workflow**: keep per-file configs, apply one config to the whole queue, and generate all files.
- **Page organizer**: combine pages from multiple PDFs, reorder page cards, duplicate, remove, and output a new PDF.
- **Private by default**: local storage, Basic Auth / trusted reverse proxy mode, AES-256 encrypted output.

![Workflow explainer](generated/05-readme-workflow-explainer.png)

## Why It Feels Different

Most stamping tools are form-driven: fill in numbers, click a button, check the page, repeat. `hlool pdf` is canvas-driven: drag it, press it, adjust it, and generate. The interface treats PDF stamping like arranging objects on a page, not filling out a backend form.

![Batch queue](generated/07-batch-queue-feature.png)

## Core Features

| Feature | What it does |
|---|---|
| Direct manipulation | Drag, resize, rotate, align, delete, copy, undo, redo. |
| Batch stamping | Nine-grid placement, mm margins, random jitter, apply to page ranges. |
| Seam seal | Real slice preview, edge dragging, 40/42/45mm presets, deterministic random slicing. |
| Multi-file queue | Per-file configs survive switching; generate current or generate all. |
| Page organizer | Merge and reorder pages from multiple PDFs, then return the result to the workspace. |
| Stamp import | PNG/JPG/WebP import with client-side WebP conversion and white-background cleanup. |

![Page organizer](generated/09-page-organizer-feature.png)

## Run Locally

Requires Go 1.26+ and Node.js 22.13+.

```powershell
cd F:\code\pdf\hlool-pdf

npm --prefix web install
npm --prefix web run build

go run .\cmd\hlool-pdf --mode desktop --addr 127.0.0.1:8088 --open
```

Then open:

```text
http://127.0.0.1:8088
```

## Build Windows Exe

```powershell
cd F:\code\pdf\hlool-pdf
npm --prefix web ci
npm --prefix web run build
go build -tags embed -trimpath -ldflags "-s -w" -o dist\hlool-pdf.exe .\cmd\hlool-pdf
```

## Docker

```powershell
docker build -t hlool-pdf:local .
docker run --rm `
  -p 127.0.0.1:8080:8080 `
  -e HLOOL_AUTH_USER=admin `
  -e HLOOL_AUTH_PASSWORD=change-me `
  -v "${PWD}\.hlool-data-docker:/data" `
  hlool-pdf:local
```

![Private workspace](generated/08-security-private-workspace.png)

## API

- `GET /api/files`: list saved PDFs.
- `POST /api/files`: upload a PDF or supported image.
- `POST /api/files/compose`: build a new PDF from ordered page refs.
- `POST /api/jobs`: create a stamping job.
- `GET /api/jobs/{id}/download`: download or preview the result PDF.

## Architecture

```text
web/ React 19 + TypeScript + Tailwind v4 + Radix + zustand/zundo + PDF.js
        |
        v
cmd/hlool-pdf
internal/server   HTTP API + static web hosting
internal/storage  local or S3-backed file storage
internal/pdf      pdfcpu wrapper and stamp operations
internal/webui    embedded web UI
```
