package dev.litedoc.viewer.document

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TextDecoderTest {

    @Test
    fun `utf8 decodes and keeps newlines`() {
        val text = "普通文本 $dollar\r\nsecond\nthird"
        val result = TextDecoder.decode(text.toByteArray(Charsets.UTF_8)) as TextDecoder.Result.Decoded
        assertEquals(text, result.text)
        assertEquals(TextDecoder.UTF8, result.charsetName)
        assertFalse(result.hadBom)
    }

    @Test
    fun `utf8 bom is stripped and reported`() {
        val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "标题".toByteArray()
        val result = TextDecoder.decode(bytes) as TextDecoder.Result.Decoded
        assertEquals("标题", result.text)
        assertTrue(result.hadBom)
    }

    @Test
    fun `utf16 with bom is not binary`() {
        val le = byteArrayOf(0xFF.toByte(), 0xFE.toByte()) + "中文".toByteArray(Charsets.UTF_16LE)
        assertFalse(TextDecoder.looksBinary(le))
        assertEquals("中文", (TextDecoder.decode(le) as TextDecoder.Result.Decoded).text)
        val be = byteArrayOf(0xFE.toByte(), 0xFF.toByte()) + "ABC".toByteArray(Charsets.UTF_16BE)
        assertEquals("ABC", (TextDecoder.decode(be) as TextDecoder.Result.Decoded).text)
    }

    @Test
    fun `forced charset wins over detection`() {
        val bytes = "caf\u00e9".toByteArray(Charsets.ISO_8859_1)
        val result = TextDecoder.decode(bytes, forcedCharset = "ISO-8859-1") as TextDecoder.Result.Decoded
        assertEquals("caf\u00e9", result.text)
    }

    @Test
    fun `gb18030 is decoded or offered as a candidate`() {
        val gb = "中文编码测试".toByteArray(charset("GB18030"))
        assertFalse(TextDecoder.isStrictUtf8(gb))
        when (val result = TextDecoder.decode(gb)) {
            is TextDecoder.Result.Decoded -> assertEquals("中文编码测试", result.text)
            is TextDecoder.Result.Ambiguous -> assertTrue(result.candidates.contains("GB18030"))
            is TextDecoder.Result.Binary -> throw AssertionError("GB18030 text must not be binary")
        }
    }

    @Test
    fun `nul bytes are binary`() {
        val bytes = ByteArray(64) { if (it % 4 == 0) 0x01 else 0x00 }
        assertTrue(TextDecoder.looksBinary(bytes))
        assertTrue(TextDecoder.decode(bytes) is TextDecoder.Result.Binary)
    }

    @Test
    fun `empty input decodes to empty text`() {
        assertEquals("", (TextDecoder.decode(ByteArray(0)) as TextDecoder.Result.Decoded).text)
    }
}
