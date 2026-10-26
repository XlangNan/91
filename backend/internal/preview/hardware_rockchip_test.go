package preview

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHardwareCandidatesPreferRockchipAndAcceptServiceAlias(t *testing.T) {
	for _, service := range []string{"mpp_service", "mpp-service"} {
		t.Run(service, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.Mkdir(filepath.Join(dir, "dri"), 0o755); err != nil {
				t.Fatal(err)
			}
			for _, node := range []string{service, "dri/renderD128"} {
				if err := os.WriteFile(filepath.Join(dir, node), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			candidates := hardwareCandidates(dir)
			if len(candidates) != 4 || candidates[0].kind != "rkmpp" || candidates[0].device != filepath.Join(dir, service) ||
				candidates[1].kind != "vaapi" || !candidates[2].lowPower || candidates[3].kind != "cuda" {
				t.Fatalf("unexpected candidates: %+v", candidates)
			}
		})
	}
}

func TestRockchipProbeRunsProductionPipelineAndRejectsFailedEncoding(t *testing.T) {
	for _, fail := range []bool{false, true} {
		h, _, logPath := hardwareFixture(t)
		if fail {
			t.Setenv("GPU_TEST_FAIL", "probe")
		}
		backend, err := h.probeCandidates(context.Background(), []*hardwareBackend{{kind: "rkmpp", device: "/dev/mpp_service"}})
		if fail {
			if err == nil || backend != nil || !strings.Contains(err.Error(), "scale_rkrga") {
				t.Fatalf("broken Rockchip pipeline accepted: backend=%+v err=%v", backend, err)
			}
		} else if err != nil || backend == nil || backend.kind != "rkmpp" || backend.name == "" {
			t.Fatalf("working Rockchip pipeline rejected: backend=%+v err=%v", backend, err)
		}
		calls, _ := os.ReadFile(logPath)
		for _, required := range []string{"-hwaccel rkmpp -hwaccel_output_format drm_prime", "scale_rkrga=w=256:h=-2:format=nv12,hwdownload,format=nv12", "-frames:v 1", "fade=t=in", "-c:v h264_rkmpp -rc_mode CQP -qp_init 28"} {
			if !strings.Contains(string(calls), required) {
				t.Fatalf("probe did not exercise %s:\n%s", required, calls)
			}
		}
		for _, forbidden := range []string{"hwupload", "-init_hw_device", "scale_rkmpp"} {
			if strings.Contains(string(calls), forbidden) {
				t.Fatalf("incompatible option %s:\n%s", forbidden, calls)
			}
		}
	}
}

func TestRockchipProbeFailureContinuesToOtherBackends(t *testing.T) {
	h, _, _ := hardwareFixture(t)
	t.Setenv("GPU_TEST_FAIL", "probe")
	backend, err := h.probeCandidates(context.Background(), []*hardwareBackend{
		{kind: "rkmpp", device: "/dev/mpp_service"}, {kind: "cuda", device: "0"},
	})
	if err != nil || backend == nil || backend.kind != "cuda" {
		t.Fatalf("remaining backend not tried: backend=%+v err=%v", backend, err)
	}
}

func TestRockchipDeviceNameUsesCompatibleBeforeBoardModel(t *testing.T) {
	for _, tc := range []struct{ compatible, model, want string }{
		{"friendlyarm,nanopi-r6s\x00rockchip,rk3588s\x00", "FriendlyElec NanoPi R6S\x00", "Rockchip RK3588S"},
		{"", "Rockchip RK3566 board\x00", "Rockchip RK3566"},
		{"", "Radxa ROCK 5B\x00", "Rockchip VPU"},
		{"", "", "Rockchip VPU"},
	} {
		dir := t.TempDir()
		for file, data := range map[string]string{"compatible": tc.compatible, "model": tc.model} {
			if err := os.WriteFile(filepath.Join(dir, file), []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		if got := rockchipDeviceName(dir); got != tc.want {
			t.Errorf("compatible=%q model=%q: got %q, want %q", tc.compatible, tc.model, got, tc.want)
		}
	}
}
