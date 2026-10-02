package dev.litedoc.viewer.web

import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Navigation and request policy for the single trusted page.
 *
 * * every request is answered by [LocalAssetRouter]; a request for anything else
 *   is refused locally, so no remote script, style, font or document can load;
 * * a top-level navigation to an outside URL is cancelled. Nothing is forwarded
 *   to a browser and nothing is fetched: the UI offers "copy link" instead;
 * * a renderer crash is reported so the activity can fall back to source mode
 *   instead of showing a blank page or letting the same document crash again.
 */
class ViewerWebViewClient(
    private val router: LocalAssetRouter,
    private val onBlockedNavigation: (String) -> Unit,
    private val onMainFrameError: (String, Int, String) -> Unit,
    private val onRenderProcessGone: (Boolean) -> Unit,
) : WebViewClient() {

    override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
    ): WebResourceResponse? = router.handle(request.url)

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url
        if (router.isInternal(url)) return false
        onBlockedNavigation(url.toString())
        return true
    }

    @Suppress("DEPRECATION")
    override fun shouldOverrideUrlLoading(view: WebView, url: String?): Boolean {
        if (url == null) return true
        val uri = Uri.parse(url)
        if (router.isInternal(uri)) return false
        onBlockedNavigation(url)
        return false.let { true }
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (url != null && !isTrustedPage(url)) {
            view.stopLoading()
            onBlockedNavigation(url)
        }
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
    ) {
        if (!request.isForMainFrame) return
        val description = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            error.description?.toString() ?: "unknown error"
        } else {
            "unknown error"
        }
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) error.errorCode else -1
        onMainFrameError(request.url?.toString().orEmpty(), code, description)
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        val crashed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) detail.didCrash() else true
        onRenderProcessGone(crashed)
        // The host activity owns the WebView and destroys it; consuming the event
        // prevents the platform from killing the whole process.
        return true
    }

    /**
     * Only the app's own origin is trusted. This covers the shipped shell and the
     * plain-text source fallback route; everything else is refused by the router
     * anyway, so a navigation to an outside origin can never happen.
     */
    private fun isTrustedPage(url: String): Boolean =
        router.isInternal(Uri.parse(url))
}
