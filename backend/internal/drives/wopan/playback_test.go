package wopan

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	sdk "github.com/OpenListTeam/wopan-sdk-go"
)

func TestPlaybackLinksUsesPreviewAPIWithoutChangingOriginalDownload(t *testing.T) {
	const token = "0123456789abcdef-test"
	crypto := sdk.NewCrypto()
	_ = crypto.SetAccessToken(token)
	client := &http.Client{Transport: sdkRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		defer r.Body.Close()
		var request struct {
			Header struct {
				Key string `json:"key"`
			} `json:"header"`
			Body struct {
				Param string `json:"param"`
			} `json:"body"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Fatal(err)
		}
		if request.Header.Key != "VideoDisplayFiles" {
			t.Fatalf("API = %q", request.Header.Key)
		}
		decoded, err := crypto.WoHomeDecrypt(request.Body.Param)
		if err != nil {
			t.Fatal(err)
		}
		var params struct {
			FIDs  []string `json:"fids"`
			User  string   `json:"userId"`
			Space string   `json:"spaceType"`
		}
		if err := json.Unmarshal([]byte(decoded), &params); err != nil {
			t.Fatal(err)
		}
		if len(params.FIDs) != 1 || params.FIDs[0] != "fid/one" || params.User != "user" || params.Space != "0" {
			t.Fatalf("params = %+v", params)
		}
		body := `{"STATUS":"200","RSP":{"RSP_CODE":"0000","DATA":[{"fid":"other","m3u8":"https://wrong.example/index.m3u8"},{"fid":"fid/one","m3u8":"https://hls.example/index.m3u8","downloadUrl":"https://download.example/video.ts"}]}}`
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})}
	d := New(Config{ID: "wo"})
	d.client = sdk.New(sdk.WithClient(client))
	d.client.SetAccessToken(token)
	d.client.Phone = "user"
	links, err := d.PlaybackLinks(context.Background(), "fid/one")
	if err != nil {
		t.Fatal(err)
	}
	if links.HLS.URL != "https://hls.example/index.m3u8" || links.Original.URL != "https://download.example/video.ts" || !links.HLS.ClientRedirectSafe || len(links.HLS.Headers) != 0 {
		t.Fatalf("links = %+v", links)
	}
}
