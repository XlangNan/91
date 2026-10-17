package p115

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

type qrRoundTripFunc func(*http.Request) (*http.Response, error)

func (f qrRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func qrTestClient(t *testing.T, roundTrip qrRoundTripFunc) *QRClient {
	t.Helper()
	return NewQRClient(QRConfig{
		HTTPClient: &http.Client{Transport: roundTrip},
	})
}

func qrJSONResponse(req *http.Request, body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Status:     "200 OK",
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

func TestQRClientGenerate(t *testing.T) {
	client := qrTestClient(t, func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodGet || req.URL.Host != "qrcodeapi.115.com" || req.URL.Path != "/api/1.0/web/1.0/token" {
			t.Fatalf("request = %s %s", req.Method, req.URL.String())
		}
		if req.UserAgent() == "" || !strings.Contains(req.UserAgent(), "115Browser") {
			t.Fatalf("user-agent = %q, want 115Browser", req.UserAgent())
		}
		return qrJSONResponse(req, `{
			"state": 1,
			"code": 0,
			"data": {
				"uid": "qr-uid",
				"time": 1784127027,
				"sign": "qr-sign",
				"qrcode": "https://115.com/scan/dg-qr-uid"
			}
		}`), nil
	})

	session, err := client.Generate(context.Background())
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}
	if session.UID != "qr-uid" || session.Time != 1784127027 || session.Sign != "qr-sign" {
		t.Fatalf("session = %#v", session)
	}
	if session.QRCodeURL != "https://115.com/scan/dg-qr-uid" {
		t.Fatalf("qrCodeUrl = %q", session.QRCodeURL)
	}
	const prefix = "data:image/png;base64,"
	if !strings.HasPrefix(session.QRImageDataURL, prefix) {
		t.Fatalf("qr image prefix = %q", session.QRImageDataURL)
	}
	png, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(session.QRImageDataURL, prefix))
	if err != nil {
		t.Fatalf("decode QR image: %v", err)
	}
	if len(png) < 8 || string(png[:8]) != "\x89PNG\r\n\x1a\n" {
		t.Fatalf("qr image is not PNG")
	}
}

func TestQRClientPollExchangesApprovedSessionForWebCookie(t *testing.T) {
	statusCalls := 0
	loginCalls := 0
	client := qrTestClient(t, func(req *http.Request) (*http.Response, error) {
		switch {
		case req.URL.Host == "qrcodeapi.115.com" && req.URL.Path == "/get/status/":
			statusCalls++
			if req.URL.Query().Get("uid") != "qr-uid" || req.URL.Query().Get("time") != "1784127027" || req.URL.Query().Get("sign") != "qr-sign" {
				t.Fatalf("status query = %s", req.URL.RawQuery)
			}
			return qrJSONResponse(req, `{"state":1,"code":0,"data":{"status":2,"msg":"ok"}}`), nil
		case req.URL.Host == "passportapi.115.com" && req.URL.Path == "/app/1.0/web/1.0/login/qrcode":
			loginCalls++
			body, err := io.ReadAll(req.Body)
			if err != nil {
				t.Fatalf("read login body: %v", err)
			}
			form, err := url.ParseQuery(string(body))
			if err != nil {
				t.Fatalf("parse login body: %v", err)
			}
			if form.Get("account") != "qr-uid" || form.Get("app") != "web" {
				t.Fatalf("login form = %v", form)
			}
			return qrJSONResponse(req, `{
				"state": 1,
				"code": 0,
				"data": {
					"cookie": {"UID":"user-uid","CID":"cid","SEID":"seid","KID":"kid"}
				}
			}`), nil
		default:
			t.Fatalf("unexpected request: %s %s", req.Method, req.URL.String())
			return nil, nil
		}
	})

	status, err := client.Poll(context.Background(), "qr-uid", 1784127027, "qr-sign")
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if status.State != "success" || status.Status != 2 || status.StatusText != "登录成功" {
		t.Fatalf("status = %#v", status)
	}
	if status.Cookie != "UID=user-uid;CID=cid;SEID=seid;KID=kid" {
		t.Fatalf("cookie = %q", status.Cookie)
	}
	if statusCalls != 1 || loginCalls != 1 {
		t.Fatalf("calls: status=%d login=%d", statusCalls, loginCalls)
	}
}

func TestQRClientPollMapsNonTerminalStates(t *testing.T) {
	tests := []struct {
		name       string
		upstream   int
		wantState  string
		wantStatus int
	}{
		{name: "waiting", upstream: 0, wantState: "waiting", wantStatus: 0},
		{name: "scanned", upstream: 1, wantState: "scanned", wantStatus: 1},
		{name: "expired", upstream: -1, wantState: "expired", wantStatus: -1},
		{name: "canceled", upstream: -2, wantState: "canceled", wantStatus: -2},
		{name: "unknown", upstream: 9, wantState: "error", wantStatus: 9},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			client := qrTestClient(t, func(req *http.Request) (*http.Response, error) {
				body := `{"state":1,"code":0,"data":{"status":` + strconv.Itoa(tc.upstream) + `}}`
				return qrJSONResponse(req, body), nil
			})
			got, err := client.Poll(context.Background(), "qr-uid", 1, "qr-sign")
			if err != nil {
				t.Fatalf("Poll: %v", err)
			}
			if got.State != tc.wantState || got.Status != tc.wantStatus || got.Cookie != "" {
				t.Fatalf("status = %#v", got)
			}
		})
	}
}

func TestQRClientPollMapsExpiredAPIError(t *testing.T) {
	client := qrTestClient(t, func(req *http.Request) (*http.Response, error) {
		return qrJSONResponse(req, `{"state":0,"code":40199002,"message":"expired"}`), nil
	})
	got, err := client.Poll(context.Background(), "qr-uid", 1, "qr-sign")
	if err != nil {
		t.Fatalf("Poll: %v", err)
	}
	if got.State != "expired" || got.Status != -1 {
		t.Fatalf("status = %#v", got)
	}
}

func TestQRClientPollValidatesSessionBeforeRequest(t *testing.T) {
	requests := 0
	client := qrTestClient(t, func(req *http.Request) (*http.Response, error) {
		requests++
		return qrJSONResponse(req, `{}`), nil
	})
	for _, args := range []struct {
		uid  string
		time int64
		sign string
	}{
		{uid: "", time: 1, sign: "sign"},
		{uid: "uid", time: 0, sign: "sign"},
		{uid: "uid", time: 1, sign: ""},
	} {
		if _, err := client.Poll(context.Background(), args.uid, args.time, args.sign); err == nil {
			t.Fatalf("Poll(%q, %d, %q) returned nil error", args.uid, args.time, args.sign)
		}
	}
	if requests != 0 {
		t.Fatalf("requests = %d, want 0", requests)
	}
}

func TestQRClientAllowsUpstreamLongPoll(t *testing.T) {
	client := NewQRClient(QRConfig{})
	client.httpClient.Transport = qrRoundTripFunc(func(req *http.Request) (*http.Response, error) {
		deadline, ok := req.Context().Deadline()
		if !ok || time.Until(deadline) <= 35*time.Second {
			t.Fatal("QR request deadline must allow the upstream's 30-second long poll")
		}
		return qrJSONResponse(req, `{"state":1,"code":0,"data":{"status":0}}`), nil
	})
	if _, err := client.Poll(context.Background(), "uid", 1, "sign"); err != nil {
		t.Fatalf("Poll: %v", err)
	}
}

func TestQRClientCancelsUpstreamRequests(t *testing.T) {
	for _, stage := range []string{"generate", "status", "credential"} {
		t.Run(stage, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			client := qrTestClient(t, func(req *http.Request) (*http.Response, error) {
				if stage == "credential" && req.URL.Path == "/get/status/" {
					return qrJSONResponse(req, `{"state":1,"code":0,"data":{"status":2}}`), nil
				}
				cancel()
				select {
				case <-req.Context().Done():
					return nil, req.Context().Err()
				case <-time.After(time.Second):
					t.Fatal("upstream request did not inherit caller cancellation")
					return nil, context.DeadlineExceeded
				}
			})
			var err error
			if stage == "generate" {
				_, err = client.Generate(ctx)
			} else {
				_, err = client.Poll(ctx, "uid", 1, "sign")
			}
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("error = %v, want context.Canceled", err)
			}
		})
	}
}
