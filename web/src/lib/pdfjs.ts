import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

/** All deferred PDF resources are same-origin and included in the offline build. */
export function loadPdf(data: ArrayBuffer | Uint8Array, password?: string) {
  const assets = new URL(`${import.meta.env.BASE_URL}pdfjs/`, location.href).href
  return pdfjsLib.getDocument({
    data,
    password,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    iccUrl: `${assets}iccs/`
  })
}

export { pdfjsLib }
export type PDFDocumentProxy = pdfjsLib.PDFDocumentProxy
