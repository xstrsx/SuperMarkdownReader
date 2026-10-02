package dev.litedoc.viewer.web

import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.InputStream

/**
 * Response helpers for the local router. Anything the router refuses produces a
 * controlled 4xx with a short plain-text body, never a fallback to the network.
 */
internal object HttpResponses {

    const val SHELL_MIME = "text/html"

    fun text(
        status: Int,
        reason: String,
        message: String,
        extraHeaders: Map<String, String> = emptyMap(),
    ): WebResourceResponse {
        val bytes = message.toByteArray(Charsets.UTF_8)
        val headers = HashMap<String, String>()
        headers["X-Content-Type-Options"] = "nosniff"
        headers["Cache-Control"] = "no-store"
        headers["Content-Length"] = bytes.size.toString()
        headers.putAll(extraHeaders)
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            status,
            reason,
            headers,
            ByteArrayInputStream(bytes),
        )
    }

    fun notFound(what: String): WebResourceResponse = text(404, "Not Found", "not found: $what")

    fun forbidden(what: String): WebResourceResponse = text(403, "Forbidden", "refused: $what")

    fun gone(what: String): WebResourceResponse = text(410, "Gone", "expired: $what")

    fun stream(
        mimeType: String,
        stream: InputStream,
        contentLength: Long?,
        cacheControl: String,
        status: Int = 200,
        reason: String = "OK",
        extraHeaders: Map<String, String> = emptyMap(),
    ): WebResourceResponse {
        val headers = HashMap<String, String>()
        headers["X-Content-Type-Options"] = "nosniff"
        headers["Cache-Control"] = cacheControl
        if (contentLength != null && contentLength >= 0) {
            headers["Content-Length"] = contentLength.toString()
        }
        headers.putAll(extraHeaders)
        val encoding = if (AssetMime.isTextual(mimeType)) "utf-8" else null
        return WebResourceResponse(mimeType, encoding, status, reason, headers, stream)
    }
}
