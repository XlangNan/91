package yun139

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/video-site/backend/internal/drives"
)

// PlaybackLinks uses Mobile Cloud's browser-ready HLS independently of the
// original bytes used by downloads, fingerprints and background generation.
// The shared playback resolver owns caching and explicit link refreshes.
func (d *Driver) PlaybackLinks(ctx context.Context, fileID string) (*drives.PlaybackLinks, error) {
	fileID = strings.TrimSpace(fileID)
	if fileID == "" {
		return nil, errors.New("yun139 playback: empty file ID")
	}
	var result struct {
		Data struct {
			FileID      string `json:"fileId"`
			PreviewInfo struct {
				Status string `json:"status"`
				URL    string `json:"url"`
			} `json:"previewInfo"`
		} `json:"data"`
	}
	if err := d.post(ctx, "/videoPreview/getPreviewInfo", map[string]string{
		"fileId": fileID, "category": "video",
	}, &result); err != nil {
		return nil, err
	}
	if result.Data.FileID != "" && result.Data.FileID != fileID {
		return nil, errors.New("yun139 playback: preview response belongs to a different file")
	}
	preview := result.Data.PreviewInfo
	if strings.EqualFold(strings.TrimSpace(preview.Status), "Finished") && strings.TrimSpace(preview.URL) != "" {
		url := strings.TrimSpace(preview.URL)
		if !validHTTPURL(url) {
			return nil, errors.New("yun139 playback: invalid HLS URL")
		}
		return &drives.PlaybackLinks{HLS: &drives.StreamLink{
			URL: url, Expires: time.Now().Add(2 * time.Minute), ClientRedirectSafe: true,
		}}, nil
	}
	// Native-compatible formats can still play while cloud transcoding is
	// pending. The API layer excludes raw TS/MTS/M2TS from this fallback.
	original, err := d.StreamURL(ctx, fileID)
	if err != nil {
		return nil, err
	}
	return &drives.PlaybackLinks{Original: original}, nil
}

var _ drives.PlaybackSourceProvider = (*Driver)(nil)
