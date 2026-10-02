package dev.litedoc.viewer.image

import java.util.UUID

/**
 * Maps opaque ids to remote image URLs.
 *
 * The renderer never sees a URL it can fetch: it registers the URL it found in
 * the document and then points `<img>` at `/session/<id>/image/<opaqueId>`. This
 * keeps the WebView off the network entirely and makes every fetch pass through
 * [RemoteImageRepository].
 */
class ImageRegistry {

    data class Entry(val opaqueId: String, val url: String)

    private val byId = LinkedHashMap<String, Entry>()
    private val byUrl = HashMap<String, Entry>()
    private val rejectionCache = HashMap<String, String>()

    @Synchronized
    fun register(url: String): Entry {
        byUrl[url]?.let { return it }
        val entry = Entry(UUID.randomUUID().toString().replace("-", ""), url)
        byUrl[url] = entry
        byId[entry.opaqueId] = entry
        return entry
    }

    @Synchronized
    fun get(opaqueId: String): Entry? = byId[opaqueId]

    @Synchronized
    fun reject(url: String, reason: String) {
        rejectionCache[url] = reason
    }

    @Synchronized
    fun rejectionFor(url: String): String? = rejectionCache[url]

    @Synchronized
    fun size(): Int = byId.size

    @Synchronized
    fun clear() {
        byId.clear()
        byUrl.clear()
        rejectionCache.clear()
    }
}
