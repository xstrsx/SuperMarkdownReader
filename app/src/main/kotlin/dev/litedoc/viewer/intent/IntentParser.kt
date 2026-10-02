package dev.litedoc.viewer.intent

import android.content.Intent
import android.net.Uri
import androidx.core.content.IntentCompat
import dev.litedoc.viewer.util.Limits

/**
 * Translates VIEW / SEND / SEND_MULTIPLE into a bounded list of [DocumentRef].
 *
 * Security notes:
 * * `http`/`https` payloads are never treated as documents. A shared web address
 *   is reported as [Outcome.WebsiteUrl] so the UI can offer "copy link" instead
 *   of fetching anything.
 * * `text/html` shares are only ever handled by the static HTML sanitiser; they
 *   are passed on as text, never as a trusted page.
 * * Duplicates are removed, and the list is capped at
 *   [Limits.MAX_DOCUMENTS_PER_INTENT]; anything dropped is reported, not hidden.
 */
class IntentParser {

    sealed interface Outcome {
        data class Documents(val refs: List<DocumentRef>, val dropped: Int = 0) : Outcome
        data class WebsiteUrl(val url: String) : Outcome
        data class SharedText(val text: String, val isHtml: Boolean) : Outcome
        data object Empty : Outcome
    }

    fun parse(intent: Intent?): Outcome {
        if (intent == null) return Outcome.Empty
        return when (intent.action) {
            Intent.ACTION_VIEW -> parseView(intent)
            Intent.ACTION_SEND -> parseSend(intent)
            Intent.ACTION_SEND_MULTIPLE -> parseSendMultiple(intent)
            else -> Outcome.Empty
        }
    }

    private fun parseView(intent: Intent): Outcome {
        val uri = intent.data ?: firstClipUri(intent)
        if (uri == null) {
            val text = intent.getStringExtra(Intent.EXTRA_TEXT)
            return if (text.isNullOrBlank()) Outcome.Empty else classifyText(text)
        }
        if (isWebUrl(uri)) return Outcome.WebsiteUrl(uri.toString())
        val ref = DocumentRef(
            uri = uri,
            nameHint = intent.getStringExtra(Intent.EXTRA_TITLE),
            mimeHint = intent.type,
            sizeHint = null,
        )
        return Outcome.Documents(listOf(ref))
    }

    private fun parseSend(intent: Intent): Outcome {
        val uri = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            ?: firstClipUri(intent)
        if (uri != null) {
            if (isWebUrl(uri)) return Outcome.WebsiteUrl(uri.toString())
            return Outcome.Documents(
                listOf(
                    DocumentRef(
                        uri = uri,
                        nameHint = intent.getStringExtra(Intent.EXTRA_TITLE),
                        mimeHint = intent.type,
                    ),
                ),
            )
        }
        val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
        if (text.isNullOrBlank()) return Outcome.Empty
        return classifyText(text, intent.type)
    }

    private fun parseSendMultiple(intent: Intent): Outcome {
        val collected = ArrayList<Uri>()
        IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            ?.let { collected.addAll(it) }
        val clip = intent.clipData
        if (clip != null) {
            for (i in 0 until clip.itemCount) {
                clip.getItemAt(i).uri?.let { collected.add(it) }
            }
        }

        val webUrl = collected.firstOrNull { isWebUrl(it) }
        val documents = collected.filterNot { isWebUrl(it) }

        if (documents.isEmpty()) {
            if (webUrl != null) return Outcome.WebsiteUrl(webUrl.toString())
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            return if (text.isNullOrBlank()) Outcome.Empty else classifyText(text, intent.type)
        }

        val seen = LinkedHashSet<String>()
        val refs = ArrayList<DocumentRef>(minOf(documents.size, Limits.MAX_DOCUMENTS_PER_INTENT))
        var dropped = 0
        for (uri in documents) {
            val key = uri.toString()
            if (!seen.add(key)) continue
            if (refs.size >= Limits.MAX_DOCUMENTS_PER_INTENT) {
                dropped++
                continue
            }
            refs.add(DocumentRef(uri = uri, mimeHint = intent.type))
        }
        if (webUrl != null) dropped++
        return Outcome.Documents(refs, dropped)
    }

    private fun firstClipUri(intent: Intent): Uri? {
        val clip = intent.clipData ?: return null
        for (i in 0 until clip.itemCount) {
            clip.getItemAt(i).uri?.let { return it }
        }
        return null
    }

    private fun classifyText(text: String, mimeType: String? = null): Outcome {
        val trimmed = text.trim()
        if (trimmed.length <= 2048 && isWebUrlString(trimmed)) {
            return Outcome.WebsiteUrl(trimmed)
        }
        return Outcome.SharedText(
            text = text,
            isHtml = mimeType?.lowercase()?.substringBefore(';') == "text/html",
        )
    }

    fun isWebUrl(uri: Uri): Boolean {
        val scheme = uri.scheme?.lowercase() ?: return false
        return scheme == "http" || scheme == "https"
    }

    private fun isWebUrlString(value: String): Boolean {
        val lower = value.lowercase()
        if (!(lower.startsWith("http://") || lower.startsWith("https://"))) return false
        return !value.contains(' ') && !value.contains('\n')
    }
}
