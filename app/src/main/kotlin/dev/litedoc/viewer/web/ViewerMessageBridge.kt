package dev.litedoc.viewer.web

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import dev.litedoc.viewer.util.Json
import dev.litedoc.viewer.util.Limits
import dev.litedoc.viewer.util.Redact
import org.json.JSONArray
import org.json.JSONObject

/**
 * The only control channel between the trusted page and native code.
 *
 * Security properties:
 * * `WebViewCompat.addWebMessageListener` with the exact origin
 *   `https://appassets.androidplatform.net`; no `*`, and messages from a
 *   sub-frame are ignored;
 * * the session id and generation inside every message must match the active
 *   document, so a stale or forged message cannot read another document;
 * * a strict method allowlist with per-method argument validation and a
 *   [Limits.BRIDGE_MESSAGE_MAX_BYTES] size cap; there is no generic fetch, no
 *   file access, no arbitrary Intent and no shell;
 * * document text never travels over the bridge: it is streamed from the local
 *   resource route, so no huge `evaluateJavascript` strings are built.
 */
class ViewerMessageBridge(private val host: Host) {

    interface Host {
        fun currentSessionId(): String?
        fun currentGeneration(): Long
        fun onWebReady(): JSONObject
        fun onDocumentRendered(stats: JSONObject)
        fun onRenderError(code: String?, message: String?)
        fun onRequestFolderGrant()
        fun onCopyText(text: String)
        fun onOpenLocalDocument(reference: String)
        fun onRegisterImages(urls: List<String>): JSONObject
        fun onRegisterAttachments(refs: List<String>): JSONObject
        fun onExportRequest(kind: String, options: JSONObject)
        fun beginExport(kind: String, mime: String, name: String, totalBytes: Long): String?
        fun writeExportChunk(exportId: String, index: Int, data: String): String?
        fun finishExport(exportId: String, sha256: String?, totalBytes: Long): Boolean
        fun abortExport(exportId: String)
        fun onPreference(key: String, value: String)
        fun onLog(level: String, message: String)
        fun onRevealNotice(code: String, message: String?)
    }

    private val proxyByView = java.util.WeakHashMap<WebView, JavaScriptReplyProxy>()

    fun isSupported(): Boolean = WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)

    fun attach(webView: WebView): Boolean {
        if (!isSupported()) return false
        return try {
            WebViewCompat.addWebMessageListener(
                webView,
                JS_OBJECT,
                setOf(LocalAssetRouter.ORIGIN),
                this,
            )
            true
        } catch (e: Exception) {
            Redact.w("web message listener unavailable: ${e.javaClass.simpleName}")
            false
        }
    }

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        if (!isMainFrame) {
            Redact.w("bridge message from a sub-frame ignored")
            return
        }
        if (sourceOrigin.toString().trimEnd('/') != LocalAssetRouter.ORIGIN) {
            Redact.w("bridge message from an unexpected origin ignored")
            return
        }
        val raw = message.data ?: return
        if (raw.length > Limits.BRIDGE_MESSAGE_MAX_BYTES) {
            Redact.w("bridge message over the size cap ignored")
            reply(replyProxy, null, null, "message too large")
            return
        }
        proxyByView[view] = replyProxy

        val envelope = Json.parseObject(raw)
        if (envelope == null) {
            reply(replyProxy, null, null, "malformed json")
            return
        }
        if (envelope.optInt("v", 0) != PROTOCOL_VERSION) {
            reply(replyProxy, null, envelope.optString("id").ifEmpty { null }, "unsupported protocol")
            return
        }

        val requestId = envelope.optString("id").ifEmpty { null }
        val method = envelope.optString("method")
        val params = envelope.optJSONObject("params") ?: JSONObject()

        val activeSession = host.currentSessionId()
        val activeGeneration = host.currentGeneration()

        val messageSession = envelope.optString("session").ifEmpty { null }
        val messageGeneration = if (envelope.has("generation")) envelope.optLong("generation") else -1L

        if (method != "ready" && method != "log") {
            if (activeSession == null || messageSession != activeSession) {
                reply(replyProxy, null, requestId, "stale session")
                return
            }
            if (messageGeneration != activeGeneration) {
                reply(replyProxy, null, requestId, "stale generation")
                return
            }
        }

        try {
            when (method) {
                "ready" -> reply(replyProxy, host.onWebReady(), requestId, null)
                "documentRendered" -> {
                    host.onDocumentRendered(params)
                    reply(replyProxy, JSONObject().put("ok", true), requestId, null)
                }
                "reportRenderError" -> {
                    host.onRenderError(
                        Json.optString(params, "code", 64),
                        Json.optString(params, "message", 512),
                    )
                    host.onRevealNotice(
                        Json.optString(params, "code", 64) ?: "render-error",
                        Json.optString(params, "message", 512),
                    )
                    reply(replyProxy, JSONObject().put("ok", true), requestId, null)
                }
                "requestFolderGrant" -> {
                    host.onRequestFolderGrant()
                    reply(replyProxy, JSONObject().put("requested", true), requestId, null)
                }
                "copyText" -> {
                    val text = Json.optString(params, "text", Limits.BRIDGE_TEXT_MAX_CHARS)
                    if (text == null) {
                        reply(replyProxy, null, requestId, "empty text")
                    } else {
                        host.onCopyText(text)
                        reply(replyProxy, JSONObject().put("copied", true), requestId, null)
                    }
                }
                "openLocalDocument" -> {
                    val reference = Json.optString(params, "reference", 2048)
                    if (reference == null) {
                        reply(replyProxy, null, requestId, "missing reference")
                    } else {
                        host.onOpenLocalDocument(reference)
                        reply(replyProxy, JSONObject().put("opened", true), requestId, null)
                    }
                }
                "registerAttachments" -> {
                    val refs = Json.stringArray(params, "refs", MAX_ATTACHMENT_REGISTRATIONS)
                    reply(replyProxy, host.onRegisterAttachments(refs), requestId, null)
                }
                "registerImages" -> {
                    val urls = Json.stringArray(params, "urls", MAX_IMAGE_REGISTRATIONS)
                    reply(replyProxy, host.onRegisterImages(urls), requestId, null)
                }
                "requestExport" -> {
                    val kind = Json.optString(params, "kind", 16) ?: "pdf"
                    if (kind !in ALLOWED_EXPORT_KINDS) {
                        reply(replyProxy, null, requestId, "unsupported export kind")
                    } else {
                        host.onExportRequest(kind, params)
                        reply(replyProxy, JSONObject().put("accepted", true), requestId, null)
                    }
                }
                "exportBegin" -> {
                    val kind = Json.optString(params, "kind", 16) ?: "svg"
                    val mime = Json.optString(params, "mime", 128) ?: "application/octet-stream"
                    val name = Json.optString(params, "name", 256) ?: "litedoc-export"
                    val total = params.optLong("totalBytes", -1L)
                    if (total < 0 || total > Limits.EXPORT_MAX_BYTES) {
                        reply(replyProxy, null, requestId, "export size out of range")
                    } else {
                        val exportId = host.beginExport(kind, mime, name, total)
                        if (exportId == null) {
                            reply(replyProxy, null, requestId, "no export target")
                        } else {
                            reply(
                                replyProxy,
                                JSONObject().put("exportId", exportId)
                                    .put("chunkChars", Limits.EXPORT_CHUNK_CHARS),
                                requestId,
                                null,
                            )
                        }
                    }
                }
                "exportChunk" -> {
                    val exportId = Json.optString(params, "exportId", 64)
                    val index = params.optInt("index", -1)
                    val data = Json.optString(params, "data", Limits.EXPORT_CHUNK_CHARS * 2)
                    if (exportId == null || index < 0 || data == null) {
                        reply(replyProxy, null, requestId, "invalid chunk")
                    } else {
                        val failure = host.writeExportChunk(exportId, index, data)
                        if (failure == null) {
                            reply(replyProxy, JSONObject().put("written", true), requestId, null)
                        } else {
                            reply(replyProxy, null, requestId, failure)
                        }
                    }
                }
                "exportFinish" -> {
                    val exportId = Json.optString(params, "exportId", 64)
                    val sha = Json.optString(params, "sha256", 128)
                    val total = params.optLong("totalBytes", -1L)
                    if (exportId == null) {
                        reply(replyProxy, null, requestId, "invalid export id")
                    } else {
                        val ok = host.finishExport(exportId, sha, total)
                        if (ok) {
                            reply(replyProxy, JSONObject().put("finished", true), requestId, null)
                        } else {
                            reply(replyProxy, null, requestId, "export verification failed")
                        }
                    }
                }
                "exportAbort" -> {
                    Json.optString(params, "exportId", 64)?.let { host.abortExport(it) }
                    reply(replyProxy, JSONObject().put("aborted", true), requestId, null)
                }
                "setPreference" -> {
                    val key = Json.optString(params, "key", 64)
                    val value = Json.optString(params, "value", 256)
                    if (key == null || value == null) {
                        reply(replyProxy, null, requestId, "invalid preference")
                    } else {
                        host.onPreference(key, value)
                        reply(replyProxy, JSONObject().put("applied", true), requestId, null)
                    }
                }
                "log" -> {
                    host.onLog(
                        Json.optString(params, "level", 16) ?: "info",
                        Json.optString(params, "message", 512) ?: "",
                    )
                    reply(replyProxy, JSONObject().put("ok", true), requestId, null)
                }
                else -> reply(replyProxy, null, requestId, "unknown method")
            }
        } catch (e: Exception) {
            Redact.w("bridge handler failed for $method: ${e.javaClass.simpleName}")
            reply(replyProxy, null, requestId, "handler failed")
        }
    }

    private fun reply(
        proxy: JavaScriptReplyProxy,
        result: JSONObject?,
        replyTo: String?,
        failure: String?,
    ) {
        val payload = JSONObject()
        payload.put("v", PROTOCOL_VERSION)
        if (replyTo != null) payload.put("replyTo", replyTo)
        if (failure != null) {
            payload.put("ok", false)
            payload.put("error", JSONObject().put("message", failure))
        } else {
            payload.put("ok", true)
            payload.put("result", result ?: JSONObject())
        }
        runCatching { proxy.postMessage(payload.toString()) }
    }

    fun notify(view: WebView, method: String, params: JSONObject, sessionId: String?, generation: Long) {
        val payload = JSONObject()
        payload.put("v", PROTOCOL_VERSION)
        payload.put("method", method)
        payload.put("params", params)
        if (sessionId != null) payload.put("session", sessionId)
        if (generation >= 0) payload.put("generation", generation)
        val proxy = proxyByView[view]
        if (proxy == null) {
            Redact.w("cannot push '$method': the page has not sent a message yet")
            return
        }
        runCatching { proxy.postMessage(payload.toString()) }
    }

    companion object {
        const val PROTOCOL_VERSION = 1
        const val JS_OBJECT = "litedoc"

        private const val MAX_IMAGE_REGISTRATIONS = 512
        private const val MAX_ATTACHMENT_REGISTRATIONS = 512

        private val ALLOWED_EXPORT_KINDS = setOf("pdf", "svg", "png")

        /** Methods the native side may push to the page (never a generic fetch). */
        val NATIVE_METHODS = setOf(
            "sessionReady",
            "preferenceChanged",
            "folderGrantChanged",
            "exportTargetReady",
            "exportFailed",
            "exportPrepare",
            "exportGraphic",
            "revealNotice",
            "requestSourceMode",
            "closeDocument",
        )

        fun arrayOfStrings(values: List<String>): JSONArray = Json.toArray(values)
    }
}
