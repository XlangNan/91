package hlsplaylist

import (
	"errors"
	"strings"
	"testing"
)

func TestRewritePreservesRenditionsEncryptionAndByteRanges(t *testing.T) {
	input := "#EXTM3U\r\n" +
		`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="中文,原声",URI="audio/index.m3u8?token=a,b"` + "\r\n" +
		`#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1234` + "\r\n" +
		`#EXT-X-MAP:URI="init.mp4",BYTERANGE="100@0"` + "\r\n" +
		"#EXT-X-STREAM-INF:BANDWIDTH=1800000,AUDIO=\"a\"\r\nvideo.m3u8\r\n" +
		"#EXT-X-BYTERANGE:100@200\r\nsegment.mp4\r\n"
	var resources []string
	output, err := Rewrite(input, func(raw string) (string, error) {
		resources = append(resources, raw)
		return "/local/" + raw, nil
	})
	if err != nil || len(resources) != 5 {
		t.Fatalf("resources=%v err=%v", resources, err)
	}
	for _, want := range []string{`NAME="中文,原声"`, `URI="/local/audio/index.m3u8?token=a,b"`, `URI="/local/key.bin",IV=0x1234`, `URI="/local/init.mp4",BYTERANGE="100@0"`, "#EXT-X-BYTERANGE:100@200\r\n/local/segment.mp4"} {
		if !strings.Contains(output, want) {
			t.Fatalf("missing %q in %s", want, output)
		}
	}
}

func TestRewriteRejectsInvalidPlaylistsAndResourceFailures(t *testing.T) {
	failure := errors.New("resource rejected")
	for _, playlist := range []string{"<html>login required</html>", "#EXTM3U\nkey.ts", "#EXTM3U\n#EXT-X-KEY:URI=\"bad\""} {
		output, err := Rewrite(playlist, func(string) (string, error) { return "", failure })
		if err == nil || output != "" {
			t.Fatalf("invalid playlist returned %q, %v", output, err)
		}
	}
}
