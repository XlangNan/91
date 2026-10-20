package wopan

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	sdk "github.com/OpenListTeam/wopan-sdk-go"
	"github.com/go-resty/resty/v2"
)

const (
	defaultQRCodeAPIBase = "https://panservice.mail.wo.cn/wohome/open/v1/QRCode"
	defaultQRCodeClient  = "1001000021"
)

type QRConfig struct {
	APIBaseURL string
	HTTPClient *http.Client
	Now        func() time.Time
}

type QRClient struct {
	apiBase string
	client  *resty.Client
	now     func() time.Time
}

type QRCodeSession struct {
	UUID           string `json:"uuid"`
	QRImageDataURL string `json:"qrImageDataUrl"`
	ExpiresAt      string `json:"expiresAt,omitempty"`
}

type QRCodeStatus struct {
	State        int    `json:"state"`
	StatusText   string `json:"statusText"`
	AccessToken  string `json:"accessToken,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	FamilyID     string `json:"familyID,omitempty"`
}

func NewQRClient(c QRConfig) *QRClient {
	apiBase := strings.TrimRight(strings.TrimSpace(c.APIBaseURL), "/")
	if apiBase == "" {
		apiBase = defaultQRCodeAPIBase
	}
	httpClient := c.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	now := c.Now
	if now == nil {
		now = time.Now
	}
	return &QRClient{
		apiBase: apiBase,
		client: resty.NewWithClient(httpClient).
			SetTimeout(20*time.Second).
			SetHeader("User-Agent", sdk.DefaultUA).
			SetHeader("Accept", "application/json"),
		now: now,
	}
}

func (c *QRClient) Generate(ctx context.Context) (QRCodeSession, error) {
	var envelope qrEnvelope
	res, err := c.request(ctx).
		SetResult(&envelope).
		Get(c.apiBase + "/generate")
	if err != nil {
		return QRCodeSession{}, err
	}
	if res.IsError() {
		return QRCodeSession{}, qrAPIError(envelope.message(), res.StatusCode())
	}

	var result qrGenerateResult
	if err := decodeResult(envelope.Result, &result); err != nil {
		return QRCodeSession{}, err
	}
	result.UUID = strings.TrimSpace(result.UUID)
	result.Image = strings.TrimSpace(result.Image)
	if result.UUID == "" {
		return QRCodeSession{}, errors.New("wopan qr: empty uuid")
	}
	if result.Image == "" {
		return QRCodeSession{}, errors.New("wopan qr: empty image")
	}
	return QRCodeSession{
		UUID:           result.UUID,
		QRImageDataURL: qrImageDataURL(result.Image),
		ExpiresAt:      c.now().Add(60 * time.Second).Format(time.RFC3339),
	}, nil
}

func (c *QRClient) Poll(ctx context.Context, uuid string) (QRCodeStatus, error) {
	uuid = strings.TrimSpace(uuid)
	if uuid == "" {
		return QRCodeStatus{}, errors.New("uuid is required")
	}

	var envelope qrEnvelope
	res, err := c.request(ctx).
		SetQueryParam("uuid", uuid).
		SetResult(&envelope).
		Get(c.apiBase + "/query")
	if err != nil {
		return QRCodeStatus{}, err
	}
	if res.IsError() {
		return QRCodeStatus{}, qrAPIError(envelope.message(), res.StatusCode())
	}

	result, err := decodeResultMap(envelope.Result)
	if err != nil {
		return QRCodeStatus{}, err
	}
	state := intValue(result["state"])
	status := QRCodeStatus{
		State:      state,
		StatusText: qrStateText(state),
	}
	if state != 3 {
		return status, nil
	}

	status.AccessToken = findStringByKeys(result, "access_token", "accessToken", "token", "tokenValue")
	status.RefreshToken = findStringByKeys(result, "refresh_token", "refreshToken")
	status.FamilyID = findStringByKeys(result, "family_id", "familyId", "familyID", "defaultFamilyId", "defaultHomeId", "homeId")
	if status.AccessToken == "" || status.RefreshToken == "" {
		missing := make([]string, 0, 2)
		if status.AccessToken == "" {
			missing = append(missing, "access_token")
		}
		if status.RefreshToken == "" {
			missing = append(missing, "refresh_token")
		}
		return QRCodeStatus{}, fmt.Errorf("wopan qr: login succeeded but missing %s; available keys: %s",
			strings.Join(missing, ", "), strings.Join(collectJSONKeys(result), ", "))
	}
	return status, nil
}

func (c *QRClient) request(ctx context.Context) *resty.Request {
	return c.client.R().
		SetContext(ctx).
		SetHeaders(map[string]string{
			"client-id":       defaultQRCodeClient,
			"x-yp-client-id":  defaultQRCodeClient,
			"Accept":          "application/json",
			"Accept-Language": "zh-CN,zh;q=0.9",
		})
}

type qrEnvelope struct {
	Meta    qrMeta          `json:"meta"`
	Result  json.RawMessage `json:"result"`
	Code    any             `json:"code,omitempty"`
	Message string          `json:"message,omitempty"`
	Msg     string          `json:"msg,omitempty"`
}

type qrMeta struct {
	Code    any    `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	Msg     string `json:"msg,omitempty"`
}

type qrGenerateResult struct {
	UUID  string `json:"uuid"`
	Image string `json:"image"`
}

func (e qrEnvelope) message() string {
	for _, s := range []string{e.Message, e.Msg, e.Meta.Message, e.Meta.Msg} {
		if strings.TrimSpace(s) != "" {
			return strings.TrimSpace(s)
		}
	}
	return ""
}

func decodeResult(raw json.RawMessage, dst any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return errors.New("wopan qr: empty result")
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("wopan qr: decode result: %w", err)
	}
	return nil
}

func decodeResultMap(raw json.RawMessage) (map[string]any, error) {
	var result map[string]any
	if err := decodeResult(raw, &result); err != nil {
		return nil, err
	}
	if result == nil {
		return nil, errors.New("wopan qr: empty result")
	}
	return result, nil
}

func qrImageDataURL(image string) string {
	image = strings.TrimSpace(image)
	if strings.HasPrefix(strings.ToLower(image), "data:image/") {
		return image
	}
	return "data:image/png;base64," + image
}

func qrAPIError(message string, httpStatus int) error {
	message = strings.TrimSpace(message)
	if message == "" {
		message = fmt.Sprintf("HTTP %d", httpStatus)
	}
	return errors.New(message)
}

func qrStateText(state int) string {
	switch state {
	case 1:
		return "等待扫码"
	case 2:
		return "已扫码，请在联通网盘 App 确认"
	case 3:
		return "登录成功"
	case 4:
		return "二维码已过期"
	default:
		return "未知状态"
	}
}

func intValue(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	case json.Number:
		n, _ := x.Int64()
		return int(n)
	case string:
		n, _ := strconv.Atoi(strings.TrimSpace(x))
		return n
	default:
		return 0
	}
}

func findStringByKeys(v any, keys ...string) string {
	targets := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		targets[normalizeJSONKey(key)] = struct{}{}
	}
	return findStringByNormalizedKeys(v, targets)
}

func findStringByNormalizedKeys(v any, targets map[string]struct{}) string {
	switch x := v.(type) {
	case map[string]any:
		for key, value := range x {
			if _, ok := targets[normalizeJSONKey(key)]; ok {
				if s := stringValue(value); s != "" {
					return s
				}
			}
		}
		for _, value := range x {
			if s := findStringByNormalizedKeys(value, targets); s != "" {
				return s
			}
		}
	case []any:
		for _, value := range x {
			if s := findStringByNormalizedKeys(value, targets); s != "" {
				return s
			}
		}
	}
	return ""
}

func stringValue(v any) string {
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		if x == float64(int64(x)) {
			return strconv.FormatInt(int64(x), 10)
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case json.Number:
		return strings.TrimSpace(x.String())
	default:
		return ""
	}
}

func normalizeJSONKey(key string) string {
	key = strings.ToLower(strings.TrimSpace(key))
	key = strings.ReplaceAll(key, "_", "")
	key = strings.ReplaceAll(key, "-", "")
	key = strings.ReplaceAll(key, " ", "")
	return key
}

func collectJSONKeys(v any) []string {
	seen := map[string]struct{}{}
	var walk func(any)
	walk = func(value any) {
		switch x := value.(type) {
		case map[string]any:
			for key, child := range x {
				if strings.TrimSpace(key) != "" {
					seen[key] = struct{}{}
				}
				walk(child)
			}
		case []any:
			for _, child := range x {
				walk(child)
			}
		}
	}
	walk(v)

	keys := make([]string, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) > 16 {
		keys = append(keys[:16], "...")
	}
	return keys
}
