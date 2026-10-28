package telegramupload

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

)

func TestTransferRejectsInvalidProxyBeforeChangingStorage(t *testing.T) {
	cfg, v, cloud := fixture(t)
	cfg.UploadProxy = "ftp://user:private_password@proxy.example"
	err := Run(context.Background(), cfg)
	if err == nil || strings.Contains(err.Error(), "private_password") || cloud.uploads != 0 {
		t.Fatalf("expected sanitized invalid proxy error: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cfg.LocalDirectory, v.FileID)); err != nil {
		t.Fatal("invalid proxy removed local file")
	}
}
