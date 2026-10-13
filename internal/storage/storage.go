// Package storage holds the page geometry value type used by the Go PDF
// reference engine. It does not persist application or user data.
package storage

// PageInfo describes one page's geometry in PDF points (bottom-left origin).
type PageInfo struct {
	PageNumber int     `json:"pageNumber"`
	WidthPt    float64 `json:"widthPt"`
	HeightPt   float64 `json:"heightPt"`
	Rotation   int     `json:"rotation"`
}
