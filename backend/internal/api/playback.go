package api

import (
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/video-site/backend/internal/catalog"
	"github.com/video-site/backend/internal/drives"
)

type PlaybackSourceDTO struct {
	Type      string             `json:"type"`
	URL       string             `json:"url,omitempty"`
	MediaType string             `json:"mediaType,omitempty"`
	Message   string             `json:"message,omitempty"`
	Fallback  *PlaybackSourceDTO `json:"fallback,omitempty"`
}

func playbackURL(videoID string) string { return "/api/video/" + pathSegment(videoID) + "/playback" }

func (s *Server) handleVideoPlayback(w http.ResponseWriter, r *http.Request) {
	v, err := s.availableVideo(r.Context(), routeParam(r, "id"))
	if err != nil {
		writeCatalogLookupError(w, r, err)
		return
	}
	s.servePlaybackMetadata(w, r, v, s.videoSource(v))
}

func (s *Server) handleSharedVideoPlayback(w http.ResponseWriter, r *http.Request) {
	v, ok := s.activeSharedVideo(w, r)
	if !ok {
		return
	}
	s.servePlaybackMetadata(w, r, v, sharedAssetURL(routeParam(r, "shareID"), "stream", time.Time{}))
}

func (s *Server) servePlaybackMetadata(w http.ResponseWriter, r *http.Request, v *catalog.Video, originalURL string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	original := &PlaybackSourceDTO{Type: "native", URL: originalURL, MediaType: playbackMediaType(v)}
	if s.Proxy == nil || v.DriveID == localUploadDriveID || v.DriveID == catalog.TelegramLocalDriveID {
		writeJSON(w, http.StatusOK, original)
		return
	}
	links, err := s.Proxy.PlaybackLinks(r.Context(), v.DriveID, v.FileID, r.URL.Query().Get("refresh") == "1")
	if err != nil {
		s.Proxy.WritePlaybackError(w, v.DriveID, err)
		return
	}
	if links == nil {
		writeJSON(w, http.StatusOK, original)
		return
	}
	if links.Original != nil && safePlaybackLink(links.Original) {
		original.URL = links.Original.URL
	} else {
		original = nil
	}
	ext := strings.ToLower(strings.TrimPrefix(v.Ext, "."))
	if ext == "ts" || ext == "mts" || ext == "m2ts" {
		original = nil
	}
	if links.HLS != nil && safePlaybackLink(links.HLS) {
		writeJSON(w, http.StatusOK, &PlaybackSourceDTO{Type: "hls", URL: links.HLS.URL, MediaType: "application/vnd.apple.mpegurl", Fallback: original})
		return
	}
	if original != nil {
		writeJSON(w, http.StatusOK, original)
		return
	}
	label := s.videoSourceLabel(r.Context(), v)
	if label == "" {
		label = "网盘"
	}
	writeJSON(w, http.StatusOK, &PlaybackSourceDTO{Type: "unavailable", Message: label + "暂未提供该视频的 HLS 播放源，请稍后重新获取"})
}

func safePlaybackLink(link *drives.StreamLink) bool {
	u, err := url.Parse(link.URL)
	return link.ClientRedirectSafe && len(link.Headers) == 0 && err == nil && u.Host != "" && u.User == nil && (u.Scheme == "https" || u.Scheme == "http")
}
