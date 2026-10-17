package preview

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var cudaDeviceNamePattern = regexp.MustCompile(`GPU #([0-9]+)\s*-\s*<\s*([^>]+)>`)

// Device names are optional metadata. Query once after a successful media probe
// and keep the name in the same immutable backend snapshot as its device ID.
func (h *Hardware) deviceName(ctx context.Context, backend *hardwareBackend) string {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	switch backend.kind {
	case "cuda":
		// FFmpeg lists CUDA ordinals, matching the device used for generation even
		// when visibility or ordering differs from nvidia-smi. Some FFmpeg versions
		// exit nonzero after listing devices; the device record is the result.
		output, _ := exec.CommandContext(ctx, h.cfg.FFmpegPath,
			"-hide_banner", "-loglevel", "info", "-f", "lavfi",
			"-i", "color=s=256x256:r=1", "-frames:v", "1",
			"-c:v", "h264_nvenc", "-gpu", "list", "-f", "null", "-y", os.DevNull,
		).CombinedOutput()
		if name := cudaDeviceName(string(output), backend.device); name != "" {
			return name
		}
		return "NVIDIA GPU"
	case "vaapi":
		return drmDeviceName(ctx, filepath.Join("/sys/class/drm", filepath.Base(backend.device), "device"))
	default:
		return "GPU"
	}
}

func cudaDeviceName(output, device string) string {
	for _, match := range cudaDeviceNamePattern.FindAllStringSubmatch(output, -1) {
		if match[1] == device {
			return strings.TrimSpace(match[2])
		}
	}
	return ""
}

func drmDeviceName(ctx context.Context, devicePath string) string {
	if data, err := os.ReadFile(filepath.Join(devicePath, "product_name")); err == nil {
		if name := strings.TrimSpace(string(data)); name != "" {
			return name
		}
	}
	// pciutils is optional; use the selected render node's PCI address so a
	// machine with multiple display adapters never reports a different card.
	uevent, _ := os.ReadFile(filepath.Join(devicePath, "uevent"))
	for _, line := range strings.Split(string(uevent), "\n") {
		if slot, ok := strings.CutPrefix(line, "PCI_SLOT_NAME="); ok && slot != "" {
			output, err := exec.CommandContext(ctx, "lspci", "-s", slot).Output()
			if err == nil {
				if _, name, found := strings.Cut(strings.TrimSpace(string(output)), ": "); found {
					name, _, _ = strings.Cut(name, " (rev ")
					if name = strings.TrimSpace(name); name != "" {
						return name
					}
				}
			}
			break
		}
	}
	vendor, _ := os.ReadFile(filepath.Join(devicePath, "vendor"))
	switch strings.TrimSpace(string(vendor)) {
	case "0x8086":
		return "Intel GPU"
	case "0x1002":
		return "AMD GPU"
	default:
		return "VAAPI GPU"
	}
}
