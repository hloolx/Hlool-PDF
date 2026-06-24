// Package storage holds value types shared between the PDF pipeline
// (internal/pdf) and its callers. It used to own session/file persistence
// (PDF/stamp/job storage with a startup wipe); that machinery was removed when
// the server moved to a stateless, read-and-burn model. Only PageInfo remains
// because internal/pdf — which must not be modified — imports it.
package storage

// PageInfo describes one page's geometry in PDF points (bottom-left origin).
type PageInfo struct {
	PageNumber int     `json:"pageNumber"`
	WidthPt    float64 `json:"widthPt"`
	HeightPt   float64 `json:"heightPt"`
	Rotation   int     `json:"rotation"`
}
