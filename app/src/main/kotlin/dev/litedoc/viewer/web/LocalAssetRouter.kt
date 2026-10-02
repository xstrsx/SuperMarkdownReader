package dev.litedoc.viewer.web

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import dev.litedoc.viewer.document.DocumentSession
import dev.litedoc.viewer.image.ImageRegistry
import dev.litedoc.viewer.image.RemoteImageRepository
import dev.litedoc.viewer.storage.AttachmentRegistry
import dev.litedoc.viewer.util.Redact
import java.io.ByteArrayInputStream

/**
 * The only trusted page and the only resource routes LiteDoc can serve.
 *
 *   /assets/web/...                              built-in runtime
 *   /session/<opaque-session>/source             current document bytes (UTF-8)
 *   /session/<opaque-session>/resource/<id>      authorised local attachment
 *   /session/<opaque-session>/image/<id>         native image proxy response
 *
 * There is deliberately no generic proxy: no `?url=`, no arbitrary content URI,
 * no way to read another session and no path outside the shipped assets. Anything
 * unregistered is refused with a controlled 4xx, so the WebView can never fall
 * back to the network.
 */
class LocalAssetRouter(
    context: Context,
    private val host: SessionHost,
) {

    interface SessionHost {
        fun currentSession(): DocumentSession?
        fun currentGeneration(): Long
        fun attachment(opaqueId: String): AttachmentRegistry.Entry?
        fun openAttachment(entry: AttachmentRegistry.Entry): java.io.InputStream?
        fun image(opaqueId: String): ImageRegistry.Entry?
        fun fetchImage(entry: ImageRegistry.Entry): RemoteImageRepository.Result
    }

    private val sessionHandler = SessionPathHandler(host)

    private val loader: WebViewAssetLoader = WebViewAssetLoader.Builder()
        .setDomain(DOMAIN)
        .addPathHandler("/assets/", WebAssetsHandler(context))
        .addPathHandler("/session/", sessionHandler)
        .build()

    fun handle(uri: Uri): WebResourceResponse? {
        if (!uri.scheme.equals("https", ignoreCase = true)) {
            return HttpResponses.forbidden("scheme")
        }
        if (uri.host != DOMAIN) {
            return HttpResponses.forbidden("origin")
        }
        val response = loader.shouldInterceptRequest(uri)
        return response ?: HttpResponses.forbidden("unregistered path")
    }

    /** True only for the shipped shell and the session routes of this app. */
    fun isInternal(uri: Uri): Boolean {
        if (!uri.scheme.equals("https", ignoreCase = true)) return false
        if (uri.host != DOMAIN) return false
        val path = uri.path ?: return false
        return path.startsWith("/assets/web/") || path.startsWith("/session/")
    }

    fun release() {
        sessionHandler.release()
    }

    companion object {
        const val DOMAIN = "appassets.androidplatform.net"
        const val ORIGIN = "https://$DOMAIN"
        const val SHELL_URL = "$ORIGIN/assets/web/index.html"
        const val ASSETS_PREFIX = "/assets/"
        const val SESSION_PREFIX = "/session/"

        fun sourceUrl(sessionId: String): String = "$ORIGIN$SESSION_PREFIX$sessionId/source"

        fun resourceUrl(sessionId: String, opaqueId: String): String =
            "$ORIGIN$SESSION_PREFIX$sessionId/resource/$opaqueId"

        fun imageUrl(sessionId: String, opaqueId: String): String =
            "$ORIGIN$SESSION_PREFIX$sessionId/image/$opaqueId"
    }
}

/**
 * Handles `/session/...`. Every route is scoped to the single active session and
 * to the current generation; a stale session id or a message for a replaced
 * document is answered with 410 rather than serving old content.
 */
internal class SessionPathHandler(private val host: LocalAssetRouter.SessionHost) :
    WebViewAssetLoader.PathHandler {

    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)

    fun release() {
        closed.set(true)
    }

    override fun handle(path: String): WebResourceResponse? {
        if (closed.get()) return HttpResponses.gone("session handler closed")
        val parts = path.split('/').filter { it.isNotEmpty() }
        if (parts.size < 2) return HttpResponses.notFound(path)

        val sessionId = parts[0]
        val session = host.currentSession() ?: return HttpResponses.gone("no active document")
        if (session.id != sessionId) return HttpResponses.gone("stale session")

        return when (parts[1]) {
            "source" -> serveSource(session)
            "resource" -> {
                val opaqueId = parts.getOrNull(2) ?: return HttpResponses.notFound("resource id")
                serveAttachment(opaqueId)
            }
            "image" -> {
                val opaqueId = parts.getOrNull(2) ?: return HttpResponses.notFound("image id")
                serveImage(sessionId, opaqueId)
            }
            else -> HttpResponses.notFound(parts[1])
        }
    }

    private fun serveSource(session: DocumentSession): WebResourceResponse {
        val file = session.serveFile
        if (!file.isFile) return HttpResponses.gone("snapshot removed")
        return try {
            HttpResponses.stream(
                mimeType = session.mimeType,
                stream = file.inputStream(),
                contentLength = file.length(),
                cacheControl = "no-store",
            )
        } catch (e: Exception) {
            Redact.w("snapshot stream failed: ${e.javaClass.simpleName}")
            HttpResponses.gone("snapshot unreadable")
        }
    }

    private fun serveAttachment(opaqueId: String): WebResourceResponse {
        val entry = host.attachment(opaqueId) ?: return HttpResponses.notFound("attachment")
        val stream = host.openAttachment(entry)
            ?: return HttpResponses.gone("attachment unavailable")
        return HttpResponses.stream(
            mimeType = entry.mimeType ?: "application/octet-stream",
            stream = stream,
            contentLength = entry.sizeBytes,
            cacheControl = "no-store",
        )
    }

    private fun serveImage(sessionId: String, opaqueId: String): WebResourceResponse {
        val entry = host.image(opaqueId) ?: return HttpResponses.notFound("image")
        return when (val result = host.fetchImage(entry)) {
            is RemoteImageRepository.Result.Success -> {
                val headers = HashMap<String, String>()
                headers["Content-Security-Policy"] =
                    "default-src 'none'; style-src 'unsafe-inline'; sandbox"
                headers["Access-Control-Allow-Origin"] = LocalAssetRouter.ORIGIN
                HttpResponses.stream(
                    mimeType = result.mimeType,
                    stream = ByteArrayInputStream(result.bytes),
                    contentLength = result.bytes.size.toLong(),
                    cacheControl = "private, max-age=3600",
                    extraHeaders = headers,
                )
            }
            is RemoteImageRepository.Result.Failure -> when (result.reason) {
                RemoteImageRepository.Result.Reason.DISABLED ->
                    HttpResponses.text(403, "Disabled", "remote images disabled for this session")
                RemoteImageRepository.Result.Reason.CANCELLED ->
                    HttpResponses.text(499, "Cancelled", "request cancelled")
                RemoteImageRepository.Result.Reason.POLICY ->
                    HttpResponses.forbidden("image policy: ${result.detail ?: "blocked"}")
                RemoteImageRepository.Result.Reason.TOO_LARGE ->
                    HttpResponses.text(413, "Too Large", "image exceeds the size budget")
                RemoteImageRepository.Result.Reason.NOT_IMAGE ->
                    HttpResponses.text(415, "Not An Image", "response is not an image")
                RemoteImageRepository.Result.Reason.HTTP_ERROR ->
                    HttpResponses.text(502, "Upstream Error", "upstream status ${result.detail}")
                RemoteImageRepository.Result.Reason.NETWORK ->
                    HttpResponses.text(504, "Network Error", "image request failed")
            }
        }
    }
}
