package yun139

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"
)

// Opt in only when someone is available to scan and approve the QR code. No
// account credentials or directory names are printed or written to disk.
func TestQRLoginLive(t *testing.T) {
	if os.Getenv("YUN139_QR_LIVE") != "1" {
		t.Skip("set YUN139_QR_LIVE=1 and YUN139_QR_LIVE_IMAGE to verify with a phone")
	}
	imagePath := os.Getenv("YUN139_QR_LIVE_IMAGE")
	if imagePath == "" {
		t.Fatal("YUN139_QR_LIVE_IMAGE is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), qrSessionTTL+time.Minute)
	defer cancel()
	client := NewQRClient(QRConfig{})
	session, err := client.Generate(ctx)
	if err != nil {
		t.Fatal(err)
	}
	png, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(session.QRImageDataURL, "data:image/png;base64,"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imagePath, png, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("QR image: %s; expires: %s", imagePath, session.ExpiresAt)
	previous := ""
	for {
		status, err := client.Poll(ctx, session.SessionID)
		if err != nil {
			t.Fatal(err)
		}
		if status.State != previous {
			t.Logf("QR state: %s", status.State)
			previous = status.State
		}
		switch status.State {
		case "success":
			drive := New(Config{ID: "qr-live", Authorization: status.Authorization})
			if err := drive.Init(ctx); err != nil {
				t.Fatal(err)
			}
			entries, err := drive.List(ctx, drive.RootID())
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("Authorization accepted; personal root listing returned %d entries", len(entries))
			return
		case "expired", "canceled", "error":
			t.Fatalf("QR login ended: %s", status.State)
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(2 * time.Second):
		}
	}
}
