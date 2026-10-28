package com.video91.app

import android.net.Uri
import kotlinx.serialization.Serializable
import okhttp3.Request
import java.io.IOException

@Serializable
data class VideoItem(
    val id: String,
    val title: String = "",
    val thumbnail: String = "",
    val duration: String = "",
    val author: String = "",
    val views: Int = 0,
    val tags: List<String> = emptyList(),
)

@Serializable
data class ListResponse(
    val items: List<VideoItem> = emptyList(),
    val total: Int = 0,
    val page: Int = 1,
    val size: Int = 0,
)

@Serializable
data class Tag(val id: String = "", val label: String = "", val count: Int = 0)

@Serializable
data class VideoDetail(
    val id: String,
    val title: String = "",
    val author: String = "",
    val views: Int = 0,
    val duration: String = "",
    val tags: List<String> = emptyList(),
    val videoSrc: String = "",
    val mediaType: String = "",
    val poster: String = "",
)

@Serializable
data class ShortItem(
    val id: String,
    val title: String = "",
    val author: String = "",
    val videoSrc: String = "",
    val poster: String = "",
    val mediaType: String = "",
)

@Serializable
data class ShortsResponse(
    val items: List<ShortItem> = emptyList(),
    val total: Int = 0,
    val feedToken: String = "",
    val nextCursor: Int = 0,
    val roundComplete: Boolean = false,
)

/** 所有请求都是阻塞调用，请在 Dispatchers.IO 里使用。 */
object Api {
    private const val PAGE_SIZE = 24

    /** 把服务器返回的相对路径（/p/stream/...、/p/thumb/...）补成完整地址。 */
    fun abs(path: String): String {
        if (path.isBlank()) return ""
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        return Net.base + if (path.startsWith("/")) path else "/$path"
    }

    private fun get(path: String): String {
        val req = Request.Builder().url(Net.base + path).get().build()
        Net.client.newCall(req).execute().use { r ->
            if (r.code == 401) throw UnauthorizedException()
            val text = r.body?.string().orEmpty()
            if (!r.isSuccessful) throw IOException("请求失败（HTTP ${r.code}）${text.take(120)}")
            return text
        }
    }

    fun list(page: Int, sort: String, query: String, tag: String): ListResponse {
        val q = StringBuilder("/api/list?page=$page&size=$PAGE_SIZE")
        if (sort.isNotEmpty()) q.append("&sort=").append(Uri.encode(sort))
        if (query.isNotEmpty()) q.append("&q=").append(Uri.encode(query))
        if (tag.isNotEmpty()) q.append("&tag=").append(Uri.encode(tag))
        return Net.json.decodeFromString(ListResponse.serializer(), get(q.toString()))
    }

    fun tags(): List<Tag> =
        Net.json.decodeFromString(kotlinx.serialization.builtins.ListSerializer(Tag.serializer()), get("/api/tags"))

    fun detail(id: String): VideoDetail =
        Net.json.decodeFromString(VideoDetail.serializer(), get("/api/video/${Uri.encode(id)}"))

    fun shorts(feedToken: String, cursor: Int): ShortsResponse {
        val q = StringBuilder("/api/shorts/next?mode=recommend&count=5&cursor=$cursor")
        if (feedToken.isNotEmpty()) q.append("&feedToken=").append(Uri.encode(feedToken))
        return Net.json.decodeFromString(ShortsResponse.serializer(), get(q.toString()))
    }
}
