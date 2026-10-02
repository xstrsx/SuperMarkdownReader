package dev.litedoc.viewer.util

/**
 * Hard resource limits. These are protective engineering budgets, not promises
 * that hitting a limit stays fast. Every limit is enforced in code and reported
 * to the user instead of silently truncating content.
 */
object Limits {

    // --- document sizes -----------------------------------------------------
    const val RICH_TEXT_MAX_BYTES: Long = 8L * 1024 * 1024
    const val RICH_TEXT_WARN_BYTES: Long = 8L * 1024 * 1024
    const val SOURCE_TEXT_MAX_BYTES: Long = 32L * 1024 * 1024
    const val HTML_MAX_BYTES: Long = 8L * 1024 * 1024
    const val SVG_MAX_BYTES: Long = 8L * 1024 * 1024
    const val CSV_MAX_BYTES: Long = 32L * 1024 * 1024

    // --- sessions -----------------------------------------------------------
    const val MAX_SESSIONS: Int = 20
    const val SNAPSHOT_TOTAL_BUDGET_BYTES: Long = 128L * 1024 * 1024
    const val MAX_DOCUMENTS_PER_INTENT: Int = 20
    const val SHARED_TEXT_MAX_CHARS: Int = 8 * 1024 * 1024

    // --- bridge -------------------------------------------------------------
    const val BRIDGE_MESSAGE_MAX_BYTES: Int = 64 * 1024
    const val BRIDGE_TEXT_MAX_CHARS: Int = 256 * 1024

    // --- network images -----------------------------------------------------
    const val IMAGE_CONCURRENCY: Int = 3
    const val IMAGE_CONNECT_TIMEOUT_MS: Long = 10_000
    const val IMAGE_READ_TIMEOUT_MS: Long = 15_000
    const val IMAGE_CALL_TIMEOUT_MS: Long = 30_000
    const val IMAGE_MAX_BYTES: Long = 12L * 1024 * 1024
    const val IMAGE_MAX_REDIRECTS: Int = 5
    const val IMAGE_DISK_CACHE_BYTES: Long = 64L * 1024 * 1024
    const val IMAGE_MEMORY_CACHE_BYTES: Long = 16L * 1024 * 1024
    const val IMAGE_DECODE_MAX_PIXELS: Long = 16_000_000
    const val IMAGE_SNIFF_BYTES: Int = 4096
    const val REMOTE_SVG_MAX_BYTES: Long = 4L * 1024 * 1024

    // --- export -------------------------------------------------------------
    const val EXPORT_TOTAL_BUDGET_MS: Long = 60_000
    const val EXPORT_PNG_MAX_EDGE: Int = 8192
    const val EXPORT_PNG_MAX_PIXELS: Long = 16_000_000
    const val EXPORT_MAX_BYTES: Long = 24L * 1024 * 1024
    const val EXPORT_CHUNK_CHARS: Int = 16 * 1024
}
