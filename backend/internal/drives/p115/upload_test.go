package p115

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	sdk "github.com/SheltonZhu/115driver/pkg/driver"
)

func TestUploadAppVersionResponseHandling(t *testing.T) {
	const versionBody = `{"state":true,"error":"","data":{"win":{"version_code":"36.0.1"}}}`
	tests := []struct {
		name        string
		contentType string
		body        string
		status      int
		wantVersion string
	}{
		{"JSON", "application/json", versionBody, http.StatusOK, "36.0.1"},
		{"JSON labeled as HTML", "text/html; charset=UTF-8", versionBody, http.StatusOK, "36.0.1"},
		{"JSON labeled as plain text", "text/plain", versionBody, http.StatusOK, "36.0.1"},
		{"JSON without content type", "", versionBody, http.StatusOK, "36.0.1"},
		{"HTML error page", "text/html", "<html>unavailable</html>", http.StatusOK, p115UploadFallbackAppVersion},
		{"missing version", "text/html", `{"state":true,"data":{}}`, http.StatusOK, p115UploadFallbackAppVersion},
		{"HTTP error", "text/html", versionBody, http.StatusServiceUnavailable, p115UploadFallbackAppVersion},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			d := New(Config{ID: "115"})
			d.client = sdk.New(sdk.WithClient(&http.Client{Transport: p115RoundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != http.MethodGet || r.URL.String() != sdk.ApiGetVersion {
					t.Fatalf("unexpected request: %s %s", r.Method, r.URL)
				}
				return &http.Response{
					StatusCode: tt.status,
					Header:     http.Header{"Content-Type": {tt.contentType}},
					Body:       io.NopCloser(strings.NewReader(tt.body)),
					Request:    r,
				}, nil
			})}))

			for i := 0; i < 2; i++ {
				version, err := d.p115UploadAppVersionFor(context.Background())
				if err != nil || version != tt.wantVersion {
					t.Fatalf("version = %q, error = %v, want %q without error", version, err, tt.wantVersion)
				}
			}
			if calls != 1 {
				t.Fatalf("version requests = %d, want one cached lookup", calls)
			}
		})
	}
}

func TestParseP115UploadCallbackReturnsExactFileID(t *testing.T) {
	body := []byte(`{"state":true,"data":{"file_id":"file-exact","sha1":"abcdef"}}`)
	fileID, err := parseP115UploadCallback(body, "ABCDEF")
	if err != nil {
		t.Fatalf("parse callback: %v", err)
	}
	if fileID != "file-exact" {
		t.Fatalf("file ID = %q, want file-exact", fileID)
	}
}

func TestParseP115UploadCallbackRejectsMismatchedSHA1(t *testing.T) {
	body := []byte(`{"state":true,"data":{"file_id":"file-wrong","sha1":"AAAA"}}`)
	_, err := parseP115UploadCallback(body, "BBBB")
	if err == nil || !strings.Contains(err.Error(), "SHA1 mismatch") {
		t.Fatalf("error = %v, want SHA1 mismatch", err)
	}
	if errors.Is(err, errP115UploadResultUnavailable) {
		t.Fatalf("SHA1 mismatch must not be treated as an unavailable callback: %v", err)
	}
}

func TestParseP115UploadCallbackMarksUnavailableResults(t *testing.T) {
	tests := []struct {
		name string
		body []byte
	}{
		{name: "empty", body: nil},
		{name: "malformed", body: []byte(`{"state":`)},
		{name: "missing file ID", body: []byte(`{"state":true,"data":{"sha1":"ABC"}}`)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := parseP115UploadCallback(tt.body, "ABC")
			if !errors.Is(err, errP115UploadResultUnavailable) {
				t.Fatalf("error = %v, want result unavailable", err)
			}
		})
	}
}
