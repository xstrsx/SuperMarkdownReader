package dev.litedoc.viewer.document

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction

/**
 * Encoding detection and decoding.
 *
 * Rules from the plan:
 * * a BOM is checked first, and never destroyed: a UTF-16 document is not
 *   misclassified as binary because of its NUL bytes;
 * * UTF-8 is the default and is decoded strictly;
 * * when strict UTF-8 fails, other encodings are scored and the best candidate is
 *   offered, with a manual override;
 * * a silent mojibake result is never produced.
 *
 * Pure Kotlin/JVM, so it is unit-testable without an Android runtime.
 */
object TextDecoder {

    const val UTF8 = "UTF-8"

    data class Bom(val charsetName: String, val length: Int)

    sealed interface Result {
        data class Decoded(val text: String, val charsetName: String, val hadBom: Boolean) : Result
        data class Binary(val detail: String) : Result
        data class Ambiguous(
            val candidates: List<String>,
            val text: String,
            val charsetName: String,
        ) : Result
    }

    /** Charsets offered for manual selection, in preference order. */
    val manualCandidates: List<String> = listOf(
        UTF8, "GB18030", "UTF-16LE", "UTF-16BE", "Big5", "Shift_JIS", "EUC-KR",
        "windows-1252", "ISO-8859-1",
    )

    private val scoredOrder = listOf(
        UTF8, "GB18030", "GBK", "Big5", "Shift_JIS", "EUC-KR", "windows-1252", "ISO-8859-1",
    )

    fun charsetOrNull(name: String): Charset? = try {
        Charset.forName(name)
    } catch (_: Exception) {
        null
    }

    fun availableManualCandidates(): List<String> =
        manualCandidates.filter { charsetOrNull(it) != null }

    fun detectBom(head: ByteArray): Bom? {
        if (head.size >= 3 &&
            head[0] == 0xEF.toByte() && head[1] == 0xBB.toByte() && head[2] == 0xBF.toByte()
        ) {
            return Bom(UTF8, 3)
        }
        if (head.size >= 4 &&
            head[0] == 0xFF.toByte() && head[1] == 0xFE.toByte() &&
            head[2] == 0x00.toByte() && head[3] == 0x00.toByte()
        ) {
            return Bom("UTF-32LE", 4)
        }
        if (head.size >= 4 &&
            head[0] == 0x00.toByte() && head[1] == 0x00.toByte() &&
            head[2] == 0xFE.toByte() && head[3] == 0xFF.toByte()
        ) {
            return Bom("UTF-32BE", 4)
        }
        if (head.size >= 2 && head[0] == 0xFF.toByte() && head[1] == 0xFE.toByte()) {
            return Bom("UTF-16LE", 2)
        }
        if (head.size >= 2 && head[0] == 0xFE.toByte() && head[1] == 0xFF.toByte()) {
            return Bom("UTF-16BE", 2)
        }
        return null
    }

    /**
     * Heuristic binary probe, applied only after BOM detection. It is a hint: a
     * UTF-16 stream without a BOM is treated as text, not as binary.
     */
    fun looksBinary(head: ByteArray): Boolean {
        if (head.isEmpty()) return false
        if (detectBom(head) != null) return false
        val sample = head.copyOf(minOf(head.size, 8192))
        var nul = 0
        var control = 0
        var utf16PatternHits = 0
        for (i in sample.indices) {
            val b = sample[i].toInt() and 0xFF
            if (b == 0x00) {
                nul++
                // "a\0b\0" pattern suggests UTF-16LE without a BOM.
                if (i % 2 == 1) utf16PatternHits++
            } else if (b < 0x09 || (b in 0x0E..0x1F)) {
                control++
            }
        }
        val size = sample.size
        if (nul > 0 && utf16PatternHits >= nul - 1 && nul * 2 >= size / 4) return false
        if (nul > size / 100) return true
        return control > size / 20
    }

    /**
     * Decodes [bytes]. When [forcedCharset] is given, nothing is auto-detected.
     */
    fun decode(bytes: ByteArray, forcedCharset: String? = null): Result {
        if (bytes.isEmpty()) return Result.Decoded("", forcedCharset ?: UTF8, hadBom = false)

        val head = bytes.copyOf(minOf(bytes.size, 8192))
        val bom = if (forcedCharset == null) detectBom(head) else null

        if (forcedCharset != null) {
            val charset = charsetOrNull(forcedCharset)
                ?: return Result.Ambiguous(availableManualCandidates(), "", UTF8)
            val text = decodeLenient(bytes, 0, bytes.size, charset)
            return Result.Decoded(text, charset.name(), hadBom = false)
        }

        if (bom != null) {
            val charset = charsetOrNull(bom.charsetName)
            if (charset != null) {
                val text = decodeLenient(bytes, bom.length, bytes.size, charset)
                return Result.Decoded(text, bom.charsetName, hadBom = true)
            }
        }

        // Binary probe before the UTF-8 attempt: byte-wise UTF-8 validation accepts any
        // pure-ASCII stream, so NUL-padded binary data would otherwise be presented as
        // text. Legitimate UTF-16 without a BOM is protected inside the probe by the
        // alternating-NUL pattern check above, and real UTF-16 text carries high bytes
        // that fail strict UTF-8 anyway.
        if (looksBinary(head)) {
            return Result.Binary("NUL or control bytes in the first bytes of the file")
        }

        // Strict UTF-8 next: if it succeeds the content is certainly UTF-8.
        if (isStrictUtf8(bytes)) {
            return Result.Decoded(String(bytes, Charsets.UTF_8), UTF8, hadBom = false)
        }

        data class Scored(val name: String, val text: String, val score: Double)

        val scored = ArrayList<Scored>(scoredOrder.size)
        for (name in scoredOrder) {
            val charset = charsetOrNull(name) ?: continue
            val text = decodeLenient(bytes, 0, bytes.size, charset)
            scored.add(Scored(name, text, scoreText(text)))
        }
        if (scored.isEmpty()) {
            return Result.Decoded(String(bytes, Charsets.ISO_8859_1), "ISO-8859-1", hadBom = false)
        }
        scored.sortByDescending { it.score }
        val best = scored.first()
        val runnerUp = scored.getOrNull(1)
        val confident = best.name != "windows-1252" &&
            (runnerUp == null || best.score - runnerUp.score >= 0.02) &&
            best.score >= 0.995

        return if (confident) {
            Result.Decoded(best.text, best.name, hadBom = false)
        } else {
            Result.Ambiguous(
                candidates = availableManualCandidates(),
                text = best.text,
                charsetName = best.name,
            )
        }
    }

    fun isStrictUtf8(bytes: ByteArray): Boolean = try {
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        decoder.decode(ByteBuffer.wrap(bytes))
        true
    } catch (_: CharacterCodingException) {
        false
    }

    private fun decodeLenient(bytes: ByteArray, offset: Int, length: Int, charset: Charset): String {
        if (length <= offset) return ""
        return try {
            val decoder = charset.newDecoder()
                .onMalformedInput(CodingErrorAction.REPLACE)
                .onUnmappableCharacter(CodingErrorAction.REPLACE)
            decoder.decode(ByteBuffer.wrap(bytes, offset, length - offset)).toString()
        } catch (_: Exception) {
            ""
        }
    }

    /**
     * Rough "is this plausible text" score in 0..1: replacement characters and
     * unexpected control characters lower the score.
     */
    private fun scoreText(text: String): Double {
        if (text.isEmpty()) return 0.0
        var bad = 0
        for (ch in text) {
            when {
                ch == '\uFFFD' -> bad += 4
                ch.code < 0x20 && ch != '\n' && ch != '\r' && ch != '\t' -> bad += 3
                ch.code in 0x80..0x9F && ch.code != 0x85 -> bad += 1
                else -> Unit
            }
        }
        val score = 1.0 - (bad.toDouble() / (text.length.toDouble() * 4.0))
        return score.coerceIn(0.0, 1.0)
    }
}
