package dev.litedoc.viewer.web

import android.content.Context
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import dev.litedoc.viewer.util.Redact
import java.io.FileNotFoundException
import java.io.IOException
import java.io.InputStream
import org.json.JSONObject

/**
 * Serves the built-in runtime from `assets/web/...` with explicit MIME types.
 *
 * `.mjs`/`.js` must be served as JavaScript or module imports fail, and the
 * assets are addressed only by a normalised relative path: `..`, backslashes,
 * NUL bytes and absolute paths are refused before the AssetManager is touched.
 *
 * A generated alias table (web/vendor-manifest.json) lets a few known upstream
 * path spellings for the MathJax font data resolve to their single shipped copy
 * without duplicating megabytes of glyph data in the APK.
 */
internal class WebAssetsHandler(private val context: Context) : WebViewAssetLoader.PathHandler {

    private val aliases: Map<String, String> by lazy { loadAliases() }

    override fun handle(path: String): WebResourceResponse? {
        val normalized = normalize(path) ?: return HttpResponses.forbidden("asset path")
        val direct = "web/$normalized"
        openAsset(direct)?.let { stream ->
            return HttpResponses.stream(
                mimeType = AssetMime.of(direct),
                stream = stream,
                contentLength = sizeOf(direct),
                cacheControl = "no-cache",
            )
        }
        val alias = aliases[normalized]
        if (alias != null) {
            val target = "web/${normalize(alias) ?: return HttpResponses.forbidden("alias path")}"
            openAsset(target)?.let { stream ->
                return HttpResponses.stream(
                    mimeType = AssetMime.of(target),
                    stream = stream,
                    contentLength = sizeOf(target),
                    cacheControl = "no-cache",
                )
            }
        }
        return HttpResponses.notFound(normalized)
    }

    private fun normalize(raw: String): String? {
        if (raw.isEmpty()) return null
        if (raw.indexOf('\u0000') >= 0) return null
        if (raw.startsWith("/") || raw.startsWith("\\")) return null
        val decoded = try {
            java.net.URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8")
        } catch (_: Exception) {
            return null
        }
        if (decoded.indexOf('\u0000') >= 0) return null
        if (decoded.contains('\\')) return null
        val segments = ArrayList<String>()
        for (part in decoded.split('/')) {
            when (part) {
                "", "." -> Unit
                ".." -> return null
                else -> {
                    if (part.contains(':')) return null
                    segments.add(part)
                }
            }
        }
        if (segments.isEmpty()) return null
        return segments.joinToString("/")
    }

    private fun openAsset(assetPath: String): InputStream? = try {
        context.assets.open(assetPath, android.content.res.AssetManager.ACCESS_STREAMING)
    } catch (_: FileNotFoundException) {
        null
    } catch (e: IOException) {
        Redact.w("asset open failed for a local path: ${e.javaClass.simpleName}")
        null
    }

    private fun sizeOf(assetPath: String): Long? = try {
        context.assets.openFd(assetPath).use { it.length }
    } catch (_: Exception) {
        null
    }

    private fun loadAliases(): Map<String, String> {
        return try {
            val text = context.assets.open("web/vendor-manifest.json")
                .use { it.readBytes().toString(Charsets.UTF_8) }
            val json = JSONObject(text)
            val aliases = json.optJSONObject("aliases") ?: return emptyMap()
            val out = HashMap<String, String>()
            val keys = aliases.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                val value = aliases.optString(key)
                if (key.isNotEmpty() && value.isNotEmpty()) out[key] = value
            }
            out
        } catch (e: Exception) {
            Redact.w("vendor manifest unavailable: ${e.javaClass.simpleName}")
            emptyMap()
        }
    }
}
