# hlool pdf

`hlool pdf` is a Go + Web PDF stamping workspace. The same Go server can run as a local Windows exe or as a deployable web service.

## Current Features

- Direct-manipulation editor: drag stamps from the shelf onto pages, resize/rotate with handles, smart snap guides, undo/redo (Ctrl+Z), full keyboard map.
- Page organizer ("页面整理 / 拼接"): merge pages from multiple PDFs in any order, drag cards to reorder with FLIP animations, remove/duplicate pages, output a new PDF that lands back in the workspace.
- Continuous-scroll page canvas with a thumbnail rail (per-page stamp badges, seam ribbons, Ctrl/Shift multi-select as page range).
- Seam seal (qifengzhang) with a **true slice preview** — the canvas shows the exact slice each page will receive (same algorithm as the backend), draggable along the edge. Optional deterministic **random slicing** (seeded mulberry32, bit-identical between frontend preview and backend output) for a hand-stamped look; default size 42mm with 40/42/45 presets.
- Batch stamping via a nine-grid position picker, mm margins, and optional random jitter.
- Multi-PDF workflow: per-file configs that survive switching, "apply config to all files", and "generate all" with client-side queueing.
- Stamp import pipeline: WebP auto-converted to PNG, opaque images get automatic white-background removal (undoable).
- Zero confirm dialogs: generate instantly, progress toast in the corner, result card with inline preview and download, history drawer.
- Custom output file name template (`{原名}-已盖章`), UTF-8 names preserved via RFC 5987 headers.
- Password-protected PDFs prompt for the password on demand (`password_required` error code).
- AES-256 encrypted output, light/dark theme with a full-screen day/night transition animation, red-accent design tokens.

## Run

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

For frontend development with hot reload, run `npm --prefix web run dev` alongside the Go server (Vite proxies `/api` to `127.0.0.1:8088`).

## Build Windows Exe

```powershell
cd F:\code\pdf\hlool-pdf
npm --prefix web ci
npm --prefix web run build
go build -tags embed -trimpath -ldflags "-s -w" -o dist\hlool-pdf.exe .\cmd\hlool-pdf
```

Run:

```powershell
.\dist\hlool-pdf.exe --addr 127.0.0.1:8088 --open
```

By default, desktop data is stored in the user config directory. For a portable workspace or easy backup, pass an explicit data directory:

```powershell
.\dist\hlool-pdf.exe --data-dir .\.hlool-data-portable --open
```

Or use the build script:

```powershell
.\scripts\build.ps1
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

If dependency downloads need the local proxy:

```powershell
docker build `
  --build-arg HTTP_PROXY=http://host.docker.internal:9000 `
  --build-arg HTTPS_PROXY=http://host.docker.internal:9000 `
  -t hlool-pdf:local .
```

For a trusted reverse proxy that already handles authentication, set `HLOOL_TRUST_PROXY_AUTH=1` instead of `HLOOL_AUTH_USER/HLOOL_AUTH_PASSWORD`. Web mode refuses to start without one of those authentication boundaries.

## Web Deployment Settings

- `HLOOL_AUTH_USER` / `HLOOL_AUTH_PASSWORD`: enable built-in Basic Auth. Terminate HTTPS at a reverse proxy before exposing it outside localhost.
- `HLOOL_TRUST_PROXY_AUTH=1`: allow web mode without built-in auth only when an upstream proxy enforces auth.
- `HLOOL_CORS_ORIGINS`: comma-separated allowed cross-origin callers, for example `https://pdf.example.com`.
- `HLOOL_MAX_JOBS`: maximum concurrent PDF jobs. Default: `2`.
- `HLOOL_MAX_JOB_BODY_MB`: maximum JSON job request size. Default: `4`.
- `HLOOL_DATA_DIR`: persistent data directory. Upload metadata and completed job links are stored in `manifest.json`.

Recommended public deployment: bind the container to localhost or a private network, put it behind HTTPS + authentication, set reverse-proxy upload limits, and run the container with CPU/memory/storage quotas.

Reverse proxies should preserve `Host` and set `X-Forwarded-Proto`. The bundled frontend is built for the domain root path (`/`); deploy it at the root of a hostname instead of under a subpath like `/pdf/`.

## API

- `GET /api/files`: list saved PDFs.
- `POST /api/files`: upload a PDF (optional `password` form field; encrypted PDFs without it return `{"code":"password_required"}`).
- `POST /api/files/compose`: build a new PDF from an ordered list of `{fileId, pageNumber}` refs (page reorder / multi-file merge).
- `GET /api/files/{id}`: read PDF metadata.
- `GET /api/files/{id}/content`: stream PDF content for PDF.js.
- `GET /api/stamps`: list saved stamp images.
- `POST /api/stamps`: upload a PNG/JPG stamp (the frontend converts WebP client-side).
- `GET /api/stamps/{id}/image`: stream stamp image.
- `GET /api/jobs`: list saved jobs.
- `POST /api/jobs`: create a stamping job (`outputName` sets the download file name).
- `GET /api/jobs/{id}`: poll job status.
- `GET /api/jobs/{id}/download`: download result PDF (`?inline=1` for in-browser preview).

## Architecture

```text
web/ React 19 + TypeScript + Tailwind v4 + Radix + zustand/zundo + PDF.js
        |
        v
cmd/hlool-pdf
internal/server   HTTP API + static web hosting
internal/storage  local isolated file storage
internal/pdf      pdfcpu wrapper and stamp operations
internal/webui    embedded web UI
```

Frontend layout: `web/src/state` (store + undo + persistence), `web/src/features/{viewer,thumbnails,placements,seam,stamps,jobs,inspector,workspace}`, `web/src/ui` (design-token components), `web/src/lib` (units, page expressions, snapping, API).

## Roadmap

- Digital signature adapter (PFX/P12, matching the original PDFQFZ).
- Batch zip download for "generate all".
- Saved stamping presets ("方案": e.g. contract seal = every page bottom-right 42mm + right seam).
- Rotation/CropBox hardening for unusual PDFs.
