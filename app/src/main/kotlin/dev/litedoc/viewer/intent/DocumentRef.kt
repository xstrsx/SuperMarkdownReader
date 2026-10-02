package dev.litedoc.viewer.intent

import android.net.Uri

/**
 * One thing the user asked LiteDoc to open. Either a provider URI or a short
 * piece of shared text. Display name / MIME / size are only hints: the real
 * values are read from the provider in the background.
 */
data class DocumentRef(
    val uri: Uri?,
    val sharedText: String? = null,
    val sharedTextIsHtml: Boolean = false,
    val nameHint: String? = null,
    val mimeHint: String? = null,
    val sizeHint: Long? = null,
) {
    val identity: String
        get() = uri?.toString() ?: "text:${sharedText.hashCode()}"

    val label: String
        get() = nameHint?.takeIf { it.isNotBlank() } ?: uri?.lastPathSegment ?: "shared text"
}
