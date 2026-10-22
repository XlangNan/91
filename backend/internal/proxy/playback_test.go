package proxy

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/video-site/backend/internal/drives"
)

type playbackTestDrive struct {
	drives.Drive
	calls   atomic.Int32
	result  *drives.PlaybackLinks
	started chan struct{}
	unblock chan struct{}
}

func (d *playbackTestDrive) Kind() string { return "wopan" }
func (d *playbackTestDrive) PlaybackLinks(ctx context.Context, _ string) (*drives.PlaybackLinks, error) {
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
	d := &playbackTestDrive{result: &drives.PlaybackLinks{Original: &drives.StreamLink{URL: "https://original.example/video.ts"}}}
	r := NewRegistry()
	r.Set("wo", d)
	p := New(r)
	ctx := context.Background()
	for range 2 {
		if _, err := p.PlaybackLinks(ctx, "wo", "file", false); err != nil {
			t.Fatal(err)
		}
	}
	if d.calls.Load() != 1 {
		t.Fatal("negative result not cached")
	}
	if until := p.playbackCache["wo/file"].until; time.Until(until) > 11*time.Second {
		t.Fatal("negative result cached too long")
	}
	d.result = &drives.PlaybackLinks{HLS: &drives.StreamLink{URL: "https://hls.example/index.m3u8"}}
	links, err := p.PlaybackLinks(ctx, "wo", "file", true)
	if err != nil || links.HLS == nil || d.calls.Load() != 2 {
		t.Fatalf("refresh: links=%+v err=%v calls=%d", links, err, d.calls.Load())
	}
	p.InvalidateDrive("wo")
	if _, err := p.PlaybackLinks(ctx, "wo", "file", false); err != nil {
		t.Fatal(err)
	}
	if d.calls.Load() != 3 {
		t.Fatal("drive invalidation retained playback cache")
	}
}

func TestPlaybackResolutionSurvivesCallerCancellationAndCoalesces(t *testing.T) {
	d := &playbackTestDrive{result: &drives.PlaybackLinks{}, started: make(chan struct{}), unblock: make(chan struct{})}
	r := NewRegistry()
	r.Set("wo", d)
	p := New(r)
	ctx, cancel := context.WithCancel(context.Background())
	first := make(chan error, 1)
	go func() { _, err := p.PlaybackLinks(ctx, "wo", "file", false); first <- err }()
	<-d.started
	cancel()
	if err := <-first; err != context.Canceled {
		t.Fatalf("cancel = %v", err)
	}
	second := make(chan error, 1)
	go func() { _, err := p.PlaybackLinks(context.Background(), "wo", "file", false); second <- err }()
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
		result:  &drives.PlaybackLinks{HLS: &drives.StreamLink{URL: "https://old.example/index.m3u8"}},
		started: make(chan struct{}), unblock: make(chan struct{}),
	}
	registry := NewRegistry()
	registry.Set("wo", old)
	p := New(registry)
	done := make(chan struct{})
	go func() { defer close(done); _, _ = p.PlaybackLinks(context.Background(), "wo", "file", false) }()
	<-old.started
	p.InvalidateDrive("wo")
	fresh := &playbackTestDrive{result: &drives.PlaybackLinks{HLS: &drives.StreamLink{URL: "https://new.example/index.m3u8"}}}
	registry.Set("wo", fresh)
	if _, err := p.PlaybackLinks(context.Background(), "wo", "file", false); err != nil {
		t.Fatal(err)
	}
	close(old.unblock)
	<-done
	links, err := p.PlaybackLinks(context.Background(), "wo", "file", false)
	if err != nil || links.HLS.URL != "https://new.example/index.m3u8" || fresh.calls.Load() != 1 {
		t.Fatalf("stale result replaced current credentials' cache: links=%+v err=%v calls=%d", links, err, fresh.calls.Load())
	}
}
