package dev.litedoc.viewer.image

import android.content.Context
import dev.litedoc.viewer.settings.ViewerSettings
import dev.litedoc.viewer.util.Limits
import dev.litedoc.viewer.util.Redact
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.URI
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.job
import kotlinx.coroutines.withContext
import okhttp3.Cache
import okhttp3.CacheControl
import okhttp3.Call
import okhttp3.CookieJar
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody

/**
 * The only component in LiteDoc allowed to touch the network.
 *
 * * http/https only, no user info, no cookies, no Authorization, no Referer;
 * * redirects are followed manually, at most [Limits.IMAGE_MAX_REDIRECTS] hops,
 *   with the policy re-applied to every hop (https -> http is refused);
 * * every resolved address of every hop is checked, so a private address cannot
 *   be reached through DNS;
 * * bytes are counted while reading: Content-Length is never trusted;
 * * responses that are not images are rejected instead of being handed to the
 *   renderer, so a server error page can never be displayed as content.
 */
class RemoteImageRepository(
    context: Context,
    private val settings: ViewerSettings,
) {

    sealed interface Result {
        data class Success(
            val bytes: ByteArray,
            val mimeType: String,
            val fromCache: Boolean,
        ) : Result

        data class Failure(val reason: Reason, val detail: String? = null) : Result

        enum class Reason {
            DISABLED,
            POLICY,
            HTTP_ERROR,
            TOO_LARGE,
            NOT_IMAGE,
            NETWORK,
            CANCELLED,
        }
    }

    private val policy = ImageRequestPolicy { settings.allowLanImages }

    private val cache = Cache(
        File(context.cacheDir, "litedoc-image-cache"),
        Limits.IMAGE_DISK_CACHE_BYTES,
    )

    private val inFlight = AtomicInteger(0)

    private val client: OkHttpClient = OkHttpClient.Builder()
        .cache(cache)
        .connectTimeout(Limits.IMAGE_CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .readTimeout(Limits.IMAGE_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .callTimeout(Limits.IMAGE_CALL_TIMEOUT_MS, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .cookieJar(CookieJar.NO_COOKIES)
        .build()

    fun clearCache() {
        runCatching { cache.evictAll() }
    }

    fun cacheSizeBytes(): Long = runCatching { cache.size() }.getOrDefault(0L)

    suspend fun fetch(rawUrl: String): Result {
        if (!settings.remoteImagesEnabled) return Result.Failure(Result.Reason.DISABLED)
        if (inFlight.get() >= Limits.IMAGE_CONCURRENCY * 4) {
            return Result.Failure(Result.Reason.NETWORK, "image queue is saturated")
        }

        val holder = CallHolder()
        inFlight.incrementAndGet()
        return try {
            withContext(Dispatchers.IO) {
                val job = coroutineContext.job
                val cancelHandle = job.invokeOnCompletion { cause ->
                    if (cause is CancellationException) holder.cancel()
                }
                try {
                    fetchWithRedirects(rawUrl, holder)
                } finally {
                    cancelHandle.dispose()
                }
            }
        } catch (_: CancellationException) {
            Result.Failure(Result.Reason.CANCELLED)
        } finally {
            holder.cancel()
            inFlight.decrementAndGet()
        }
    }

    private fun fetchWithRedirects(rawUrl: String, holder: CallHolder): Result {
        var current = rawUrl
        var hop = 0
        while (true) {
            when (val decision = policy.validateUrl(current)) {
                is ImageRequestPolicy.Decision.Reject -> {
                    return Result.Failure(Result.Reason.POLICY, decision.reason.name)
                }
                is ImageRequestPolicy.Decision.Allow -> {
                    val addressDecision = checkResolved(decision.host)
                    if (addressDecision != null) return addressDecision
                }
            }

            val url = current.toHttpUrlOrNull()
                ?: return Result.Failure(Result.Reason.POLICY, "unparseable URL")

            val request = Request.Builder()
                .url(url)
                .header("Accept", "image/*;q=1.0,image/svg+xml;q=1.0,*/*;q=0.1")
                .header("User-Agent", "LiteDoc/${dev.litedoc.viewer.BuildConfig.VERSION_NAME}")
                .cacheControl(CacheControl.Builder().maxStale(7, TimeUnit.DAYS).build())
                .build()

            val call = client.newCall(request)
            holder.set(call)
            val response: Response = try {
                call.execute()
            } catch (_: IOException) {
                if (holder.isCancelled) return Result.Failure(Result.Reason.CANCELLED)
                return Result.Failure(Result.Reason.NETWORK)
            }
            response.use { resp ->
                if (resp.isRedirect) {
                    hop++
                    if (hop > Limits.IMAGE_MAX_REDIRECTS) {
                        return Result.Failure(
                            Result.Reason.POLICY,
                            ImageRequestPolicy.Reason.TOO_MANY_REDIRECTS.name,
                        )
                    }
                    val location = resp.header("Location")
                        ?: return Result.Failure(Result.Reason.HTTP_ERROR, "redirect without Location")
                    val next = resp.request.url.resolve(location)?.toString()
                        ?: return Result.Failure(Result.Reason.POLICY, "unresolvable redirect")
                    when (val redirectDecision = policy.validateRedirect(current, next)) {
                        is ImageRequestPolicy.Decision.Reject ->
                            return Result.Failure(Result.Reason.POLICY, redirectDecision.reason.name)
                        is ImageRequestPolicy.Decision.Allow -> {
                            checkResolved(redirectDecision.host)?.let { return it }
                        }
                    }
                    current = next
                    continue
                }

                if (!resp.isSuccessful) {
                    return Result.Failure(Result.Reason.HTTP_ERROR, resp.code.toString())
                }

                val declaredLength = resp.body?.contentLength() ?: -1L
                if (declaredLength > Limits.IMAGE_MAX_BYTES) {
                    return Result.Failure(Result.Reason.TOO_LARGE, "declared $declaredLength bytes")
                }

                val bytes = try {
                    readBounded(resp.body, Limits.IMAGE_MAX_BYTES)
                } catch (_: TooLargeException) {
                    return Result.Failure(
                        Result.Reason.TOO_LARGE,
                        "over ${Limits.IMAGE_MAX_BYTES} bytes",
                    )
                } catch (_: IOException) {
                    if (holder.isCancelled) return Result.Failure(Result.Reason.CANCELLED)
                    return Result.Failure(Result.Reason.NETWORK)
                }

                val sniffed = sniffImage(bytes)
                    ?: return Result.Failure(Result.Reason.NOT_IMAGE)

                val declaredType = resp.header("Content-Type")?.substringBefore(';')?.trim()?.lowercase()
                val isSvg = sniffed == "image/svg+xml"
                val mime = when {
                    isSvg -> "image/svg+xml"
                    declaredType != null && declaredType.startsWith("image/") &&
                        declaredType != "image/svg+xml" -> declaredType
                    else -> sniffed
                }

                if (isSvg && bytes.size.toLong() > Limits.REMOTE_SVG_MAX_BYTES) {
                    return Result.Failure(
                        Result.Reason.TOO_LARGE,
                        "remote SVG over ${Limits.REMOTE_SVG_MAX_BYTES} bytes",
                    )
                }

                val fromCache = resp.cacheResponse != null
                Redact.d("image fetched: ${Redact.url(current)} bytes=${bytes.size} cached=$fromCache")
                return Result.Success(bytes, mime, fromCache)
            }
        }
    }

    /** Resolves the host and applies the address policy to every answer. */
    private fun checkResolved(host: String): Result.Failure? {
        val literal = parseLiteralAddress(host)
        val addresses = if (literal != null) {
            listOf(literal)
        } else {
            try {
                InetAddress.getAllByName(host).toList()
            } catch (_: Exception) {
                return Result.Failure(
                    Result.Reason.POLICY,
                    ImageRequestPolicy.Reason.DNS_FAILED.name,
                )
            }
        }
        if (addresses.isEmpty()) {
            return Result.Failure(Result.Reason.POLICY, ImageRequestPolicy.Reason.DNS_FAILED.name)
        }
        return when (val decision = policy.validateAddresses(host, addresses)) {
            is ImageRequestPolicy.Decision.Allow -> null
            is ImageRequestPolicy.Decision.Reject ->
                Result.Failure(Result.Reason.POLICY, decision.reason.name)
        }
    }

    private fun parseLiteralAddress(host: String): InetAddress? = try {
        if (host.startsWith("[") && host.endsWith("]")) {
            InetAddress.getByName(host.substring(1, host.length - 1))
        } else if (host.matches(Regex("^\\d{1,3}(\\.\\d{1,3}){3}$"))) {
            InetAddress.getByName(host)
        } else {
            null
        }
    } catch (_: Exception) {
        null
    }

    private class TooLargeException : IOException("response too large")

    private fun readBounded(body: ResponseBody?, limit: Long): ByteArray {
        if (body == null) throw IOException("empty body")
        val buffer = ByteArray(64 * 1024)
        val out = java.io.ByteArrayOutputStream(64 * 1024)
        var total = 0L
        body.byteStream().use { stream ->
            while (true) {
                val read = stream.read(buffer)
                if (read < 0) break
                total += read
                if (total > limit) throw TooLargeException()
                out.write(buffer, 0, read)
            }
        }
        return out.toByteArray()
    }

    private class CallHolder {
        @Volatile
        private var call: Call? = null

        @Volatile
        var isCancelled: Boolean = false
            private set

        fun set(call: Call) {
            this.call = call
            if (isCancelled) call.cancel()
        }

        fun cancel() {
            isCancelled = true
            call?.cancel()
        }
    }

    companion object {
        /**
         * Signature-based sniffing. The declared Content-Type alone is never
         * trusted, and a non-image response (for example a provider error page) is
         * rejected rather than rendered.
         */
        fun sniffImage(bytes: ByteArray): String? {
            if (bytes.size < 4) return null
            fun matches(vararg signature: Int, offset: Int = 0): Boolean {
                if (bytes.size < offset + signature.size) return false
                for (i in signature.indices) {
                    if ((bytes[offset + i].toInt() and 0xFF) != signature[i]) return false
                }
                return true
            }
            return when {
                matches(0x89, 0x50, 0x4E, 0x47) -> "image/png"
                matches(0xFF, 0xD8, 0xFF) -> "image/jpeg"
                matches(0x47, 0x49, 0x46, 0x38) -> "image/gif"
                matches(0x42, 0x4D) -> "image/bmp"
                matches(0x52, 0x49, 0x46, 0x46) && matches(0x57, 0x45, 0x42, 0x50, offset = 8) -> "image/webp"
                matches(0x00, 0x00, 0x01, 0x00) -> "image/x-icon"
                looksLikeSvg(bytes) -> "image/svg+xml"
                else -> null
            }
        }

        private fun looksLikeSvg(bytes: ByteArray): Boolean {
            val head = String(
                bytes,
                0,
                minOf(bytes.size, 1024),
                Charsets.ISO_8859_1,
            ).trimStart('\uFEFF', ' ', '\t', '\r', '\n')
            if (head.startsWith("<svg", ignoreCase = true)) return true
            if (!head.startsWith("<?xml", ignoreCase = true)) return false
            return head.take(512).contains("<svg", ignoreCase = true)
        }

        /** True when a URL looks like a remote reference the proxy should handle. */
        fun isRemoteReference(reference: String): Boolean {
            val scheme = try {
                URI(reference.trim()).scheme?.lowercase()
            } catch (_: Exception) {
                reference.substringBefore(':', "").lowercase().ifEmpty { null }
            }
            return scheme == "http" || scheme == "https"
        }
    }
}
