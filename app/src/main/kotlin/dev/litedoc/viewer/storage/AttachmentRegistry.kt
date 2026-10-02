package dev.litedoc.viewer.storage

import android.net.Uri
import dev.litedoc.viewer.document.DocumentKindDetector
import dev.litedoc.viewer.util.Redact
import java.util.UUID

/** Where relative attachment references are rooted for one document. */
data class AttachmentRoot(
    val treeUri: Uri,
    val rootDocumentId: String,
    val baseSegments: List<String>,
    val label: String,
    /** true: matched automatically, false: user confirmed "this file is in that folder". */
    val mappingConfirmed: Boolean,
)

/**
 * Maps document-relative references to authorised content URIs and hands out
 * opaque ids. The web layer only ever sees `/session/<id>/resource/<opaqueId>`;
 * it can never name a URI, a document id or a path itself.
 */
class AttachmentRegistry(private val folders: FolderAccessRepository) {

    data class Entry(
        val opaqueId: String,
        val uri: Uri,
        val reference: String,
        val mimeType: String?,
        val sizeBytes: Long?,
    )

    private val byOpaqueId = LinkedHashMap<String, Entry>()
    private val byReference = HashMap<String, Entry?>()

    fun clear() {
        byOpaqueId.clear()
        byReference.clear()
    }

    /** Registers (or reuses) a registration for [reference]; null when unresolved. */
    fun register(root: AttachmentRoot, reference: String): Entry? {
        if (byReference.containsKey(reference)) return byReference[reference]
        val entry = resolve(root, reference)
        byReference[reference] = entry
        if (entry != null) byOpaqueId[entry.opaqueId] = entry
        return entry
    }

    fun get(opaqueId: String): Entry? = byOpaqueId[opaqueId]

    private fun resolve(root: AttachmentRoot, reference: String): Entry? {
        val trimmed = reference.trim()
        if (trimmed.isEmpty()) return null
        val scheme = trimmed.substringBefore(':', missingDelimiterValue = "").lowercase()
        // Only document-relative references reach this resolver. Absolute URLs,
        // data: URIs, fragments and already-resolved content URIs are handled by
        // the image proxy or rejected by the router.
        if (scheme.isNotEmpty() && scheme.length in 2..12 && trimmed.contains(':')) return null
        if (trimmed.startsWith("#")) return null

        val tree = folders.tree(root.treeUri) ?: return null
        val pathResult = RelativePath.resolve(root.baseSegments, trimmed)
        val segments = when (pathResult) {
            is RelativePath.Result.Ok -> pathResult.segments
            is RelativePath.Result.EscapesRoot -> {
                Redact.w("attachment reference escaped the authorised root")
                return null
            }
            is RelativePath.Result.Invalid -> return null
        }

        val documentId = folders.resolveSegments(tree, segments) ?: return null
        val uri = folders.documentUri(tree, documentId)
        val name = segments.lastOrNull().orEmpty()
        val ext = DocumentKindDetector.extensionOf(name)
        val mime = mimeForExtension(ext)

        return Entry(
            opaqueId = UUID.randomUUID().toString().replace("-", ""),
            uri = uri,
            reference = trimmed,
            mimeType = mime,
            sizeBytes = null,
        )
    }

    private fun mimeForExtension(ext: String?): String? = when (ext?.lowercase()) {
        null -> null
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "avif" -> "image/avif"
        "bmp" -> "image/bmp"
        "svg" -> "image/svg+xml"
        "css" -> "text/css"
        "txt", "md", "csv", "tsv", "json", "yaml", "yml" -> "text/plain; charset=utf-8"
        else -> null
    }
}
