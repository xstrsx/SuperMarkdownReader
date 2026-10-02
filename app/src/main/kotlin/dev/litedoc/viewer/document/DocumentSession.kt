package dev.litedoc.viewer.document

import java.io.File

/**
 * How the document should be presented. Decided natively from kind + size, and
 * always reported to the user instead of being applied silently.
 */
enum class RenderMode(val id: String) {
    /** Full offline rendering (Markdown extensions, math, diagrams, ...). */
    RICH("rich"),

    /** Rich rendering is not applicable (source code, LaTeX source, log files). */
    SOURCE("source"),

    /** Rich rendering was refused for size/safety reasons; readable source only. */
    SOURCE_ONLY("source-only"),
}

/**
 * Everything the viewer needs for one open document.
 *
 * No View or Activity reference is ever kept here, and [serveFile] always lives
 * inside the application private cache with a random name: an untrusted display
 * name never becomes a path.
 */
data class DocumentSession(
    val id: String,
    val generation: Long,
    val kind: DocumentKind,
    val renderMode: RenderMode,
    val confidence: DetectionConfidence,
    val detectionReason: String,
    val displayName: String,
    val mimeType: String,
    /** Encoding of the original bytes, for display and manual re-decoding. */
    val detectedCharset: String,
    /** True when transcribing was required (non UTF-8 source or a BOM). */
    val transcoded: Boolean,
    /** UTF-8 file that the web layer reads. */
    val serveFile: File,
    /** Original bytes, kept only when a manual re-decode could be needed. */
    val originalFile: File?,
    val sizeBytes: Long,
    val bytesTransferred: Long,
    val warning: String? = null,
    val originUri: String? = null,
) {
    val snapshotBytes: Long
        get() = serveFile.length() + (originalFile?.length() ?: 0L)
}
