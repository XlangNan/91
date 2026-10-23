package proxy

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/video-site/backend/internal/drives"
)

type playbackTestDrive struct {
	drives.Drive
	calls   atomic.Int32
	result  []drives.PlaybackSource
	started chan struct{}
	unblock chan struct{}
}

func (d *playbackTestDrive) Kind() string { return "wopan" }
func (d *playbackTestDrive) PlaybackSources(ctx context.Context, _ string) ([]drives.PlaybackSource, error) {
	if d.calls.Add(1) == 1 && d.started != nil {
		close(d.started)
	}
	if d.unblock != nil {
		select {
		case <-d.unblock:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return d.result, nil
}

func TestPlaybackCacheNegativeRefreshAndDriveInvalidation(t *testing.T) {
	d := &playbackTestDrive{result: []drives.PlaybackSource{{ID: "cloud", Status: "unavailable"}}}
	r := NewRegistry()
	r.Set("wo", d)
	p := New(r)
	ctx := context.Background()
	for range 2 {
		if _, err := p.PlaybackSources(ctx, "wo", "file", false); err != nil {
			t.Fatal(err)
		}
	}
	if d.calls.Load() != 1 {
		t.Fatal("negative result not cached")
	}
	if until := p.playbackCache["wo/file"].until; time.Until(until) > 11*time.Second {
		t.Fatal("negative result cached too long")
	}
	d.result = testCloudSources("https://hls.example/index.m3u8")
	links, err := p.PlaybackSources(ctx, "wo", "file", true)
	if err != nil || links[0].Link == nil || d.calls.Load() != 2 {
		t.Fatalf("refresh: links=%+v err=%v calls=%d", links, err, d.calls.Load())
	}
	p.InvalidateDrive("wo")
	if _, err := p.PlaybackSources(ctx, "wo", "file", false); err != nil {
		t.Fatal(err)
	}
	if d.calls.Load() != 3 {
		t.Fatal("drive invalidation retained playback cache")
	}
}

func TestPlaybackResolutionSurvivesCallerCancellationAndCoalesces(t *testing.T) {
	d := &playbackTestDrive{result: []drives.PlaybackSource{}, started: make(chan struct{}), unblock: make(chan struct{})}
	r := NewRegistry()
	r.Set("wo", d)
	p := New(r)
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := p.PlaybackSources(ctx, "wo", "file", false); first <- err }()
	<-d.started
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatalf("cancel = %v", err)
	}
	second := make(chan error, 1)
	go func() { _, err := p.PlaybackSources(context.Background(), "wo", "file", false); second <- err }()
	close(d.unblock)
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if d.calls.Load() != 1 {
		t.Fatalf("provider calls = %d", d.calls.Load())
	}
}

func TestPlaybackInvalidationDiscardsAnOlderDriversInflightResult(t *testing.T) {
	old := &playbackTestDrive{
		result:  testCloudSources("https://old.example/index.m3u8"),
		started: make(chan struct{}), unblock: make(chan struct{}),
	}
	registry := NewRegistry()
	registry.Set("wo", old)
	p := New(registry)
	done := make(chan struct{})
	go func() { defer close(done); _, _ = p.PlaybackSources(context.Background(), "wo", "file", false) }()
	<-old.started
	p.InvalidateDrive("wo")
	fresh := &playbackTestDrive{result: testCloudSources("https://new.example/index.m3u8")}
	registry.Set("wo", fresh)
	if _, err := p.PlaybackSources(context.Background(), "wo", "file", false); err != nil {
		t.Fatal(err)
	}
	close(old.unblock)
	<-done
	links, err := p.PlaybackSources(context.Background(), "wo", "file", false)
	if err != nil || links[0].Link.URL != "https://new.example/index.m3u8" || fresh.calls.Load() != 1 {
		t.Fatalf("stale result replaced current credentials' cache: links=%+v err=%v calls=%d", links, err, fresh.calls.Load())
	}
}

func testCloudSources(url string) []drives.PlaybackSource {
	return []drives.PlaybackSource{{ID: "cloud", Kind: "transcoded", Protocol: "hls", Status: "ready", Link: &drives.StreamLink{URL: url}}}
}

type playbackOriginalDrive struct {
	drives.Drive
	calls map[string]int
}

func (*playbackOriginalDrive) Kind() string { return "p115" }
func (d *playbackOriginalDrive) StreamURLWithHeader(_ context.Context, fileID string, header http.Header) (*drives.StreamLink, error) {
	d.calls[fileID+"/"+header.Get("User-Agent")]++
	return &drives.StreamLink{URL: "https://original.example/" + fileID, Expires: time.Now().Add(time.Hour)}, nil
}

func TestOriginalRefreshInvalidatesOnlyTheViewersFileAndUserAgent(t *testing.T) {
	d := &playbackOriginalDrive{calls: make(map[string]int)}
	registry := NewRegistry()
	registry.Set("drive", d)
	p := New(registry)
	ctx := context.Background()
	a := http.Header{"User-Agent": {"browser-a"}}
	b := http.Header{"User-Agent": {"browser-b"}}
	warm := func(file string, header http.Header) {
		t.Helper()
		if err := p.WarmStreamLink(ctx, "drive", file, header); err != nil {
			t.Fatal(err)
		}
	}
	warm("one", a)
	warm("one", b)
	warm("two", a)
	p.InvalidateStreamLink("drive", "one", a)
	warm("one", a)
	warm("one", b)
	warm("two", a)
	if d.calls["one/browser-a"] != 2 || d.calls["one/browser-b"] != 1 || d.calls["two/browser-a"] != 1 {
		t.Fatalf("refresh affected unrelated links: %+v", d.calls)
	}
}
