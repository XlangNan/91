package com.video91.app

import android.content.Context
import android.net.Uri
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import java.io.IOException
import java.util.concurrent.TimeUnit

/** 服务端返回 401：会话失效且自动重登失败，界面需要回到登录页。 */
class UnauthorizedException : IOException("登录已失效，请重新登录")

/** 本地保存的设置：服务器地址、账号、会话和每个视频的播放进度。 */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("video91", Context.MODE_PRIVATE)

    var server: String
        get() = sp.getString("server", "") ?: ""
        set(v) = sp.edit().putString("server", v).apply()

    var username: String
        get() = sp.getString("username", "") ?: ""
        set(v) = sp.edit().putString("username", v).apply()

    var password: String
        get() = sp.getString("password", "") ?: ""
        set(v) = sp.edit().putString("password", v).apply()

    /** vs_admin 会话 Cookie 的值。 */
    var session: String
        get() = sp.getString("session", "") ?: ""
        set(v) = sp.edit().putString("session", v).apply()

    fun position(id: String): Long = sp.getLong("pos_$id", 0L)

    /** 看到接近结尾（最后 10 秒）视为看完，清掉进度，下次从头播。 */
    fun savePosition(id: String, positionMs: Long, durationMs: Long) {
        val finished = durationMs > 0 && positionMs >= durationMs - 10_000
        val e = sp.edit()
        if (finished || positionMs < 5_000) e.remove("pos_$id") else e.putLong("pos_$id", positionMs)
        e.apply()
    }

    fun logout() {
        sp.edit().remove("session").remove("password").apply()
    }
}

/** 只给自己的服务器带会话 Cookie，不会泄露给其他域名。 */
private class SessionCookieJar : CookieJar {
    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (c in cookies) {
            if (c.name != SESSION_COOKIE) continue
            val expired = c.expiresAt < System.currentTimeMillis()
            Net.prefs.session = if (c.value.isEmpty() || expired) "" else c.value
        }
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val session = Net.prefs.session
        if (session.isEmpty() || url.host != Net.host) return emptyList()
        return listOf(
            Cookie.Builder().name(SESSION_COOKIE).value(session).domain(url.host).path("/").build()
        )
    }
}

/** 遇到 401 时用保存的账号密码静默重新登录一次，再重试原请求（图片、视频流同样生效）。 */
private class ReloginAuthenticator : Authenticator {
    override fun authenticate(route: Route?, response: Response): Request? {
        if (response.request.url.encodedPath.endsWith("/admin/api/login")) return null
        if (priorCount(response) >= 2) return null
        synchronized(Net) {
            if (!Net.relogin()) return null
        }
        return response.request.newBuilder().removeHeader("Cookie").build()
    }

    private fun priorCount(response: Response): Int {
        var n = 1
        var r = response.priorResponse
        while (r != null) {
            n++
            r = r.priorResponse
        }
        return n
    }
}

private const val SESSION_COOKIE = "vs_admin"

object Net {
    lateinit var prefs: Prefs
        private set
    lateinit var client: OkHttpClient
        private set

    val json = Json {
        ignoreUnknownKeys = true
        coerceInputValues = true
    }

    /** 服务器地址，不带结尾斜杠，例如 http://192.168.1.10:9191。 */
    val base: String get() = prefs.server

    val host: String get() = Uri.parse(prefs.server).host ?: ""

    fun init(context: Context) {
        prefs = Prefs(context.applicationContext)
        client = OkHttpClient.Builder()
            .cookieJar(SessionCookieJar())
            .authenticator(ReloginAuthenticator())
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60, TimeUnit.SECONDS)
            .build()
    }

    fun normalizeServer(raw: String): String {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) return ""
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://$s"
        return s
    }

    /** 用已保存的账号密码重新登录。成功返回 true。 */
    fun relogin(): Boolean {
        val user = prefs.username
        val pass = prefs.password
        if (prefs.server.isEmpty() || user.isEmpty() || pass.isEmpty()) return false
        return try {
            doLogin(user, pass)
            prefs.session.isNotEmpty()
        } catch (e: IOException) {
            false
        }
    }

    /** 登录；失败抛出带中文说明的 IOException。 */
    fun doLogin(user: String, pass: String) {
        val body = json.encodeToString(LoginBody.serializer(), LoginBody(user, pass))
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$base/admin/api/login").post(body).build()
        val plain = client.newBuilder().authenticator(Authenticator.NONE).build()
        plain.newCall(req).execute().use { r ->
            when {
                r.isSuccessful -> Unit
                r.code == 400 -> throw IOException("用户名或密码错误")
                r.code == 403 -> throw IOException("账号已被封禁，或当前 IP 被临时封禁")
                r.code == 428 -> throw IOException("网站尚未初始化，请先用浏览器打开网站完成管理员设置")
                else -> throw IOException("登录失败（HTTP ${r.code}）")
            }
        }
    }

    @Serializable
    private data class LoginBody(val username: String, val password: String)
}
