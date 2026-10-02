package dev.litedoc.viewer.document

/**
 * Document categories LiteDoc can render. The web layer picks a renderer from
 * this value; it never guesses from the file name again.
 */
enum class DocumentKind(val id: String, val richCapable: Boolean) {
    MARKDOWN("markdown", true),
    SVG("svg", true),
    MERMAID("mermaid", true),
    CSV("csv", true),
    TSV("tsv", true),
    SMILES("smiles", true),
    HTML("html", true),
    LATEX("latex", false),
    PLAIN_TEXT("text", false),
    SOURCE_CODE("source", false),
    UNKNOWN("unknown", false),
    ;

    companion object {
        fun fromId(id: String?): DocumentKind =
            entries.firstOrNull { it.id == id } ?: UNKNOWN
    }
}

/** Confidence of a format decision; low confidence is surfaced to the user. */
enum class DetectionConfidence { HIGH, MEDIUM, LOW }
