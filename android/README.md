# 私有视频站 安卓 App

原生 Kotlin + Jetpack Compose，播放器用 Media3 (ExoPlayer)，直接对接本站现有接口，不需要改服务端。

## 功能
- 登录：填 NAS 上网站地址 + 账号密码，会话过期自动用保存的账号密码静默重登
- 首页：全部 / 最新 / 最热，标签筛选，标题/作者搜索，无限滚动，进入播放再返回保持位置
- 播放：Range 拖动、倍速、全屏（旋转即全屏）、记住每个视频的播放进度
- 刷片：上下滑动连续播放，点击暂停/继续，自动续载下一批

## 构建 APK（推荐：GitHub Actions）
1. 把本分支推到你的 GitHub 仓库
2. 仓库页 → Actions → “Android APK” → Run workflow
3. 跑完在页面底部 Artifacts 下载 `video91-debug-apk`，解压得到 `app-debug.apk`，传到手机安装

## 本机构建
Android Studio 打开 `android/` 目录直接 Run；或命令行（需要 JDK 17 和 Android SDK）：

    cd android
    ./gradlew assembleDebug

输出：`app/build/outputs/apk/debug/app-debug.apk`。依赖默认先走阿里云镜像，失败自动回落官方源。

## 说明
- 要求 Android 8.0 (API 26) 及以上
- 允许 http 明文连接，方便局域网地址；外网访问建议在群晖上用反向代理套 https
- 视频能否播放取决于手机解码器：H.264 基本都行，H.265/HEVC 需手机硬件支持
