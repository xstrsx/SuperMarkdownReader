package dev.litedoc.viewer.web

/** Explicit MIME table for the local runtime. */
internal object AssetMime {

    private val table = mapOf(
        "html" to "text/html",
        "htm" to "text/html",
        "js" to "text/javascript",
        "mjs" to "text/javascript",
        "cjs" to "text/javascript",
        "css" to "text/css",
        "json" to "application/json",
        "map" to "application/json",
        "txt" to "text/plain",
        "md" to "text/markdown",
        "csv" to "text/csv",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "avif" to "image/avif",
        "bmp" to "image/bmp",
        "ico" to "image/x-icon",
        "woff" to "font/woff",
        "woff2" to "font/woff2",
        "ttf" to "font/ttf",
        "otf" to "font/otf",
        "wasm" to "application/wasm",
        "xml" to "application/xml",
    )

    fun of(path: String): String {
        val ext = path.substringAfterLast('.', "").lowercase()
        return table[ext] ?: "application/octet-stream"
    }

    fun isTextual(mime: String): Boolean =
        mime.startsWith("text/") ||
            mime == "application/json" ||
            mime == "application/xml" ||
            mime == "image/svg+xml"
}
