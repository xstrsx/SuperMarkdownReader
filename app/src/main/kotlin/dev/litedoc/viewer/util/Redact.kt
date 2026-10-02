package dev.litedoc.viewer.util

import android.util.Log
import java.net.URI

/**
 * Logging helper that never writes document contents, tokens, query strings or
 * credentials. Remote URLs are reduced to scheme://host[:port]/… before they are
 * logged.
 */
object Redact {

    private const val TAG = "LiteDoc"

    fun url(raw: String?): String {
        if (raw == null) return "<null>"
        return try {
            val uri = URI(raw)
            val scheme = uri.scheme ?: "?"
            val host = uri.host ?: "?"
            val port = if (uri.port > 0) ":${uri.port}" else ""
            val hadQuery = uri.rawQuery != null
            val hadFragment = uri.rawFragment != null
            buildString {
                append(scheme).append("://").append(host).append(port).append("/…")
                if (hadQuery) append("?<hidden>")
                if (hadFragment) append("#<hidden>")
            }
        } catch (_: Exception) {
            "<unparseable>"
        }
    }

    /** Stable, non-reversible cache key for a URL (never logged with the URL itself). */
    fun urlKey(raw: String): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val bytes = digest.digest(raw.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xFF
            sb.append(HEX[v ushr 4]).append(HEX[v and 0x0F])
        }
        return sb.toString()
    }

    fun d(message: String) = Log.d(TAG, message)

    fun i(message: String) = Log.i(TAG, message)

    fun w(message: String, error: Throwable? = null) {
        if (error == null) Log.w(TAG, message) else Log.w(TAG, message, error)
    }

    fun e(message: String, error: Throwable? = null) {
        if (error == null) Log.e(TAG, message) else Log.e(TAG, message, error)
    }

    private val HEX = "0123456789abcdef".toCharArray()
}
