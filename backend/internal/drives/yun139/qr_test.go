package yun139

import (
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// Independently generated with Node crypto: AES-256-CBC envelope, then a hex
// AES-128-ECB credential containing the official account/token fields.
const qrWaitingFixture = "AAECAwQFBgcICQoLDA0ODx9dG6hMxPuVmOKxluFyplMyl1XP7Rv7P6cbBOqB+M49IjEMCiuga0aOn/Zsqbv2hzkgsEmekXKwvyPW+QGvXGjj1TlONAka3PmePfhyTuyL30ML/IKRUcohNyKYZnHouQ=="
const qrSuccessFixture = "AAECAwQFBgcICQoLDA0OD0sFYjzKFiap0sbGgzrqOHOV6hf41kWgHIzhs2OhZytVe+RE3tXgFdluIniao826E7yF4SqCc4XVEoxidogKtQRmMB+K5Hf8ssXTadibFX2KYpDQKKPaNAdgTUghD/h5mwWSLbZOfnIa0SunfSV4KgcB0ocRTFa6j54y8KIs158dZudzvMTvLACTM+MPOsVuCpI94ok8R/4mBHuJqK7kR5IW4ASwjnr9/KJCuT1NfS4wmzNw6pFj0LNDERQ/GEnKgf+D3CpbTA92RCYOTQWfx3lg8b3STdMhrTvB85YarbVCm3inhaDG5VFdWzR1r83BTQ=="

type qrRoundTripper func(*http.Request) (*http.Response, error)

func (f qrRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func qrResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}
}

func qrTestNow() time.Time { return time.Date(2026, 10, 23, 12, 0, 0, 0, time.UTC) }

func TestQRGenerateUsesOfficialLoginURLAndDistinctDevices(t *testing.T) {
	client := NewQRClient(QRConfig{Now: qrTestNow, HTTPClient: &http.Client{Transport: qrRoundTripper(func(*http.Request) (*http.Response, error) {
		t.Error("QR generation must not need a mounted account or an upstream request")
		return nil, errors.New("unexpected request")
	})}})
	first, err := client.Generate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := client.Generate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	devices := map[string]bool{}
	for _, session := range []QRCodeSession{first, second} {
		parsed, err := url.Parse(session.QRCodeURL)
		if err != nil || parsed.Host != "yun.139.com" || parsed.Path != "/w/" || !strings.HasPrefix(parsed.Fragment, "/qrcLogin?") {
			t.Fatalf("QR URL = %s, %v", session.QRCodeURL, err)
		}
		params, _ := url.ParseQuery(strings.TrimPrefix(parsed.Fragment, "/qrcLogin?"))
		if params.Get("sID") != session.SessionID || len(session.SessionID) != 16 || len(params.Get("dID")) != 32 || params.Get("cType") != "9" {
			t.Fatalf("QR parameters = %v", params)
		}
		devices[params.Get("dID")] = true
		png, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(session.QRImageDataURL, "data:image/png;base64,"))
		if err != nil || !strings.HasPrefix(string(png), "\x89PNG\r\n\x1a\n") {
			t.Fatal("QR image is not PNG")
		}
		if session.ExpiresAt != qrTestNow().Add(5*time.Minute).Format(time.RFC3339) {
			t.Fatalf("expiry = %s", session.ExpiresAt)
		}
	}
	if first.SessionID == second.SessionID || len(devices) != 2 {
		t.Fatal("QR sessions reused identifiers")
	}
}

func TestQRWaitingScannedAndEncryptedSuccess(t *testing.T) {
	responses := []string{qrWaitingFixture, `{"success":false,"code":"200059548","data":null}`, qrSuccessFixture}
	var calls atomic.Int32
	var session QRCodeSession
	client := NewQRClient(QRConfig{Now: qrTestNow, HTTPClient: &http.Client{Transport: qrRoundTripper(func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost || r.URL.String() != qrLoginURL {
			t.Errorf("request = %s %s", r.Method, r.URL)
		}
		encoded, _ := io.ReadAll(r.Body)
		plain, err := decryptQREnvelope(encoded)
		if err != nil {
			t.Error(err)
			return nil, err
		}
		var body struct {
			Session    string `json:"dycpwd"`
			ClientType int    `json:"clienttype"`
			CPID       int    `json:"cpid"`
			PinType    int    `json:"pintype"`
			SecInfo    string `json:"secinfo"`
		}
		_ = json.Unmarshal(plain, &body)
		hash := sha1.Sum([]byte("fetion.com.cn:" + session.SessionID))
		if body.Session != session.SessionID || body.ClientType != 670 || body.CPID != 292 || body.PinType != 21 || body.SecInfo != strings.ToUpper(hex.EncodeToString(hash[:])) {
			t.Errorf("wrong web QR login payload: %+v", body)
		}
		parts := strings.Split(r.Header.Get("Mcloud-Sign"), ",")
		if len(parts) != 3 || signature(plain, parts[0], parts[1]) != parts[2] {
			t.Error("did not sign plaintext before encryption")
		}
		params, _ := url.ParseQuery(strings.SplitN(session.QRCodeURL, "?", 2)[1])
		if !strings.Contains(r.Header.Get("X-DeviceInfo"), "|"+params.Get("dID")+"|") || r.Header.Get("Hcy-Cool-Flag") != "1" {
			t.Error("missing device identity or encryption flag")
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Error("QR request leaked mounted credentials")
		}
		return qrResponse(200, responses[int(calls.Add(1))-1]), nil
	})}})
	var err error
	session, err = client.Generate(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"waiting", "scanned", "success"} {
		got, err := client.Poll(context.Background(), session.SessionID)
		if err != nil || got.State != state {
			t.Fatalf("Poll = %+v, %v; want %s", got, err, state)
		}
		if state != "success" && got.Authorization != "" {
			t.Fatal("returned authorization before approval")
		}
		if state == "success" {
			prefix, account, token, _, err := parseAuthorization(got.Authorization)
			if err != nil || prefix != "pc" || account != "13800000000" || token != "one|two|three|1893456000000" {
				t.Fatalf("invalid credential exchange: %v", err)
			}
		}
	}
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			got, err := client.Poll(context.Background(), session.SessionID)
			if err != nil || got.State != "success" || got.Authorization == "" {
				t.Errorf("cached success lost: %v", err)
			}
		})
	}
	wg.Wait()
	if calls.Load() != 3 {
		t.Fatalf("approval was exchanged repeatedly: calls=%d", calls.Load())
	}
}

func TestQRExpiryCancellationAndTerminalFailures(t *testing.T) {
	for code, state := range map[string]string{"200059542": "expired", "200059549": "canceled", "200059543": "error", "200059545": "error", "200059546": "error", "200059547": "error"} {
		t.Run(code, func(t *testing.T) {
			calls := 0
			client := NewQRClient(QRConfig{HTTPClient: &http.Client{Transport: qrRoundTripper(func(*http.Request) (*http.Response, error) {
				calls++
				return qrResponse(200, `{"code":"`+code+`","data":null}`), nil
			})}})
			session, _ := client.Generate(context.Background())
			for range 2 {
				got, err := client.Poll(context.Background(), session.SessionID)
				if err != nil || got.State != state || got.Authorization != "" {
					t.Fatalf("Poll = %+v, %v", got, err)
				}
			}
			if calls != 1 {
				t.Fatal("polled a terminal session again")
			}
		})
	}
	now := qrTestNow()
	calls := 0
	client := NewQRClient(QRConfig{Now: func() time.Time { return now }, HTTPClient: &http.Client{Transport: qrRoundTripper(func(*http.Request) (*http.Response, error) { calls++; return qrResponse(200, qrSuccessFixture), nil })}})
	session, _ := client.Generate(context.Background())
	if _, err := client.Poll(context.Background(), session.SessionID); err != nil {
		t.Fatal(err)
	}
	now = now.Add(qrSessionTTL)
	for _, id := range []string{session.SessionID, "unknown-session"} {
		got, err := client.Poll(context.Background(), id)
		if err != nil || got.State != "expired" || got.Authorization != "" {
			t.Fatalf("expired Poll = %+v, %v", got, err)
		}
	}
	if calls != 1 {
		t.Fatal("expired session reached upstream")
	}
}

func TestQRMalformedOrUnavailableResponsesNeverExposeCredentials(t *testing.T) {
	for _, body := range []string{
		`not base64`, `"AAAA"`, `{"code":"0","data":"not hex"}`, `{"code":"0","data":{}}`,
		`{"code":"0","data":{"account":"13800000000","token":"secret-but-invalid"}}`,
		`{"code":"unexpected","message":"secret-account-token"}`, `{"code":"0","data":""}`,
	} {
		t.Run(body, func(t *testing.T) {
			client := NewQRClient(QRConfig{HTTPClient: &http.Client{Transport: qrRoundTripper(func(*http.Request) (*http.Response, error) { return qrResponse(200, body), nil })}})
			session, _ := client.Generate(context.Background())
			status, err := client.Poll(context.Background(), session.SessionID)
			if err == nil || status.Authorization != "" {
				t.Fatalf("accepted invalid response: %+v", status)
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "13800000000") {
				t.Fatal("error exposed credential data")
			}
		})
	}
	client := NewQRClient(QRConfig{HTTPClient: &http.Client{Transport: qrRoundTripper(func(*http.Request) (*http.Response, error) { return qrResponse(503, "secret-account-token"), nil })}})
	session, _ := client.Generate(context.Background())
	if _, err := client.Poll(context.Background(), session.SessionID); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("upstream failure = %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Poll(ctx, session.SessionID); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Poll = %v", err)
	}
	if _, err := client.Generate(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Generate = %v", err)
	}
}

func TestQRSessionsAreBounded(t *testing.T) {
	now := qrTestNow()
	client := NewQRClient(QRConfig{Now: func() time.Time { return now }})
	first, _ := client.Generate(context.Background())
	for range maxQRSessions {
		now = now.Add(time.Second)
		if _, err := client.Generate(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if len(client.sessions) != maxQRSessions {
		t.Fatalf("session count = %d", len(client.sessions))
	}
	if got, err := client.Poll(context.Background(), first.SessionID); err != nil || got.State != "expired" {
		t.Fatalf("evicted session = %+v, %v", got, err)
	}
	now = now.Add(qrSessionTTL)
	if _, err := client.Generate(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(client.sessions) != 1 {
		t.Fatal("expired sessions were retained")
	}
}
