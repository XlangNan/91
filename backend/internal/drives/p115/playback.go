package p115

import (
	"context"
	"errors"
	"strings"

	"github.com/video-site/backend/internal/drives"
)

// PlaybackSources retains the master so HLS clients can select a rendition and
// its audio tracks. The account cookie is used only to resolve that master.
func (d *Driver) PlaybackSources(ctx context.Context, fileID string) ([]drives.PlaybackSource, error) {
	fileID = strings.TrimSpace(fileID)
	if fileID == "" {
		return nil, errors.New("115 playback: empty file ID")
	}
	source := drives.PlaybackSource{ID: "cloud", Label: "兼容播放", Kind: "transcoded", Protocol: "hls", Status: "unavailable", MediaType: "application/vnd.apple.mpegurl", Message: "115 暂未提供该视频的兼容播放源"}
	masterURL, playlist, err := d.fetchHLSMaster(ctx, fileID)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if _, limited := drives.RateLimitRetryAfter(err); limited {
			return nil, err
		}
		if !errors.Is(err, drives.ErrGenerationStreamUnavailable) {
			return nil, err
		}
		return []drives.PlaybackSource{source}, nil
	}
	if _, err := selectHLSVariant(masterURL, string(playlist)); err != nil {
		return []drives.PlaybackSource{source}, nil
	}
	source.Status, source.Message = "ready", ""
	source.Link = p115HLSLink(masterURL)
	source.Relay = &drives.HLSRelay{Playlist: string(playlist), AllowedHosts: []string{".115.com"}}
	return []drives.PlaybackSource{source}, nil
}

var _ drives.PlaybackSourceProvider = (*Driver)(nil)
