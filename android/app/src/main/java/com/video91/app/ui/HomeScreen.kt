package com.video91.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.video91.app.Api
import com.video91.app.Tag
import com.video91.app.UnauthorizedException
import com.video91.app.VideoItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 首页状态放在 ViewModel 里：进入播放页再返回，列表和筛选条件都还在。 */
class HomeViewModel : ViewModel() {
    var sort by mutableStateOf("")
    var query by mutableStateOf("")
    var tag by mutableStateOf("")
    var tags by mutableStateOf<List<Tag>>(emptyList())
    val items = mutableStateListOf<VideoItem>()
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var unauthorized by mutableStateOf(false)

    private var page = 0
    private var total = Int.MAX_VALUE
    private var generation = 0
    private var job: Job? = null

    init {
        loadTags()
        reload()
    }

    fun reload() {
        generation++
        job?.cancel()
        items.clear()
        page = 0
        total = Int.MAX_VALUE
        error = null
        loading = false
        loadMore()
    }

    fun loadMore() {
        if (loading || items.size >= total) return
        loading = true
        error = null
        val g = generation
        job = viewModelScope.launch {
            try {
                val r = withContext(Dispatchers.IO) { Api.list(page + 1, sort, query, tag) }
                if (g == generation) {
                    page += 1
                    total = if (r.items.isEmpty()) items.size else r.total
                    items.addAll(r.items)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: UnauthorizedException) {
                if (g == generation) unauthorized = true
            } catch (e: Exception) {
                if (g == generation) error = e.message ?: "加载失败"
            } finally {
                if (g == generation) loading = false
            }
        }
    }

    private fun loadTags() {
        viewModelScope.launch {
            try {
                tags = withContext(Dispatchers.IO) { Api.tags() }
            } catch (e: CancellationException) {
                throw e
            } catch (e: UnauthorizedException) {
                unauthorized = true
            } catch (e: Exception) {
                // 标签只是辅助筛选，加载失败不影响浏览
            }
        }
    }
}

private val SORTS = listOf("" to "全部", "latest" to "最新", "hot" to "最热")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    onOpen: (String) -> Unit,
    onShorts: () -> Unit,
    onLogout: () -> Unit,
    onUnauthorized: () -> Unit,
    vm: HomeViewModel = viewModel(),
) {
    var searching by remember { mutableStateOf(false) }
    var draft by remember { mutableStateOf(vm.query) }
    var menuOpen by remember { mutableStateOf(false) }
    val gridState = rememberLazyGridState()

    LaunchedEffect(vm.unauthorized) { if (vm.unauthorized) onUnauthorized() }

    // 滑到倒数第 6 个左右就提前加载下一页
    LaunchedEffect(gridState) {
        snapshotFlow {
            val info = gridState.layoutInfo
            (info.visibleItemsInfo.lastOrNull()?.index ?: 0) to info.totalItemsCount
        }.collect { (last, count) ->
            if (count > 0 && last >= count - 6) vm.loadMore()
        }
    }

    fun runSearch() {
        vm.query = draft.trim()
        vm.reload()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    if (searching) {
                        TextField(
                            value = draft,
                            onValueChange = { draft = it },
                            singleLine = true,
                            placeholder = { Text("搜索标题 / 作者") },
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                            keyboardActions = KeyboardActions(onSearch = { runSearch() }),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    } else {
                        Text(if (vm.query.isEmpty()) "视频" else "搜索：${vm.query}")
                    }
                },
                actions = {
                    if (searching) {
                        IconButton(onClick = {
                            searching = false
                            draft = ""
                            if (vm.query.isNotEmpty()) {
                                vm.query = ""
                                vm.reload()
                            }
                        }) { Icon(Icons.Filled.Close, contentDescription = "关闭搜索") }
                    } else {
                        IconButton(onClick = { searching = true }) {
                            Icon(Icons.Filled.Search, contentDescription = "搜索")
                        }
                        IconButton(onClick = onShorts) {
                            Icon(Icons.Filled.PlayArrow, contentDescription = "刷片")
                        }
                        Box {
                            IconButton(onClick = { menuOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "更多")
                            }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text("刷新") },
                                    onClick = {
                                        menuOpen = false
                                        vm.reload()
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("退出登录") },
                                    onClick = {
                                        menuOpen = false
                                        onLogout()
                                    },
                                )
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            TabRow(selectedTabIndex = SORTS.indexOfFirst { it.first == vm.sort }.coerceAtLeast(0)) {
                SORTS.forEach { (key, label) ->
                    Tab(
                        selected = vm.sort == key,
                        onClick = {
                            if (vm.sort != key) {
                                vm.sort = key
                                vm.reload()
                            }
                        },
                        text = { Text(label) },
                    )
                }
            }
            if (vm.tags.isNotEmpty()) {
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(vm.tags) { t ->
                        FilterChip(
                            selected = vm.tag == t.label,
                            onClick = {
                                vm.tag = if (vm.tag == t.label) "" else t.label
                                vm.reload()
                            },
                            label = { Text(t.label) },
                        )
                    }
                }
            }
            Box(Modifier.fillMaxSize()) {
                LazyVerticalGrid(
                    state = gridState,
                    columns = GridCells.Adaptive(minSize = 170.dp),
                    contentPadding = PaddingValues(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(vm.items, key = { it.id }) { v -> VideoCard(v) { onOpen(v.id) } }
                    if (vm.loading && vm.items.isNotEmpty()) {
                        item(span = { GridItemSpan(maxLineSpan) }) {
                            Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                                CircularProgressIndicator(strokeWidth = 2.dp)
                            }
                        }
                    }
                }
                if (vm.items.isEmpty()) {
                    when {
                        vm.loading -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                        vm.error != null -> ErrorBox(vm.error.orEmpty(), Modifier.align(Alignment.Center)) { vm.loadMore() }
                        else -> Text(
                            "没有找到视频。可以到网站后台「存储」里添加本地目录并扫描。",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.align(Alignment.Center).padding(24.dp),
                        )
                    }
                } else if (vm.error != null) {
                    ErrorBox(vm.error.orEmpty(), Modifier.align(Alignment.BottomCenter)) { vm.loadMore() }
                }
            }
        }
    }
}

@Composable
private fun ErrorBox(message: String, modifier: Modifier, onRetry: () -> Unit) {
    Column(modifier.padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, color = MaterialTheme.colorScheme.primary)
        Button(onClick = onRetry, modifier = Modifier.padding(top = 8.dp)) { Text("重试") }
    }
}

@Composable
private fun VideoCard(v: VideoItem, onClick: () -> Unit) {
    Column(Modifier.clickable(onClick = onClick)) {
        Box(
            Modifier
                .fillMaxWidth()
                .aspectRatio(16f / 9f)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
        ) {
            if (v.thumbnail.isNotEmpty()) {
                AsyncImage(
                    model = Api.abs(v.thumbnail),
                    contentDescription = v.title,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            if (v.duration.isNotEmpty()) {
                Text(
                    v.duration,
                    color = Color.White,
                    fontSize = 11.sp,
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(6.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(Color(0xB3000000))
                        .padding(horizontal = 5.dp, vertical = 1.dp),
                )
            }
        }
        Text(
            v.title.ifEmpty { "未命名" },
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(top = 6.dp),
        )
        Row {
            Text(
                listOfNotNull(v.author.ifEmpty { null }, "${v.views} 次播放").joinToString(" · "),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
