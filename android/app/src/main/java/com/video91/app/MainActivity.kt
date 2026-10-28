package com.video91.app

import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.video91.app.ui.AppTheme
import com.video91.app.ui.HomeScreen
import com.video91.app.ui.LoginScreen
import com.video91.app.ui.PlayerScreen
import com.video91.app.ui.ShortsScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            AppTheme {
                Surface(modifier = Modifier.fillMaxSize()) { AppNav() }
            }
        }
    }
}

@Composable
private fun AppNav() {
    val nav = rememberNavController()
    val loggedIn = Net.prefs.session.isNotEmpty() && Net.prefs.server.isNotEmpty()
    val toLogin: () -> Unit = {
        nav.navigate("login") { popUpTo(0) { inclusive = true } }
    }

    NavHost(navController = nav, startDestination = if (loggedIn) "home" else "login") {
        composable("login") {
            LoginScreen(onDone = { nav.navigate("home") { popUpTo(0) { inclusive = true } } })
        }
        composable("home") {
            HomeScreen(
                onOpen = { id -> nav.navigate("play/${Uri.encode(id)}") },
                onShorts = { nav.navigate("shorts") },
                onLogout = {
                    Net.prefs.logout()
                    toLogin()
                },
                onUnauthorized = toLogin,
            )
        }
        composable(
            route = "play/{id}",
            arguments = listOf(navArgument("id") { type = NavType.StringType }),
        ) { entry ->
            PlayerScreen(
                id = entry.arguments?.getString("id").orEmpty(),
                onBack = { nav.popBackStack() },
                onUnauthorized = toLogin,
            )
        }
        composable("shorts") {
            ShortsScreen(onBack = { nav.popBackStack() }, onUnauthorized = toLogin)
        }
    }
}
