package preview

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestCUDADeviceNameMatchesSelectedDevice(t *testing.T) {
	output := `[h264_nvenc @ 0x123] [ GPU #0 - < NVIDIA GeForce RTX 4060 Laptop GPU > has Compute SM 8.9 ]
[h264_nvenc @ 0x123] [ GPU #1 - < NVIDIA RTX A4000 > has Compute SM 8.6 ]`
	for _, tc := range []struct{ device, want string }{
		{"0", "NVIDIA GeForce RTX 4060 Laptop GPU"},
		{"1", "NVIDIA RTX A4000"},
		{"2", ""},
	} {
		if got := cudaDeviceName(output, tc.device); got != tc.want {
			t.Errorf("device %s name = %q, want %q", tc.device, got, tc.want)
		}
	}
}

func TestHardwareNameAcceptsFFmpegDeviceListExitStatus(t *testing.T) {
	ffmpeg := filepath.Join(t.TempDir(), "ffmpeg")
	writeExecutable(t, ffmpeg, `#!/bin/sh
printf '%s\n' '[h264_nvenc] [ GPU #0 - < NVIDIA GeForce RTX 4060 Laptop GPU > has Compute SM 8.9 ]' >&2
exit 1
`)
	h := NewHardware(Config{FFmpegPath: ffmpeg})
	backend := &hardwareBackend{kind: "cuda", device: "0"}
	backend.name = h.deviceName(context.Background(), backend)
	if backend.name != "NVIDIA GeForce RTX 4060 Laptop GPU" {
		t.Fatalf("name = %q", backend.name)
	}
	h.checked, h.backend = true, backend
	if status := h.Status(); !status.Available || status.Name != backend.name {
		t.Fatalf("cached status = %+v", status)
	}
}

func TestHardwareNameUnavailableDoesNotRejectWorkingGPU(t *testing.T) {
	h, _, _ := hardwareFixture(t)
	status := h.Check(context.Background())
	if !status.Available || status.Name == "" {
		t.Fatalf("name lookup changed capability result: %+v", status)
	}
}

func TestDRMDeviceNameUsesSelectedRenderNode(t *testing.T) {
	devicePath := t.TempDir()
	if err := os.WriteFile(filepath.Join(devicePath, "product_name"), []byte("AMD Radeon RX 7800 XT\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := drmDeviceName(context.Background(), devicePath); got != "AMD Radeon RX 7800 XT" {
		t.Fatalf("name = %q", got)
	}
}

func TestDRMDeviceNameUsesPCIAddress(t *testing.T) {
	devicePath := t.TempDir()
	if err := os.WriteFile(filepath.Join(devicePath, "uevent"), []byte("PCI_SLOT_NAME=0000:03:00.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	writeExecutable(t, filepath.Join(bin, "lspci"), `#!/bin/sh
if [ "$1" != "-s" ] || [ "$2" != "0000:03:00.0" ]; then exit 1; fi
printf '%s\n' '0000:03:00.0 VGA compatible controller: Intel Corporation DG2 [Arc A770] (rev 08)'
`)
	t.Setenv("PATH", bin)
	if got := drmDeviceName(context.Background(), devicePath); got != "Intel Corporation DG2 [Arc A770]" {
		t.Fatalf("name = %q", got)
	}
}

func TestDRMDeviceNameFallsBackToVendor(t *testing.T) {
	for _, tc := range []struct{ vendor, want string }{
		{"0x8086\n", "Intel GPU"},
		{"0x1002\n", "AMD GPU"},
		{"", "VAAPI GPU"},
	} {
		devicePath := t.TempDir()
		if err := os.WriteFile(filepath.Join(devicePath, "vendor"), []byte(tc.vendor), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := drmDeviceName(context.Background(), devicePath); got != tc.want {
			t.Errorf("vendor %q name = %q, want %q", tc.vendor, got, tc.want)
		}
	}
}
