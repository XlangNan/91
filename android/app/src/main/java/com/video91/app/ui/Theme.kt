package com.video91.app.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val Colors = darkColorScheme(
    primary = Color(0xFFFF6B6B),
    onPrimary = Color.White,
    background = Color(0xFF0F0F12),
    surface = Color(0xFF16161A),
    surfaceVariant = Color(0xFF22222A),
    onSurface = Color(0xFFECECEF),
    onSurfaceVariant = Color(0xFFA7A7B3),
)

@Composable
fun AppTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = Colors, content = content)
}

/** 从 Compose 的 Context 一层层剥出 Activity，用来切换横竖屏和系统栏。 */
fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}
