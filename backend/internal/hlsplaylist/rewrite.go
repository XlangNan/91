// Package hlsplaylist rewrites HLS resource references without changing media
// metadata, byte ranges, encryption attributes or rendition groups.
package hlsplaylist

import (
	"errors"
	"regexp"
	"strings"
)

var uriAttribute = regexp.MustCompile(`([:,]\s*)(?:URI|SERVER-URI)="([^"]*)"`)

// Rewrite applies resolve to URI lines and URI attributes, including alternative
// audio, encryption keys and initialization maps. resolve owns URL policy.
func Rewrite(playlist string, resolve func(string) (string, error)) (string, error) {
	if !strings.HasPrefix(strings.TrimSpace(playlist), "#EXTM3U") {
		return "", errors.New("invalid HLS playlist")
	}
	lines := strings.Split(playlist, "\n")
	for i, line := range lines {
		text := strings.TrimSpace(line)
		if text == "" {
			continue
		}
		if !strings.HasPrefix(text, "#") {
			local, err := resolve(text)
			if err != nil {
				return "", err
			}
			lines[i] = local
			continue
		}
		if !strings.HasPrefix(text, "#EXT") {
			continue
		}
		var rewriteErr error
		lines[i] = uriAttribute.ReplaceAllStringFunc(line, func(attribute string) string {
			parts := uriAttribute.FindStringSubmatch(attribute)
			local, err := resolve(parts[2])
			if err != nil {
				rewriteErr = err
				return attribute
			}
			start := strings.IndexByte(attribute, '"') + 1
			return attribute[:start] + local + `"`
		})
		if rewriteErr != nil {
			return "", rewriteErr
		}
	}
	return strings.Join(lines, "\n"), nil
}
