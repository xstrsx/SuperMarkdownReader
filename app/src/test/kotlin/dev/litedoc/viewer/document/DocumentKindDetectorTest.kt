package dev.litedoc.viewer.document

import org.junit.Assert.assertEquals
import org.junit.Test

class DocumentKindDetectorTest {

    private fun detect(name: String?, mime: String?, text: String) =
        DocumentKindDetector.detect(name, mime, text.toByteArray(Charsets.UTF_8))

    @Test
    fun `extension mapping`() {
        assertEquals(DocumentKind.MARKDOWN, detect("a.md", null, "# t").kind)
        assertEquals(DocumentKind.CSV, detect("a.csv", null, "a,b").kind)
        assertEquals(DocumentKind.TSV, detect("a.tsv", null, "a\tb").kind)
        assertEquals(DocumentKind.SMILES, detect("a.smi", null, "CCO").kind)
        assertEquals(DocumentKind.SVG, detect("a.svg", null, "<svg/>").kind)
        assertEquals(DocumentKind.HTML, detect("a.htm", null, "<html></html>").kind)
        assertEquals(DocumentKind.LATEX, detect("a.tex", null, "\\documentclass{a}").kind)
        assertEquals(DocumentKind.SOURCE_CODE, detect("a.kt", null, "fun main() {}").kind)
        assertEquals(DocumentKind.PLAIN_TEXT, detect("a.log", null, "hello").kind)
    }

    @Test
    fun `content sniffing beats a misleading name or mime`() {
        assertEquals(DocumentKind.MARKDOWN, detect("file", "application/octet-stream", "# 标题\n\n- 一\n- 二\n").kind)
        assertEquals(DocumentKind.SVG, detect("drawing.txt", "text/plain", "<svg xmlns=\"x\"/>").kind)
        assertEquals(DocumentKind.SVG, detect("x.dat", null, "<?xml version=\"1.0\"?>\n<svg/>").kind)
        assertEquals(DocumentKind.HTML, detect("x.dat", null, "<!DOCTYPE html><html></html>").kind)
        assertEquals(DocumentKind.MERMAID, detect("x.dat", null, "flowchart TD\n A-->B\n").kind)
    }

    @Test
    fun `smiles needs more than one chemistry line`() {
        val records = "CC(=O)Oc1ccccc1C(=O)O 阿司匹林\nCN1C=NC2=C1C(=O)N(C(=O)N2C)C 咖啡因\n"
        assertEquals(DocumentKind.SMILES, detect("records", null, records).kind)
        assertEquals(DocumentKind.PLAIN_TEXT, detect("note", null, "价格是 $5。\n这是一句话。\n").kind)
    }

    @Test
    fun `unknown text is low confidence plain text`() {
        val detection = detect("mystery", null, "just some words\n")
        assertEquals(DocumentKind.PLAIN_TEXT, detection.kind)
        assertEquals(DetectionConfidence.LOW, detection.confidence)
    }

    @Test
    fun `extension helper edge cases`() {
        assertEquals("md", DocumentKindDetector.extensionOf("/path/中文 名.md"))
        assertEquals(null, DocumentKindDetector.extensionOf("noext"))
        assertEquals(null, DocumentKindDetector.extensionOf("trailing."))
        assertEquals(null, DocumentKindDetector.extensionOf(".hidden"))
    }

    @Test
    fun `served mime types are explicit`() {
        assertEquals("text/markdown; charset=utf-8", DocumentKindDetector.serveMime(DocumentKind.MARKDOWN))
        assertEquals("image/svg+xml", DocumentKindDetector.serveMime(DocumentKind.SVG))
    }
}
