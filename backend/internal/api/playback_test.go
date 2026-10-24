package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
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

func TestHLSPlaybackAuthenticatesEveryResourceAndShare(t *testing.T) {
	ctx := context.Background()
	cat, err := catalog.Open(t.TempDir() + "/catalog.db")
	if err != nil {
		t.Fatal(err)
	}
	defer cat.Close()
	now := time.Now()
	if err := cat.UpsertDrive(ctx, &catalog.Drive{ID: "115", Kind: "p115", Name: "115", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"video", "other"} {
		if err := cat.UpsertVideo(ctx, &catalog.Video{ID: id, DriveID: "115", FileID: id, Ext: "mp4", CreatedAt: now, UpdatedAt: now, PublishedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	if err := cat.CreateSession(ctx, "login", time.Hour, createSessionUser(t, cat)); err != nil {
		t.Fatal(err)
	}
	var upstreamCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		if r.URL.Path != "/segment" || r.Header.Get("Cookie") != "" || r.UserAgent() != "fixed-ua" {
			t.Errorf("invalid media request: %s %v", r.URL, r.Header)
		}
		io.WriteString(w, "video-bytes")
	}))
	defer upstream.Close()
	u, _ := url.Parse(upstream.URL)
	d := &apiPlaybackDrive{sources: []drives.PlaybackSource{{ID: "cloud", Label: "兼容播放", Kind: "transcoded", Protocol: "hls", Status: "ready",
		Link:  &drives.StreamLink{URL: upstream.URL + "/master", Headers: http.Header{"User-Agent": {"fixed-ua"}}, Expires: now.Add(time.Minute)},
		Relay: &drives.HLSRelay{Playlist: "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment?signature=private\n#EXT-X-ENDLIST\n", AllowedHosts: []string{u.Host}},
	}}}
	registry := proxy.NewRegistry()
	registry.Set("115", d)
	s := &Server{Catalog: cat, Proxy: proxy.New(registry), shareNow: func() time.Time { return now }}
	router := chi.NewRouter()
	s.RegisterRoutes(router, &auth.Authenticator{Catalog: cat})
	login := &http.Cookie{Name: "vs_admin", Value: "login"}
	request := func(path string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	decode := func(w *httptest.ResponseRecorder) PlaybackManifestDTO {
		t.Helper()
		var manifest PlaybackManifestDTO
		if w.Code != 200 {
			t.Fatalf("metadata=%d %s", w.Code, w.Body.String())
		}
		if err := json.Unmarshal(w.Body.Bytes(), &manifest); err != nil {
			t.Fatal(err)
		}
		return manifest
	}
	manifest := decode(request("/api/video/video/playback", login))
	if d.calls != 0 || manifest.Sources[1].Status != "unknown" {
		t.Fatal("HLS was resolved before selection")
	}
	manifest = decode(request("/api/video/video/playback?source=cloud", login))
	if len(manifest.Sources) != 2 || manifest.Sources[0].URL != "/p/stream/115/video" || manifest.Sources[1].Status != "ready" {
		t.Fatalf("manifest=%+v", manifest)
	}
	root := manifest.Sources[1].URL
	if !strings.HasPrefix(root, "/p/hls/video/") || strings.Contains(root, upstream.URL) {
		t.Fatalf("invalid relay URL %s", root)
	}
	if w := request(root, nil); w.Code != 401 {
		t.Fatalf("unauthenticated master=%d", w.Code)
	}
	w := request(root, login)
	if w.Code != 200 || strings.Contains(w.Body.String(), "signature=private") || upstreamCalls.Load() != 0 {
		t.Fatalf("master=%d %s", w.Code, w.Body.String())
	}
	var segment string
	for _, line := range strings.Split(w.Body.String(), "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			segment = line
		}
	}
	if w := request(segment, nil); w.Code != 401 {
		t.Fatalf("unauthenticated segment=%d", w.Code)
	}
	if w := request(strings.Replace(segment, "/p/hls/video/", "/p/hls/other/", 1), login); w.Code != 404 {
		t.Fatalf("cross-video request=%d", w.Code)
	}
	if w := request(segment+"?signature=attacker", login); w.Code != 200 || w.Body.String() != "video-bytes" {
		t.Fatalf("media=%d %s", w.Code, w.Body.String())
	}

	// A claimed share can resolve and fetch the same source with only its
	// share cookie; none of its rewritten links escape into login-only routes.
	create := httptest.NewRequest("POST", "/api/video/video/share", nil)
	create.AddCookie(login)
	createdRR := httptest.NewRecorder()
	router.ServeHTTP(createdRR, create)
	if createdRR.Code != 201 {
		t.Fatalf("share creation=%d %s", createdRR.Code, createdRR.Body.String())
	}
	var created createVideoShareResponse
	json.Unmarshal(createdRR.Body.Bytes(), &created)
	consumeRR := httptest.NewRecorder()
	router.ServeHTTP(consumeRR, newConsumeShareRequest(strings.TrimPrefix(created.URL, "/share#")))
	if consumeRR.Code != 200 {
		t.Fatalf("share claim=%d %s", consumeRR.Code, consumeRR.Body.String())
	}
	var consumed consumeVideoShareResponse
	json.Unmarshal(consumeRR.Body.Bytes(), &consumed)
	shareCookie := responseCookieByName(t, consumeRR, videoShareCookieName)
	shared := decode(request(consumed.Video.PlaybackURL+"?source=cloud", shareCookie))
	sharedRoot := shared.Sources[1].URL
	if !strings.HasPrefix(sharedRoot, "/p/share/"+consumed.ShareID+"/hls/") {
		t.Fatalf("share escaped its route: %s", sharedRoot)
	}
	if w := request(sharedRoot, nil); w.Code != 404 {
		t.Fatalf("unclaimed HLS=%d", w.Code)
	}
	w = request(sharedRoot, shareCookie)
	for _, line := range strings.Split(w.Body.String(), "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			segment = line
		}
	}
	if w.Code != 200 || !strings.HasPrefix(segment, "/p/share/"+consumed.ShareID+"/hls/") {
		t.Fatalf("invalid shared playlist: %d %s", w.Code, w.Body.String())
	}
	if w := request(segment, shareCookie); w.Code != 200 {
		t.Fatalf("shared media=%d", w.Code)
	}
	now = now.Add(videoShareSessionTTL)
	if w := request(segment, shareCookie); w.Code != 404 {
		t.Fatalf("expired share media=%d", w.Code)
	}
	if err := cat.HideVideo(ctx, "video"); err != nil {
		t.Fatal(err)
	}
	if w := request(root, login); w.Code != 404 {
		t.Fatalf("hidden video master=%d", w.Code)
	}
}
