# 国内构建默认值：基础镜像走 DaoCloud 公共镜像，apt 走中科大，npm 走 npmmirror。
# 需要官方源时：--build-arg DOCKER_MIRROR= --build-arg APT_MIRROR=deb.debian.org --build-arg NPM_REGISTRY=https://registry.npmjs.org
ARG DOCKER_MIRROR=docker.m.daocloud.io/library/
ARG APT_MIRROR=mirrors.ustc.edu.cn
ARG NPM_REGISTRY=https://registry.npmmirror.com

# Fixed upstream ARM64 binaries include MPP/RGA and libx264. Download on the
# builder architecture; only the rockchip target depends on this stage.
FROM --platform=$BUILDPLATFORM ${DOCKER_MIRROR}debian:bookworm-slim AS rockchip-media
ARG TARGETARCH
RUN test "$TARGETARCH" = arm64 \
    && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /media
RUN curl -fL --retry 3 https://github.com/MarcA711/Rockchip-FFmpeg-Builds/releases/download/6.1-11/ffmpeg -o ffmpeg \
    && curl -fL --retry 3 https://github.com/MarcA711/Rockchip-FFmpeg-Builds/releases/download/6.1-11/ffprobe -o ffprobe \
    && printf '%s\n' \
      '2849e8800ed8e7cd2a9ee9c5cff6b9abc325d2400f3fe755d6bd6d0ad4c87a91  ffmpeg' \
      '402b142b0ac1c8e7eeb0f9cbafc18b85fbcb286e4ed0b0be1da50454920ff8b1  ffprobe' \
      | sha256sum -c - \
    && chmod 755 ffmpeg ffprobe

# ---- Build frontend ----
FROM --platform=$BUILDPLATFORM ${DOCKER_MIRROR}node:24.22.1-slim AS frontend
ARG NPM_REGISTRY

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm config set registry "$NPM_REGISTRY" \
    && npm install --global "$(node -p "require('./package.json').packageManager")" \
    && npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY scripts/ scripts/
COPY public/ public/
COPY src/ src/
RUN npm run build

# ---- Build backend ----
FROM --platform=$BUILDPLATFORM ${DOCKER_MIRROR}golang:1.27.3-bookworm AS backend
ARG TARGETOS
ARG TARGETARCH

WORKDIR /app/backend

COPY backend/go.mod backend/go.sum ./
COPY backend/vendor/ vendor/
COPY backend/cmd/ cmd/
COPY backend/internal/ internal/
COPY backend/config_template.go backend/config.example.yaml ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

# ---- Shared application runtime ----
FROM ${DOCKER_MIRROR}debian:bookworm-slim AS application
ARG APT_MIRROR

ENV DEBIAN_FRONTEND=noninteractive

RUN if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://deb.debian.org/debian bookworm non-free' \
        > /etc/apt/sources.list.d/gpu-drivers.list; \
    fi \
    && apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    mesa-va-drivers \
    python3 \
    python3-bs4 \
    python3-lxml \
    python3-requests \
    python3-socks \
    tar \
    tzdata \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      apt-get install -y --no-install-recommends intel-media-va-driver-non-free i965-va-driver; \
    fi \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -c "import requests, bs4, lxml, socks"

WORKDIR /opt/video-site-91

COPY --from=backend /out/server ./server
COPY --from=frontend /app/dist ./dist
COPY backend/config.example.yaml ./config.example.yaml
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY docker-compose.yml docker-compose.gpu-nvidia.yml docker-compose.gpu-vaapi.yml docker-compose.gpu-rockchip.yml tg-docker-compose.yml /usr/local/share/video-site-91/deploy/

ARG VERSION=dev

ENV VIDEO_CONFIG=/opt/video-site-91/data/config.yaml \
    VIDEO_FRONTEND_DIR=/opt/video-site-91/dist \
    VIDEO_GITHUB_REPO=XlangNan/91 \
    VIDEO_IMAGE_VERSION=${VERSION} \
    VIDEO_LISTEN_PORT=9191 \
    VIDEO_VERSION_FILE=/opt/video-site-91/data/.version

RUN chmod +x ./server /usr/local/bin/docker-entrypoint.sh

VOLUME ["/opt/video-site-91/data"]
EXPOSE 9191

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["./server"]

# ---- Rockchip runtime (linux/arm64 only) ----
FROM application AS rockchip
LABEL io.video-site-91.media-variant="rockchip"
COPY --from=rockchip-media /media/ffmpeg /media/ffprobe /usr/local/bin/
# Verify the bundled tools without requiring media hardware during the build.
RUN python3 - <<'PY'
import subprocess
for flag, names in [('-hwaccels', ['rkmpp']), ('-encoders', ['h264_rkmpp', 'libx264']), ('-filters', ['scale_rkrga'])]:
    output = subprocess.check_output(['ffmpeg', '-hide_banner', flag], text=True)
    for name in names:
        assert name in output, f'Missing FFmpeg capability: {name}'
subprocess.run(['ffprobe', '-version'], check=True)
PY

# Keep ordinary builds on the standard runtime, including generic ARM64 hosts.
FROM application AS runtime
LABEL io.video-site-91.media-variant="standard"
