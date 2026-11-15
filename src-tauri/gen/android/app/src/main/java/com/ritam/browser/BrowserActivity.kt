package com.ritam.browser

import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

/**
 * Hosts the shared browsing window on Android. Tauri has no child webviews on
 * mobile, so tabs are rendered in this dedicated activity instead.
 *
 * The injected page toolbar's "Ritam" button calls window.RitamAndroid.goHome(),
 * which finishes this activity and returns the user to the shell. The bridge
 * exposes nothing else, so remote pages gain no capabilities from it.
 */
class BrowserActivity : TauriActivity() {
  /** Tiny JS bridge: the only thing a page can do is ask to go home. */
  inner class HomeBridge {
    @JavascriptInterface
    fun goHome() {
      runOnUiThread { finish() }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(HomeBridge(), "RitamAndroid")
  }
}
