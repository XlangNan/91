package catalog

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestUndoVideoDeletionPreservesAssetsAcrossSources(t *testing.T) {
	for _, source := range []struct{ id, kind string }{
		{"drive", "webdav"}, {"crawler", "scriptcrawler"},
		{"local-upload", "localupload"}, {TelegramLocalDriveID, "telegramstorage"},
	} {
		t.Run(source.kind, func(t *testing.T) {
			ctx := context.Background()
			cat, err := Open(filepath.Join(t.TempDir(), "catalog.db"))
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = cat.Close() })
			if err := cat.UpsertDrive(ctx, &Drive{ID: source.id, Kind: source.kind, Name: source.id, Status: "ok"}); err != nil {
				t.Fatal(err)
			}
			now := time.Now().Truncate(time.Millisecond)
			video := &Video{
				ID: "undo-video", DriveID: source.id, FileID: "retained.mp4", FileName: "retained.mp4",
				Title: "Original title", Author: "Original author", Size: 4096, DurationSeconds: 42,
				ContentHash: "original-hash", SampledSHA256: "original-sample", FingerprintStatus: "ready",
				ThumbnailURL: "/p/thumb/undo-video", ThumbnailUpdatedAt: now,
				PreviewLocal: "undo-video.mp4", PreviewStatus: "ready", PreviewUpdatedAt: now,
				Views: 7, Likes: 3, PublishedAt: now, CreatedAt: now, UpdatedAt: now,
			}
			if err := cat.UpsertVideo(ctx, video); err != nil {
				t.Fatal(err)
			}
			for _, label := range []string{"surviving", "removed"} {
				if _, err := cat.ensureTag(ctx, label, "user"); err != nil {
					t.Fatal(err)
				}
			}
			if err := cat.SetManualVideoTags(ctx, video.ID, []string{"surviving", "removed"}); err != nil {
				t.Fatal(err)
			}
			if err := cat.DeleteVideoWithTombstoneOptions(ctx, video.ID, DeleteVideoTombstoneOptions{AssetCleanupAfter: now.Add(3 * time.Minute)}); err != nil {
				t.Fatal(err)
			}
			if _, err := cat.db.ExecContext(ctx, `DELETE FROM tags WHERE label = 'removed'`); err != nil {
				t.Fatal(err)
			}
			items, _, err := cat.ListDeletedVideos(ctx, ListParams{Page: 1, PageSize: 10})
			if err != nil || len(items) != 1 || items[0].RestorePolicy != DeletedVideoRestorePolicyDirect {
				t.Fatalf("grace-period restore policy = %#v, %v", items, err)
			}
			result, err := cat.RestoreDeletedVideo(ctx, video.ID, func(string, string) (DeletedVideoSourceInfo, error) {
				t.Fatal("undo unexpectedly inspected a provider")
				return DeletedVideoSourceInfo{}, nil
			})
			if err != nil || result.Video == nil {
				t.Fatalf("undo = %#v, %v", result, err)
			}
			restored := result.Video
			if restored.ThumbnailURL != video.ThumbnailURL || restored.PreviewLocal != video.PreviewLocal ||
				restored.PreviewStatus != "ready" || !restored.PreviewUpdatedAt.Equal(now) || !restored.ThumbnailUpdatedAt.Equal(now) {
				t.Fatalf("asset references changed: %#v", restored)
			}
			if restored.Title != video.Title || restored.Author != video.Author || restored.Views != 7 || restored.Likes != 3 ||
				restored.DurationSeconds != 42 || restored.SampledSHA256 != video.SampledSHA256 || restored.FingerprintStatus != "ready" {
				t.Fatalf("video metadata changed: %#v", restored)
			}
			if !sameStrings(restored.Tags, []string{"surviving"}) || !cat.hasManualTags(ctx, video.ID) {
				t.Fatalf("restored tags = %#v", restored.Tags)
			}
			if err := cat.CleanupDeletedVideoAssets(ctx, video.ID, now.Add(time.Hour), false, func(*Video) error {
				t.Fatal("canceled cleanup removed restored assets")
				return nil
			}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestDeletedVideoAssetCleanupPersistsDeadlineAndRetries(t *testing.T) {
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "catalog.db")
	cat, err := Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cat.Close() })
	now := time.Now()
	deadline := now.Add(3 * time.Minute).Truncate(time.Millisecond)
	video := &Video{ID: "cleanup-video", DriveID: "drive", FileID: "file", Title: "Cleanup",
		PreviewLocal: "custom-preview.mp4", PublishedAt: now, CreatedAt: now, UpdatedAt: now}
	if err := cat.UpsertVideo(ctx, video); err != nil {
		t.Fatal(err)
	}
	if err := cat.DeleteVideoWithTombstoneOptions(ctx, video.ID, DeleteVideoTombstoneOptions{AssetCleanupAfter: deadline}); err != nil {
		t.Fatal(err)
	}
	fail := errors.New("injected removal failure")
	calls := 0
	remove := func(v *Video) error {
		calls++
		if v.ID != video.ID || v.PreviewLocal != video.PreviewLocal {
			t.Fatalf("cleanup snapshot = %#v", v)
		}
		return fail
	}
	if err := cat.CleanupDeletedVideoAssets(ctx, video.ID, deadline.Add(-time.Millisecond), false, remove); err != nil || calls != 0 {
		t.Fatalf("early cleanup calls=%d err=%v", calls, err)
	}
	if err := cat.CleanupDeletedVideoAssets(ctx, video.ID, deadline, false, remove); !errors.Is(err, fail) || calls != 1 {
		t.Fatalf("failed cleanup calls=%d err=%v", calls, err)
	}
	if err := cat.Close(); err != nil {
		t.Fatal(err)
	}
	cat, err = Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := cat.ListExpiredDeletedVideoAssets(ctx, deadline, 10)
	if err != nil || !sameStrings(ids, []string{video.ID}) {
		t.Fatalf("pending after restart = %v, %v", ids, err)
	}
	fail = nil
	if err := cat.CleanupDeletedVideoAssets(ctx, video.ID, deadline, false, remove); err != nil || calls != 2 {
		t.Fatalf("cleanup retry calls=%d err=%v", calls, err)
	}
	ids, err = cat.ListExpiredDeletedVideoAssets(ctx, deadline, 10)
	if err != nil || len(ids) != 0 {
		t.Fatalf("completed cleanup still pending = %v, %v", ids, err)
	}
	if deleted, err := cat.IsVideoDeleted(ctx, video.ID); err != nil || !deleted {
		t.Fatalf("cleanup removed blacklist: deleted=%v, %v", deleted, err)
	}
	if err := cat.CleanupDeletedVideoAssets(ctx, video.ID, deadline, false, remove); err != nil || calls != 2 {
		t.Fatalf("completed cleanup repeated: calls=%d err=%v", calls, err)
	}
}

func TestExpiredDeletionCannotDiscardPendingAssetCleanup(t *testing.T) {
	ctx := context.Background()
	cat, err := Open(filepath.Join(t.TempDir(), "catalog.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cat.Close() })
	now := time.Now()
	video := &Video{ID: "expired", DriveID: "drive", FileID: "file", Title: "Expired", PublishedAt: now, CreatedAt: now, UpdatedAt: now}
	if err := cat.UpsertVideo(ctx, video); err != nil {
		t.Fatal(err)
	}
	if err := cat.DeleteVideoWithTombstoneOptions(ctx, video.ID, DeleteVideoTombstoneOptions{AssetCleanupAfter: now.Add(-time.Second)}); err != nil {
		t.Fatal(err)
	}
	if _, err := cat.RestoreDeletedVideo(ctx, video.ID, nil); !errors.Is(err, ErrDeletedVideoAssetCleanupRequired) {
		t.Fatalf("restore discarded pending cleanup: %v", err)
	}
	if err := cat.CleanupDeletedVideoAssets(ctx, video.ID, now, false, func(*Video) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err := cat.RestoreDeletedVideo(ctx, video.ID, nil); err != nil {
		t.Fatalf("restore after cleanup: %v", err)
	}
}

func TestUndoVideoDeletionRollsBackWithCleanupPlan(t *testing.T) {
	ctx := context.Background()
	cat, err := Open(filepath.Join(t.TempDir(), "catalog.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cat.Close() })
	now := time.Now()
	video := &Video{ID: "atomic-undo", DriveID: "drive", FileID: "file", Title: "Atomic", PublishedAt: now, CreatedAt: now, UpdatedAt: now}
	if err := cat.UpsertVideo(ctx, video); err != nil {
		t.Fatal(err)
	}
	deadline := now.Add(3 * time.Minute)
	if err := cat.DeleteVideoWithTombstoneOptions(ctx, video.ID, DeleteVideoTombstoneOptions{AssetCleanupAfter: deadline}); err != nil {
		t.Fatal(err)
	}
	if _, err := cat.db.Exec(`CREATE TRIGGER reject_undo BEFORE DELETE ON deleted_videos BEGIN SELECT RAISE(ABORT, 'injected failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := cat.RestoreDeletedVideo(ctx, video.ID, nil); err == nil {
		t.Fatal("undo unexpectedly succeeded")
	}
	if _, err := cat.GetVideo(ctx, video.ID); err == nil {
		t.Fatal("failed undo published a video")
	}
	ids, err := cat.ListExpiredDeletedVideoAssets(ctx, deadline, 10)
	if err != nil || !sameStrings(ids, []string{video.ID}) {
		t.Fatalf("failed undo lost cleanup: %v, %v", ids, err)
	}
}
