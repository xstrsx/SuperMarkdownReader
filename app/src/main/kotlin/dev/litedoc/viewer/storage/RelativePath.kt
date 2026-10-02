package dev.litedoc.viewer.storage

/**
 * Pure path arithmetic for attachment references inside an authorised tree.
 *
 * Rules:
 * * percent escapes are decoded once (a literal `%23` never becomes a fragment);
 * * `.` and `..` are resolved lexically, and `..` may never climb above the
 *   authorised root;
 * * NUL, backslashes, drive letters and empty segments are rejected;
 * * the result is a plain segment list, never a filesystem path string, because a
 *   content URI has no reliable relation to a disk path.
 */
object RelativePath {

    sealed interface Result {
        data class Ok(val segments: List<String>) : Result
        data object EscapesRoot : Result
        data class Invalid(val reason: String) : Result
    }

    fun resolve(baseSegments: List<String>, reference: String): Result {
        val cleaned = reference.trim()
        if (cleaned.isEmpty()) return Result.Invalid("empty reference")
        if (cleaned.indexOf('\u0000') >= 0) return Result.Invalid("NUL byte")
        if (cleaned.startsWith("\\\\")) return Result.Invalid("UNC path")
        if (Regex("^[A-Za-z]:[\\\\/]").containsMatchIn(cleaned)) return Result.Invalid("drive letter")

        val hashIndex = cleaned.indexOf('#')
        val queryIndex = cleaned.indexOf('?')
        val cut = listOf(hashIndex, queryIndex).filter { it >= 0 }.minOrNull() ?: cleaned.length
        val withoutFragmentOrQuery = cleaned.substring(0, cut)

        val decoded = percentDecode(withoutFragmentOrQuery)
            ?: return Result.Invalid("bad percent escape")

        val segments = ArrayList<String>(baseSegments)
        val parts = decoded.replace('\\', '/').split('/')
        for (part in parts) {
            when (part) {
                "", "." -> Unit
                ".." -> {
                    if (segments.isEmpty()) return Result.EscapesRoot
                    segments.removeAt(segments.size - 1)
                }
                else -> {
                    if (part.indexOf('\u0000') >= 0) return Result.Invalid("NUL byte in segment")
                    segments.add(part)
                }
            }
        }
        return Result.Ok(segments)
    }

    fun percentDecode(value: String): String? {
        if (!value.contains('%')) return value
        val out = StringBuilder(value.length)
        var i = 0
        while (i < value.length) {
            val ch = value[i]
            if (ch != '%') {
                out.append(ch)
                i++
                continue
            }
            if (i + 2 >= value.length) return null
            val hi = hexValue(value[i + 1])
            val lo = hexValue(value[i + 2])
            if (hi < 0 || lo < 0) return null
            out.append(((hi shl 4) or lo).toChar())
            i += 3
        }
        return out.toString()
    }

    private fun hexValue(ch: Char): Int = when (ch) {
        in '0'..'9' -> ch - '0'
        in 'a'..'f' -> ch - 'a' + 10
        in 'A'..'F' -> ch - 'A' + 10
        else -> -1
    }
}
