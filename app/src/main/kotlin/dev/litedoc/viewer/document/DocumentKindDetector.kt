package dev.litedoc.viewer.document

/**
 * Decides the document kind from the display name, the provider MIME type and a
 * small file-head sniff. The name is never trusted on its own, and neither is
 * the MIME type: content URIs frequently report `application/octet-stream` for
 * Markdown, and some providers mislabel SVG.
 *
 * Pure Kotlin/JVM so it is unit-testable without an Android runtime.
 */
object DocumentKindDetector {

    data class Detection(
        val kind: DocumentKind,
        val confidence: DetectionConfidence,
        val reason: String,
        val mimeType: String?,
    )

    private val MARKDOWN_EXT = setOf("md", "markdown", "mdown", "mkd", "mkdn", "mdx")
    private val SVG_EXT = setOf("svg")
    private val MERMAID_EXT = setOf("mmd", "mermaid")
    private val CSV_EXT = setOf("csv")
    private val TSV_EXT = setOf("tsv", "tab")
    private val SMILES_EXT = setOf("smi", "smiles")
    private val HTML_EXT = setOf("html", "htm", "xhtml")
    private val LATEX_EXT = setOf("tex", "latex", "ltx")
    private val PLAIN_EXT = setOf("txt", "text", "log", "lst")
    private val SOURCE_EXT = setOf(
        "kt", "kts", "java", "scala", "groovy", "gradle", "py", "rb", "php", "pl",
        "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
        "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "go", "rs", "swift", "m", "mm",
        "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd",
        "json", "json5", "jsonc", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
        "xml", "xsd", "xsl", "plist", "sql", "graphql", "gql", "proto", "diff", "patch",
        "css", "scss", "less", "sass", "styl", "dockerfile", "makefile", "cmake", "mk",
    )

    fun detect(displayName: String?, mimeType: String?, head: ByteArray?): Detection {
        val normalizedMime = mimeType?.trim()?.lowercase()?.substringBefore(';')
        val ext = extensionOf(displayName)
        val sniffed = sniff(head)

        // 1. A confident content sniff wins over a misleading name/MIME.
        if (sniffed != null) {
            val byExt = ext?.let { kindForExtension(it) }
            val confidence = if (byExt == null || byExt == sniffed) {
                DetectionConfidence.HIGH
            } else {
                DetectionConfidence.MEDIUM
            }
            val reason = if (byExt != null && byExt != sniffed) {
                "content looks like ${sniffed.id}, extension says ${byExt.id}"
            } else {
                "content sniff: ${sniffed.id}"
            }
            return Detection(sniffed, confidence, reason, normalizedMime)
        }

        // 2. Extension.
        val byExt = ext?.let { kindForExtension(it) }
        if (byExt != null) {
            val confidence = if (mimeConflicts(byExt, normalizedMime)) {
                DetectionConfidence.MEDIUM
            } else {
                DetectionConfidence.HIGH
            }
            return Detection(byExt, confidence, "extension .$ext", normalizedMime)
        }

        // 3. MIME type.
        val byMime = kindForMime(normalizedMime)
        if (byMime != null) {
            return Detection(byMime, DetectionConfidence.MEDIUM, "mime ${normalizedMime}", normalizedMime)
        }

        // 4. Textual content with no format signal: readable plain text.
        return Detection(
            DocumentKind.PLAIN_TEXT,
            DetectionConfidence.LOW,
            "no extension or mime signal",
            normalizedMime,
        )
    }

    fun extensionOf(displayName: String?): String? {
        val name = displayName?.trim()?.substringAfterLast('/')?.substringAfterLast('\\') ?: return null
        val dot = name.lastIndexOf('.')
        if (dot <= 0 || dot == name.length - 1) return null
        val ext = name.substring(dot + 1).lowercase()
        if (ext.length > 16 || ext.any { !it.isLetterOrDigit() && it != '+' && it != '-' }) return null
        return ext
    }

    fun kindForExtension(ext: String): DocumentKind = when (ext) {
        in MARKDOWN_EXT -> DocumentKind.MARKDOWN
        in SVG_EXT -> DocumentKind.SVG
        in MERMAID_EXT -> DocumentKind.MERMAID
        in CSV_EXT -> DocumentKind.CSV
        in TSV_EXT -> DocumentKind.TSV
        in SMILES_EXT -> DocumentKind.SMILES
        in HTML_EXT -> DocumentKind.HTML
        in LATEX_EXT -> DocumentKind.LATEX
        in PLAIN_EXT -> DocumentKind.PLAIN_TEXT
        in SOURCE_EXT -> DocumentKind.SOURCE_CODE
        else -> DocumentKind.UNKNOWN
    }

    fun kindForMime(mime: String?): DocumentKind? = when (mime) {
        null, "" -> null
        "text/markdown", "text/x-markdown", "application/markdown" -> DocumentKind.MARKDOWN
        "image/svg+xml" -> DocumentKind.SVG
        "text/csv" -> DocumentKind.CSV
        "text/tab-separated-values", "text/tsv" -> DocumentKind.TSV
        "text/html", "application/xhtml+xml" -> DocumentKind.HTML
        "application/json", "application/x-yaml", "application/yaml", "text/yaml", "text/x-yaml" ->
            DocumentKind.SOURCE_CODE
        "application/x-tex", "application/x-latex", "text/x-tex" -> DocumentKind.LATEX
        "text/plain" -> null // ambiguous: sniff or name decides
        "text/xml", "application/xml" -> null
        else -> if (mime.startsWith("text/")) null else null
    }

    /** Returns the recommended MIME type to serve the snapshot with. */
    fun serveMime(kind: DocumentKind): String = when (kind) {
        DocumentKind.MARKDOWN -> "text/markdown; charset=utf-8"
        DocumentKind.SVG -> "image/svg+xml"
        DocumentKind.MERMAID -> "text/plain; charset=utf-8"
        DocumentKind.CSV -> "text/csv; charset=utf-8"
        DocumentKind.TSV -> "text/tab-separated-values; charset=utf-8"
        DocumentKind.SMILES -> "text/plain; charset=utf-8"
        DocumentKind.HTML -> "text/html; charset=utf-8"
        DocumentKind.LATEX, DocumentKind.SOURCE_CODE, DocumentKind.PLAIN_TEXT, DocumentKind.UNKNOWN ->
            "text/plain; charset=utf-8"
    }

    private fun mimeConflicts(kind: DocumentKind, mime: String?): Boolean {
        if (mime.isNullOrEmpty()) return false
        val byMime = kindForMime(mime) ?: return false
        return byMime != kind
    }

    /**
     * Content sniffing with a very small head sample. Only structural markers are
     * considered, so a Markdown file that merely contains the word "svg" is not
     * misdetected.
     */
    private fun sniff(head: ByteArray?): DocumentKind? {
        if (head == null || head.isEmpty()) return null
        val sampleLength = minOf(head.size, 4096)
        val text = String(head, 0, sampleLength, Charsets.ISO_8859_1)
        val trimmed = text.trimStart('\uFEFF', ' ', '\t', '\r', '\n')

        if (trimmed.startsWith("<svg", ignoreCase = true)) return DocumentKind.SVG
        if (trimmed.startsWith("<!DOCTYPE svg", ignoreCase = true)) return DocumentKind.SVG
        if (trimmed.startsWith("<?xml", ignoreCase = true)) {
            val head200 = trimmed.take(400).lowercase()
            if (head200.contains("<svg")) return DocumentKind.SVG
            return null
        }
        if (trimmed.startsWith("<!doctype html", ignoreCase = true) ||
            trimmed.startsWith("<html", ignoreCase = true)
        ) {
            return DocumentKind.HTML
        }

        val firstLine = trimmed.lineSequence().firstOrNull()?.trim().orEmpty()
        val mermaidStarters = listOf(
            "graph ", "flowchart ", "sequencediagram", "classdiagram", "statediagram",
            "erdiagram", "journey", "gantt", "pie", "gitgraph", "mindmap", "timeline",
            "quadrantchart", "xychart", "sankey-beta", "block-beta", "packet-beta",
            "architecture-beta", "kanban", "radar-beta", "treemap", "c4context",
            "c4container", "c4component", "c4dynamic", "c4deployment", "requirementdiagram",
            "zenuml",
        )
        val lowerFirst = firstLine.lowercase()
        if (mermaidStarters.any { lowerFirst.startsWith(it) }) return DocumentKind.MERMAID

        // Markdown structural markers inside the first block only.
        val headBlock = trimmed.take(2000)
        val markdownSignals = listOf(
            Regex("(?m)^#{1,6} \\S"),
            Regex("(?m)^```"),
            Regex("(?m)^~~~"),
            Regex("(?m)^> \\S"),
            Regex("(?m)^\\s*[-*+] \\S"),
            Regex("(?m)^\\s*\\d+\\. \\S"),
            Regex("(?m)^---+\\s*$"),
            Regex("(?m)^\\[.+?]:\\s*\\S+"),
            Regex("\\*\\*\\S+\\*\\*"),
            Regex("\\[\\S+]\\(\\S+\\)"),
        )
        if (markdownSignals.count { it.containsMatchIn(headBlock) } >= 2) return DocumentKind.MARKDOWN

        // SMILES records: "SMILES<whitespace>name" per line, chemistry-heavy charset.
        if (looksLikeSmiles(trimmed)) return DocumentKind.SMILES

        return null
    }

    /**
     * Conservative SMILES heuristic. Requires at least two lines that look like a
     * SMILES token, because a single line of punctuation-heavy prose must not be
     * treated as chemistry.
     */
    private fun looksLikeSmiles(sample: String): Boolean {
        val lines = sample.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() && !it.startsWith("#") }
            .take(12)
            .toList()
        if (lines.size < 2) return false
        var smilesLike = 0
        for (line in lines) {
            val token = line.split(' ', '\t')[0]
            if (token.isEmpty() || token.length > 512) continue
            val allowed = token.count { it in "CNOSPFIBrcnospl[]()=#@+-\\/%.0123456789HK" }
            val chemistryMarks = token.count { it in "()[]=#@\\/" }
            if (allowed == token.length && chemistryMarks >= 1 && token.length >= 4) smilesLike++
        }
        return smilesLike >= 2
    }
}
