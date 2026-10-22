package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/video-site/backend/internal/auth"
	"github.com/video-site/backend/internal/catalog"
	"github.com/video-site/backend/internal/drives"
	"github.com/video-site/backend/internal/proxy"
)

type apiPlaybackDrive struct {
	drives.Drive
	links *drives.PlaybackLinks
	err   error
}

func (d *apiPlaybackDrive) Kind() string { return "wopan" }
func (d *apiPlaybackDrive) PlaybackLinks(context.Context, string) (*drives.PlaybackLinks, error) {
	return d.links, d.err
}

func TestPlaybackRouteSelectionAndAuthentication(t *testing.T) {
	ctx := context.Background()
	cat, err := catalog.Open(t.TempDir() + "/catalog.db")
	if err != nil {
		t.Fatal(err)
	}
	defer cat.Close()
	now := time.Now()
	if err := cat.UpsertDrive(ctx, &catalog.Drive{ID: "wo", Kind: "wopan", Name: "Wo", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	for _, ext := range []string{"ts", "mp4"} {
		if err := cat.UpsertVideo(ctx, &catalog.Video{ID: ext, DriveID: "wo", FileID: ext, Ext: ext, CreatedAt: now, UpdatedAt: now, PublishedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err := cat.CreateSession(ctx, "login", time.Hour, createSessionUser(t, cat)); err != nil {
		t.Fatal(err)
	}
	media := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("playback resolution fetched media bytes") }))
	defer media.Close()
	link := func(path string) *drives.StreamLink {
		return &drives.StreamLink{URL: media.URL + path, ClientRedirectSafe: true}
	}
	d := &apiPlaybackDrive{}
	registry := proxy.NewRegistry()
	registry.Set("wo", d)
	s := &Server{Catalog: cat, Proxy: proxy.New(registry)}
	router := chi.NewRouter()
	s.RegisterRoutes(router, &auth.Authenticator{Catalog: cat})
	unauth := httptest.NewRecorder()
	router.ServeHTTP(unauth, httptest.NewRequest("GET", "/api/video/ts/playback", nil))
	if unauth.Code != 401 {
		t.Fatalf("unauth status %d", unauth.Code)
	}
	for _, tt := range []struct {
		name, ext, want string
		hls             bool
		err             error
	}{
		{"ts HLS", "ts", "hls", true, nil}, {"ts unavailable", "ts", "unavailable", false, nil}, {"mp4 original", "mp4", "native", false, nil}, {"mp4 HLS fallback", "mp4", "hls", true, nil}, {"expired login", "ts", "", false, errors.New("request failed with rsp_code: 1001,rep_desc: 无效登录信息")},
	} {
		t.Run(tt.name, func(t *testing.T) {
			d.links = &drives.PlaybackLinks{Original: link("/original." + tt.ext)}
			d.err = tt.err
			if tt.hls {
				d.links.HLS = link("/index.m3u8")
			}
			req := httptest.NewRequest("GET", "/api/video/"+tt.ext+"/playback?refresh=1", nil)
			req.AddCookie(&http.Cookie{Name: "vs_admin", Value: "login"})
			rr := httptest.NewRecorder()
			router.ServeHTTP(rr, req)
			if tt.err != nil {
				var r struct {
					Code string `json:"code"`
				}
				_ = json.Unmarshal(rr.Body.Bytes(), &r)
				if rr.Code != 502 || r.Code != "drive_auth_failed" {
					t.Fatalf("auth response=%d %s", rr.Code, rr.Body.String())
				}
				return
			}
			var source PlaybackSourceDTO
			if err := json.Unmarshal(rr.Body.Bytes(), &source); err != nil {
				t.Fatal(err)
			}
			if source.Type != tt.want {
				t.Fatalf("source=%+v", source)
			}
			if tt.ext == "ts" && source.Fallback != nil {
				t.Fatal("TS must not fall back to raw bytes")
			}
			if tt.hls && tt.ext == "mp4" && (source.Fallback == nil || source.Fallback.Type != "native") {
				t.Fatal("MP4 fallback missing")
			}
			if rr.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("signed metadata must not be HTTP cached")
			}
		})
	}
}
