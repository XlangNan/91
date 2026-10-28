package com.video91.app.ui

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import androidx.activity.compose.BackHandler
import androidx.annotation.OptIn
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import com.video91.app.Api
import com.video91.app.Net
import com.video91.app.UnauthorizedException
import com.video91.app.VideoDetail
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@OptIn(UnstableApi::class)
@Composable
fun PlayerScreen(id: String, onBack: () -> Unit, onUnauthorized: () -> Unit) {
    val context = LocalContext.current
    val activity = context.findActivity()
    val view = LocalView.current
    val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

    var detail by remember { mutableStateOf<VideoDetail?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableStateOf(0) }

    val player = remember {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(Net.client)))
            .build()
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlayerError(e: PlaybackException) {
                error = "无法播放：${e.errorCodeName}。可能是手机不支持该视频编码（如 H.265/HEVC）。"
            }
        }
        player.addListener(listener)
        onDispose {
            Net.prefs.savePosition(id, player.currentPosition, player.duration)
            player.removeListener(listener)
            player.release()
        }
    }

    LaunchedEffect(id, attempt) {
        error = null
        try {
            val d = withContext(Dispatchers.IO) { Api.detail(id) }
            detail = d
            val item = MediaItem.Builder()
                .setUri(Api.abs(d.videoSrc))
                .apply { if (d.mediaType.isNotEmpty()) setMimeType(d.mediaType) }
                .build()
            player.setMediaItem(item)
            player.prepare()
            val resume = Net.prefs.position(id)
            if (resume > 0) player.seekTo(resume)
            player.playWhenReady = true
        } catch (e: UnauthorizedException) {
            onUnauthorized()
        } catch (e: java.io.IOException) {
            error = e.message ?: "加载失败"
        }
    }

    // 退到后台或锁屏时暂停，并记下进度
    DisposableEffect(activity) {
        val owner = activity as? androidx.lifecycle.LifecycleOwner
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP) {
                player.pause()
                Net.prefs.savePosition(id, player.currentPosition, player.duration)
            }
        }
        owner?.lifecycle?.addObserver(observer)
        onDispose { owner?.lifecycle?.removeObserver(observer) }
    }

    // 横屏 = 全屏：隐藏系统栏；离开页面时恢复竖屏和系统栏
    DisposableEffect(landscape) {
        val window = activity?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, view) }
        if (landscape) {
            controller?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            controller?.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller?.show(WindowInsetsCompat.Type.systemBars())
        }
        onDispose { controller?.show(WindowInsetsCompat.Type.systemBars()) }
    }
    DisposableEffect(Unit) {
        onDispose { activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED }
    }

    // PlayerView 的全屏按钮监听只创建一次，所以每次都从 Activity 读取当前方向，不能用捕获的 landscape
    fun toggleFullscreen() {
        val a = activity ?: return
        val nowLandscape = a.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        a.requestedOrientation =
            if (nowLandscape) ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
            else ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    }

    BackHandler {
        if (landscape) toggleFullscreen() else onBack()
    }

    val playerView: @Composable (Modifier) -> Unit = { modifier ->
        AndroidView(
            modifier = modifier,
            factory = { ctx ->
                PlayerView(ctx).apply {
                    this.player = player
                    useController = true
                    setFullscreenButtonClickListener { toggleFullscreen() }
                }
            },
            update = { it.player = player },
        )
    }

    if (landscape) {
        Box(Modifier.fillMaxSize()) { playerView(Modifier.fillMaxSize()) }
    } else {
        Column(Modifier.fillMaxSize().statusBarsPadding()) {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f)) { playerView(Modifier.fillMaxSize()) }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                val d = detail
                Text(d?.title?.ifEmpty { "未命名" } ?: "加载中…", style = MaterialTheme.typography.titleMedium)
                if (d != null) {
                    Text(
                        listOfNotNull(d.author.ifEmpty { null }, "${d.views} 次播放", d.duration.ifEmpty { null })
                            .joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    if (d.tags.isNotEmpty()) {
                        Text(
                            d.tags.joinToString("  ") { "#$it" },
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.padding(top = 8.dp),
                        )
                    }
                }
                error?.let {
                    Text(it, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 12.dp))
                    Button(onClick = { attempt++ }, modifier = Modifier.padding(top = 8.dp)) { Text("重试") }
                }
                Button(onClick = onBack, modifier = Modifier.padding(top = 16.dp).align(Alignment.Start)) { Text("返回") }
            }
        }
    }
}
