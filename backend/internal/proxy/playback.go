package proxy

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/video-site/backend/internal/drives"
)

type cachedPlayback struct {
	links *drives.PlaybackLinks
	until time.Time
}

type playbackCall struct {
	done  chan struct{}
	once  sync.Once
	links *drives.PlaybackLinks
	err   error
}

// PlaybackLinks resolves metadata only. A nil result means this drive uses the
// existing original-file playback route. Refresh bypasses cache, not inflight
// work, so simultaneous user retries still share one provider request.
func (p *Proxy) PlaybackLinks(ctx context.Context, driveID, fileID string, refresh bool) (*drives.PlaybackLinks, error) {
	d, ok := p.Registry.Get(driveID)
	if !ok {
		if failure, found := p.driveInitError(driveID); found {
			return nil, failure.err
		}
		return nil, errDriveNotFound
	}
	provider, ok := d.(drives.PlaybackSourceProvider)
	if !ok {
		return nil, nil
	}
	key := driveID + "/" + fileID
	p.cacheMu.Lock()
	if c, found := p.playbackCache[key]; found {
		if !refresh && time.Now().Before(c.until) {
			p.cacheMu.Unlock()
			return c.links, nil
		}
		delete(p.playbackCache, key)
	}
	call := p.playbackInflight[key]
	if call == nil {
		call = &playbackCall{done: make(chan struct{})}
		p.playbackInflight[key] = call
		deadline := p.resolveTimeout
		if deadline <= 0 {
			deadline = linkResolveTimeout
		}
		resolveCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), deadline)
		finish := func(links *drives.PlaybackLinks, err error) {
			call.once.Do(func() {
				p.cacheMu.Lock()
				defer p.cacheMu.Unlock()
				call.links, call.err = links, err
				if p.playbackInflight[key] == call {
					delete(p.playbackInflight, key)
					if err == nil && links != nil {
						now := time.Now()
						ttl := 2 * time.Minute
						if links.HLS == nil {
							ttl = 10 * time.Second
						}
						until := now.Add(ttl)
						for _, link := range []*drives.StreamLink{links.HLS, links.Original} {
							if link != nil && !link.Expires.IsZero() && link.Expires.Before(until) {
								until = link.Expires
							}
						}
						for k, c := range p.playbackCache {
							if now.After(c.until) {
								delete(p.playbackCache, k)
							}
						}
						if len(p.playbackCache) >= linkCacheMaxEntries {
							for k := range p.playbackCache {
								delete(p.playbackCache, k)
								break
							}
						}
						p.playbackCache[key] = cachedPlayback{links: links, until: until}
					}
				}
				close(call.done)
			})
		}
		go func() {
			defer cancel()
			links, err := provider.PlaybackLinks(resolveCtx, fileID)
			if err == nil && links == nil {
				err = fmt.Errorf("provider returned empty playback metadata")
			}
			if resolveCtx.Err() != nil {
				err = resolveCtx.Err()
			}
			finish(links, err)
		}()
		go func() { <-resolveCtx.Done(); finish(nil, resolveCtx.Err()) }()
	}
	p.cacheMu.Unlock()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-call.done:
		if call.err == nil {
			p.reportStreamResult(driveID, nil)
		}
		return call.links, call.err
	}
}

func (p *Proxy) WritePlaybackError(w http.ResponseWriter, driveID string, err error) {
	kind := ""
	if d, ok := p.Registry.Get(driveID); ok {
		kind = d.Kind()
	} else if failure, ok := p.driveInitError(driveID); ok {
		kind = failure.kind
	}
	if !errors.Is(err, context.Canceled) && streamErrorAffectsDrive(err) {
		p.reportStreamResult(driveID, err)
	}
	writeStreamError(w, kind, err)
}

// Provider playback prewarming belongs to the active/next frontend element,
// rather than a feed response that can contain many never-played videos.
func (p *Proxy) HasPlaybackProvider(driveID string) bool {
	d, ok := p.Registry.Get(driveID)
	if !ok {
		return false
	}
	_, ok = d.(drives.PlaybackSourceProvider)
	return ok
}
