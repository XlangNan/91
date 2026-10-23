package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
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
	sources []drives.PlaybackSource
	err     error
	calls   int
}

func (d *apiPlaybackDrive) Kind() string { return "wopan" }
func (d *apiPlaybackDrive) PlaybackSources(context.Context, string) ([]drives.PlaybackSource, error) {
	d.calls++
	return d.sources, d.err
}

func TestPlaybackManifestAndLazyCloudResolution(t *testing.T) {
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
	media := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("metadata fetched media bytes") }))
	defer media.Close()
	d := &apiPlaybackDrive{err: errors.New("preview unavailable")}
	registry := proxy.NewRegistry()
	registry.Set("wo", d)
	s := &Server{Catalog: cat, Proxy: proxy.New(registry)}
	router := chi.NewRouter()
	s.RegisterRoutes(router, &auth.Authenticator{Catalog: cat})
	request := func(path string, authorized bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", path, nil)
		if authorized {
			req.AddCookie(&http.Cookie{Name: "vs_admin", Value: "login"})
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}
	decode := func(rr *httptest.ResponseRecorder) PlaybackManifestDTO {
		t.Helper()
		var manifest PlaybackManifestDTO
		if rr.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", rr.Code, rr.Body.String())
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &manifest); err != nil {
			t.Fatal(err)
		}
		if rr.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("metadata must not be HTTP cached")
		}
		return manifest
	}
	for _, path := range []string{"/api/video/ts/playback", "/api/video/ts/playback?source=cloud"} {
		if rr := request(path, false); rr.Code != http.StatusUnauthorized {
			t.Fatalf("unauth status=%d", rr.Code)
		}
	}
	for _, ext := range []string{"ts", "mp4"} {
		manifest := decode(request("/api/video/"+ext+"/playback", true))
		if len(manifest.Sources) != 2 || manifest.Sources[0].ID != "original" || manifest.Sources[0].URL != "/p/stream/wo/"+ext || manifest.Sources[1].Status != "unknown" || !strings.HasSuffix(manifest.Sources[1].ResolveURL, "?source=cloud") {
			t.Fatalf("manifest=%+v", manifest)
		}
		decode(request("/api/video/"+ext+"/playback?source=original&refresh=1", true))
	}
	if d.calls != 0 {
		t.Fatal("original playback waited for cloud resolution")
	}
	for _, tc := range []struct {
		name, status string
		link         *drives.StreamLink
	}{
		{"ready", "ready", &drives.StreamLink{URL: media.URL + "/index.m3u8", ClientRedirectSafe: true, Expires: now.Add(time.Minute)}},
		{"processing", "processing", nil},
		{"unavailable", "unavailable", nil},
		{"secret headers", "ready", &drives.StreamLink{URL: media.URL + "/index.m3u8", ClientRedirectSafe: true, Headers: http.Header{"Cookie": {"account-secret"}}}},
		{"unsafe credentials", "ready", &drives.StreamLink{URL: "https://account-secret@example.com/index.m3u8", ClientRedirectSafe: true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d.err = nil
			d.sources = []drives.PlaybackSource{{ID: "cloud", Label: "兼容播放", Kind: "transcoded", Protocol: "hls", Status: tc.status, Link: tc.link}}
			manifest := decode(request("/api/video/ts/playback?source=cloud&refresh=1", true))
			if len(manifest.Sources) != 2 || manifest.Sources[0].URL != "/p/stream/wo/ts" {
				t.Fatalf("cloud removed original: %+v", manifest)
			}
			cloud := manifest.Sources[1]
			want := tc.status
			if strings.HasPrefix(tc.name, "secret") || strings.HasPrefix(tc.name, "unsafe") {
				want = "unavailable"
			}
			if cloud.Status != want {
				t.Fatalf("cloud=%+v", cloud)
			}
			if want != "ready" && cloud.URL != "" {
				t.Fatal("unavailable link exposed")
			}
			if strings.Contains(request("/api/video/ts/playback", true).Body.String(), "account-secret") {
				t.Fatal("account credential leaked")
			}
		})
	}
	d.err = errors.New("request failed with rsp_code: 1001,rep_desc: 无效登录信息")
	if rr := request("/api/video/ts/playback?source=cloud&refresh=1", true); rr.Code != 502 || !strings.Contains(rr.Body.String(), "drive_auth_failed") {
		t.Fatalf("provider error lost: %d %s", rr.Code, rr.Body.String())
	}
	decode(request("/api/video/ts/playback", true))
	if rr := request("/api/video/mp4/playback?source=missing", true); rr.Code != 400 {
		t.Fatalf("invalid source status=%d", rr.Code)
	}
	registry.Set("wo", &apiOriginalOnlyDrive{})
	manifest := decode(request("/api/video/mp4/playback", true))
	if len(manifest.Sources) != 1 || manifest.Sources[0].ID != "original" {
		t.Fatalf("original-only drive=%+v", manifest)
	}
}

type apiOriginalOnlyDrive struct{ drives.Drive }

func (*apiOriginalOnlyDrive) Kind() string { return "webdav" }
