package dev.litedoc.viewer.document

import android.content.ContentResolver
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import dev.litedoc.viewer.intent.DocumentRef
import dev.litedoc.viewer.util.Limits
import dev.litedoc.viewer.util.Redact
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.UUID
import kotlin.coroutines.coroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers

/**
 * Turns an authorised [DocumentRef] into a [DocumentSession].
 *
 * Guarantees:
 * * the source URI is only ever read on a background dispatcher, cooperatively
 *   (a generation change cancels the read at the next chunk);
 * * the provider's declared size is treated as a hint, never as the truth: real
 *   byte counting decides;
 * * provider failures (revoked grant, deleted file, remote provider offline) are
 *   reported as data, not thrown;
 * * snapshot files use random names inside the private cache, never a
 *   document-supplied path.
 */
class DocumentRepository(private val context: Context) {

    sealed interface Outcome {
        data class Success(val session: DocumentSession) : Outcome
        data class Failure(val reason: Reason, val detail: String? = null) : Outcome

        enum class Reason { UNREADABLE, TOO_LARGE, BINARY, UNSUPPORTED, CANCELLED, EMPTY }
    }

    private val rootDir: File
        get() = File(context.cacheDir, "litedoc-sessions").apply { mkdirs() }

    suspend fun load(ref: DocumentRef, generation: Long): Outcome = withContext(Dispatchers.IO) {
        try {
            if (ref.sharedText != null) {
                loadSharedText(ref, generation)
            } else {
                val uri = ref.uri ?: return@withContext Outcome.Failure(Outcome.Reason.EMPTY)
                loadUri(uri, ref, generation)
            }
        } catch (_: kotlinx.coroutines.CancellationException) {
            Outcome.Failure(Outcome.Reason.CANCELLED)
        } catch (e: Exception) {
            Redact.w("document read failed: ${e.javaClass.simpleName}", e)
            Outcome.Failure(Outcome.Reason.UNREADABLE, e.message)
        }
    }

    // ------------------------------------------------------------------ shared text

    private suspend fun loadSharedText(ref: DocumentRef, generation: Long): Outcome {
        val raw = ref.sharedText ?: return Outcome.Failure(Outcome.Reason.EMPTY)
        if (raw.length > Limits.SHARED_TEXT_MAX_CHARS) {
            return Outcome.Failure(
                Outcome.Reason.TOO_LARGE,
                "${raw.length} characters shared as text",
            )
        }
        val bytes = raw.toByteArray(Charsets.UTF_8)
        val id = newSessionId()
        val dir = File(rootDir, id).apply { mkdirs() }
        File(dir, "source.utf8").writeBytes(bytes)

        val detector = DocumentKindDetector.detect(
            displayName = "shared.txt",
            mimeType = if (ref.sharedTextIsHtml) "text/html" else "text/plain",
            head = bytes,
        )
        val kind = if (ref.sharedTextIsHtml) DocumentKind.HTML else detector.kind
        coroutineContext.ensureActive()
        return Outcome.Success(
            DocumentSession(
                id = id,
                generation = generation,
                kind = kind,
                renderMode = if (kind.richCapable) RenderMode.RICH else RenderMode.SOURCE,
                confidence = DetectionConfidence.MEDIUM,
                detectionReason = "shared text",
                displayName = "shared.${if (ref.sharedTextIsHtml) "html" else "md"}",
                mimeType = if (ref.sharedTextIsHtml) "text/html" else "text/markdown",
                detectedCharset = TextDecoder.UTF8,
                transcoded = false,
                serveFile = File(dir, "source.utf8"),
                originalFile = null,
                sizeBytes = bytes.size.toLong(),
                bytesTransferred = bytes.size.toLong(),
                warning = null,
                originUri = null,
            ),
        )
    }

    // ------------------------------------------------------------------ provider URI

    private suspend fun loadUri(uri: Uri, ref: DocumentRef, generation: Long): Outcome {
        val meta = queryMetadata(uri)
        val displayName = meta.displayName ?: ref.nameHint ?: uri.lastPathSegment ?: "document"
        val declaredSize = meta.size ?: ref.sizeHint
        val mimeType = meta.mimeType ?: ref.mimeHint

        val id = newSessionId()
        val dir = File(rootDir, id).apply { mkdirs() }
        val rawFile = File(dir, "source.bin")

        val transferred = try {
            copyStream(uri, rawFile, Limits.SOURCE_TEXT_MAX_BYTES)
        } catch (_: TooLargeException) {
            cleanDir(dir)
            return Outcome.Failure(
                Outcome.Reason.TOO_LARGE,
                "exceeded ${Limits.SOURCE_TEXT_MAX_BYTES} bytes",
            )
        } catch (e: SecurityException) {
            cleanDir(dir)
            return Outcome.Failure(Outcome.Reason.UNREADABLE, "permission revoked")
        } catch (e: IOException) {
            cleanDir(dir)
            return Outcome.Failure(Outcome.Reason.UNREADABLE, e.message)
        }

        coroutineContext.ensureActive()

        if (transferred == 0L) {
            cleanDir(dir)
            return Outcome.Failure(Outcome.Reason.EMPTY, "provider returned no bytes")
        }

        val head = rawFile.inputStream().use { stream ->
            val buffer = ByteArray(minOf(8192L, transferred).toInt())
            val read = stream.read(buffer)
            if (read <= 0) ByteArray(0) else buffer.copyOf(read)
        }

        val detection = DocumentKindDetector.detect(displayName, mimeType, head)

        val decoded = TextDecoder.decode(head, forcedCharset = null)
        if (decoded is TextDecoder.Result.Binary) {
            cleanDir(dir)
            return Outcome.Failure(Outcome.Reason.BINARY, decoded.detail)
        }

        val sourceCharset = when (decoded) {
            is TextDecoder.Result.Decoded -> decoded.charsetName
            is TextDecoder.Result.Ambiguous -> decoded.charsetName
            else -> TextDecoder.UTF8
        }

        // Decide whether transcoding is needed. UTF-8 without BOM is served as is.
        val needsTranscode = !(sourceCharset.equals(TextDecoder.UTF8, ignoreCase = true) &&
            (decoded as? TextDecoder.Result.Decoded)?.hadBom != true)

        val serveFile: File
        val originalFile: File?
        val warning: String?

        if (needsTranscode) {
            val decodedFull = TextDecoder.decode(rawFile.readBytes(), forcedCharset = null)
            val text = when (decodedFull) {
                is TextDecoder.Result.Decoded -> decodedFull.text
                is TextDecoder.Result.Ambiguous -> decodedFull.text
                is TextDecoder.Result.Binary -> {
                    cleanDir(dir)
                    return Outcome.Failure(Outcome.Reason.BINARY, decodedFull.detail)
                }
            }
            val utf8File = File(dir, "source.utf8")
            utf8File.writeText(text, Charsets.UTF_8)
            serveFile = utf8File
            // Keep the original bytes so the user can re-decode with another
            // encoding without re-reading a possibly expired provider URI.
            originalFile = rawFile
            warning = if (decodedFull is TextDecoder.Result.Ambiguous) {
                "charset-ambiguous:${sourceCharset}"
            } else {
                "charset-transcoded:${sourceCharset}"
            }
        } else {
            serveFile = rawFile
            originalFile = null
            warning = null
        }

        coroutineContext.ensureActive()

        val renderMode = decideRenderMode(detection.kind, transferred)
        val richWarning = when {
            renderMode == RenderMode.SOURCE_ONLY ->
                "rich-disabled:large-file:${transferred}"
            detection.kind == DocumentKind.HTML && transferred > Limits.HTML_MAX_BYTES ->
                "html-too-large:${transferred}"
            detection.confidence == DetectionConfidence.LOW && !detection.kind.richCapable ->
                "low-confidence:${detection.reason}"
            detection.confidence == DetectionConfidence.LOW ->
                "low-confidence:${detection.reason}"
            else -> null
        }

        return Outcome.Success(
            DocumentSession(
                id = id,
                generation = generation,
                kind = detection.kind,
                renderMode = renderMode,
                confidence = detection.confidence,
                detectionReason = detection.reason,
                displayName = displayName,
                mimeType = DocumentKindDetector.serveMime(detection.kind),
                detectedCharset = sourceCharset,
                transcoded = needsTranscode,
                serveFile = serveFile,
                originalFile = originalFile,
                sizeBytes = declaredSize ?: transferred,
                bytesTransferred = transferred,
                warning = richWarning ?: warning,
                originUri = uri.toString(),
            ),
        )
    }

    private fun decideRenderMode(kind: DocumentKind, bytes: Long): RenderMode = when {
        !kind.richCapable -> RenderMode.SOURCE
        kind == DocumentKind.HTML && bytes > Limits.HTML_MAX_BYTES -> RenderMode.SOURCE_ONLY
        kind == DocumentKind.SVG && bytes > Limits.SVG_MAX_BYTES -> RenderMode.SOURCE_ONLY
        kind == DocumentKind.CSV || kind == DocumentKind.TSV -> RenderMode.RICH
        bytes > Limits.RICH_TEXT_MAX_BYTES -> RenderMode.SOURCE_ONLY
        else -> RenderMode.RICH
    }

    /** Re-decodes the kept original bytes with a user-chosen encoding. */
    suspend fun redecode(
        session: DocumentSession,
        charsetName: String,
        generation: Long,
    ): Outcome = withContext(Dispatchers.IO) {
        val original = session.originalFile
            ?: return@withContext Outcome.Failure(Outcome.Reason.UNSUPPORTED, "no original bytes kept")
        try {
            val outcome = TextDecoder.decode(original.readBytes(), forcedCharset = charsetName)
            val text = when (outcome) {
                is TextDecoder.Result.Decoded -> outcome.text
                is TextDecoder.Result.Ambiguous -> outcome.text
                is TextDecoder.Result.Binary ->
                    return@withContext Outcome.Failure(Outcome.Reason.BINARY, outcome.detail)
            }
            coroutineContext.ensureActive()
            val utf8File = File(original.parentFile, "source.utf8")
            utf8File.writeText(text, Charsets.UTF_8)
            Outcome.Success(
                session.copy(
                    generation = generation,
                    detectedCharset = charsetName,
                    transcoded = true,
                    serveFile = utf8File,
                    warning = "charset-manual:$charsetName",
                ),
            )
        } catch (e: Exception) {
            Outcome.Failure(Outcome.Reason.UNREADABLE, e.message)
        }
    }

    private class TooLargeException : IOException("document exceeds the byte limit")

    private suspend fun copyStream(uri: Uri, target: File, hardLimit: Long): Long {
        val resolver: ContentResolver = context.contentResolver
        val input: InputStream = resolver.openInputStream(uri)
            ?: throw IOException("provider returned no stream")
        var total = 0L
        input.use { stream ->
            target.outputStream().use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    coroutineContext.ensureActive()
                    val read = stream.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    total += read
                    if (total > hardLimit) throw TooLargeException()
                    output.write(buffer, 0, read)
                }
                output.flush()
            }
        }
        return total
    }

    private data class Metadata(val displayName: String?, val size: Long?, val mimeType: String?)

    private fun queryMetadata(uri: Uri): Metadata {
        var displayName: String? = null
        var size: Long? = null
        var cursor: Cursor? = null
        try {
            cursor = context.contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null,
                null,
                null,
            )
            if (cursor != null && cursor.moveToFirst()) {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
                    displayName = cursor.getString(nameIndex)
                }
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                    val value = cursor.getLong(sizeIndex)
                    if (value >= 0) size = value
                }
            }
        } catch (e: Exception) {
            Redact.w("provider metadata query failed: ${e.javaClass.simpleName}")
        } finally {
            runCatching { cursor?.close() }
        }
        return Metadata(displayName, size, context.contentResolver.getType(uri))
    }

    private fun newSessionId(): String = UUID.randomUUID().toString().replace("-", "")

    private fun cleanDir(dir: File) {
        dir.listFiles()?.forEach { runCatching { it.delete() } }
        runCatching { dir.delete() }
    }
}
