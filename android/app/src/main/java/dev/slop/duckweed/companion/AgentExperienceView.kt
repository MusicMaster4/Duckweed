package dev.slop.duckweed.companion

import android.content.Context
import android.util.AttributeSet
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject

/** Local, bundled desktop renderer. It receives data, never credentials or network access. */
class AgentExperienceView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : WebView(context, attrs) {
    private var ready = false
    private var lastUpdate: String? = null
    private var renderedUpdate: String? = null
    var onUnavailable: (() -> Unit)? = null

    init {
        setBackgroundColor(context.getColor(R.color.duckweed_background))
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.blockNetworkLoads = true
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context))
            .build()
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                loader.shouldInterceptRequest(request.url)
                    ?: WebResourceResponse("text/plain", "UTF-8", java.io.ByteArrayInputStream(ByteArray(0)))
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            override fun onPageFinished(view: WebView, url: String) {
                ready = true
                flush()
            }
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame) onUnavailable?.invoke()
            }
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                ready = false
                onUnavailable?.invoke()
                (parent as? android.view.ViewGroup)?.removeView(this@AgentExperienceView)
                destroy()
                return true
            }
        }
        loadUrl("https://appassets.androidplatform.net/assets/mobile.html")
    }

    fun render(key: String, experience: String, online: Boolean, outgoing: org.json.JSONArray = org.json.JSONArray()) {
        lastUpdate = JSONObject().put("key", key).put("experience", JSONObject(experience)).put("online", online).put("outgoing", outgoing).toString()
        flush()
    }

    fun setOnline(online: Boolean) {
        val update = lastUpdate?.let { JSONObject(it) } ?: return
        if (update.optBoolean("online") == online) return
        lastUpdate = update.put("online", online).toString()
        flush()
    }

    private fun flush() {
        val value = lastUpdate ?: return
        if (!ready || value == renderedUpdate) return
        // Encode as a JSON string, never interpolate transcript text as executable code.
        evaluateJavascript("typeof window.duckweedUpdate === 'function'", { available ->
            if (available == "true") {
                renderedUpdate = value
                evaluateJavascript("window.duckweedUpdate(JSON.parse(${JSONObject.quote(value)}))", null)
            } else postDelayed({ flush() }, 50)
        })
    }

    fun pauseConversation() {
        if (ready) evaluateJavascript("window.duckweedPause?.()", null)
        renderedUpdate = null
        onPause()
    }
}
