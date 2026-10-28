package com.video91.app.ui

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.pager.VerticalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import coil.compose.AsyncImage
import com.video91.app.Api
import com.video91.app.Net
import com.video91.app.ShortItem
import com.video91.app.UnauthorizedException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 刷片队列放在 ViewModel 里，退出再进来还停在原来的位置。 */
class ShortsViewModel : ViewModel() {
    val items = mutableStateListOf<ShortItem>()
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var unauthorized by mutableStateOf(false)

    private var token = ""
    private var cursor = 0

    init {
        loadMore()
    }

    fun loadMore() {
        if (loading) return
        loading = true
        error = null
        viewModelScope.launch {
            try {
                val r = withContext(Dispatchers.IO) { Api.shorts(token, cursor) }
                token = r.feedToken
                cursor = r.nextCursor
                val known = items.map { it.id }.toHashSet()
                items.addAll(r.items.filter { known.add(it.id) })
                // 这一轮推完了：下次不带 token，服务器会重新洗牌开新一轮
                if (r.roundComplete) {
                    token = ""
                    cursor = 0
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: UnauthorizedException) {
                unauthorized = true
            } catch (e: Exception) {
                // 服务器端的刷片会话过期等情况：丢掉旧 token，下次重新开始
                token = ""
                cursor = 0
                error = e.message ?: "加载失败"
            } finally {
                loading = false
            }
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
fun ShortsScreen(onBack: () -> Unit, onUnauthorized: () -> Unit, vm: ShortsViewModel = viewModel()) {
    val context = LocalContext.current
    val activity = context.findActivity()
    var playing by remember { mutableStateOf(false) }
    var playError by remember { mutableStateOf<String?>(null) }

    val player = remember {
        ExoPlayer.Builder(context)
            .setMediaSourceFactory(DefaultMediaSourceFactory(OkHttpDataSource.Factory(Net.client)))
            .build()
            .apply { repeatMode = Player.REPEAT_MODE_ONE }
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            override fun onPlayerError(e: PlaybackException) {
                playError = "这个视频无法播放（${e.errorCodeName}），上滑看下一个"
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }

    DisposableEffect(activity) {
        val owner = activity as? androidx.lifecycle.LifecycleOwner
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP) player.pause()
        }
        owner?.lifecycle?.addObserver(observer)
        onDispose { owner?.lifecycle?.removeObserver(observer) }
    }

    LaunchedEffect(vm.unauthorized) { if (vm.unauthorized) onUnauthorized() }

    val pager = rememberPagerState(pageCount = { vm.items.size })
    val hasItems = vm.items.isNotEmpty()

    // 翻到哪个就播哪个；还剩 3 个时提前拉下一批
    LaunchedEffect(pager.settledPage, hasItems) {
        val item = vm.items.getOrNull(pager.settledPage) ?: return@LaunchedEffect
        playError = null
        val media = MediaItem.Builder()
            .setUri(Api.abs(item.videoSrc))
            .apply { if (item.mediaType.isNotEmpty()) setMimeType(item.mediaType) }
            .build()
        player.setMediaItem(media)
        player.prepare()
        player.playWhenReady = true
        if (pager.settledPage >= vm.items.size - 3) vm.loadMore()
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (!hasItems) {
            if (vm.loading) {
                CircularProgressIndicator(Modifier.align(Alignment.Center))
            } else {
                Column(Modifier.align(Alignment.Center).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(vm.error ?: "还没有可刷的视频", color = Color.White)
                    Button(onClick = { vm.loadMore() }, modifier = Modifier.padding(top = 12.dp)) { Text("重试") }
                }
            }
        } else {
            VerticalPager(state = pager, modifier = Modifier.fillMaxSize()) { page ->
                val item = vm.items[page]
                val current = page == pager.settledPage
                Box(
                    Modifier
                        .fillMaxSize()
                        .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {
                            if (current) player.playWhenReady = !player.playWhenReady
                        },
                ) {
                    AsyncImage(
                        model = Api.abs(item.poster),
                        contentDescription = null,
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxSize(),
                    )
                    if (current) {
                        AndroidView(
                            modifier = Modifier.fillMaxSize(),
                            factory = { ctx ->
                                PlayerView(ctx).apply {
                                    useController = false
                                    resizeMode = AspectRatioFrameLayout.RESIZE_MODE_FIT
                                    setShutterBackgroundColor(Color.Transparent.toArgb())
                                    this.player = player
                                }
                            },
                            onRelease = { it.player = null },
                        )
                        if (!playing && playError == null) {
                            Icon(
                                Icons.Filled.PlayArrow,
                                contentDescription = "播放",
                                tint = Color.White.copy(alpha = 0.8f),
                                modifier = Modifier.align(Alignment.Center),
                            )
                        }
                    }
                    Column(
                        Modifier
                            .align(Alignment.BottomStart)
                            .navigationBarsPadding()
                            .padding(start = 16.dp, end = 16.dp, bottom = 24.dp),
                    ) {
                        Text(
                            item.title.ifEmpty { "未命名" },
                            color = Color.White,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.titleSmall,
                        )
                        if (item.author.isNotEmpty()) {
                            Text("@${item.author}", color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.bodySmall)
                        }
                        if (current) {
                            playError?.let { Text(it, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 6.dp)) }
                        }
                    }
                }
            }
        }
        IconButton(onClick = onBack, modifier = Modifier.statusBarsPadding().padding(4.dp).align(Alignment.TopStart)) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回", tint = Color.White)
        }
    }
}
