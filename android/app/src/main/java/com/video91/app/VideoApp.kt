package com.video91.app

import android.app.Application
import coil.ImageLoader
import coil.ImageLoaderFactory

/** 初始化网络层；图片加载共用同一个带会话 Cookie 的 OkHttp 客户端，封面才能通过鉴权。 */
class VideoApp : Application(), ImageLoaderFactory {
    override fun onCreate() {
        super.onCreate()
        Net.init(this)
    }

    override fun newImageLoader(): ImageLoader =
        ImageLoader.Builder(this)
            .okHttpClient { Net.client }
            .crossfade(true)
            .build()
}
