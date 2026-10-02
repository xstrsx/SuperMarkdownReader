package dev.litedoc.viewer.storage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RelativePathTest {

    private fun ok(base: List<String>, reference: String): List<String> =
        (RelativePath.resolve(base, reference) as RelativePath.Result.Ok).segments

    @Test
    fun `relative references resolve against the base`() {
        assertEquals(listOf("docs", "img", "a.png"), ok(listOf("docs"), "img/a.png"))
        assertEquals(listOf("docs", "a.png"), ok(listOf("docs"), "./a.png"))
        assertEquals(listOf("a.png"), ok(listOf("docs"), "../a.png"))
        assertEquals(listOf("a", "b.png"), ok(emptyList(), "a//./b.png"))
    }

    @Test
    fun `escaping the root is refused`() {
        assertTrue(RelativePath.resolve(emptyList(), "../a.png") is RelativePath.Result.EscapesRoot)
        assertTrue(RelativePath.resolve(listOf("docs"), "../../a.png") is RelativePath.Result.EscapesRoot)
    }

    @Test
    fun `percent escapes are decoded once`() {
        assertEquals(listOf("a b#c.png"), ok(emptyList(), "a%20b%23c.png"))
        assertEquals(listOf("50%25.png"), ok(emptyList(), "50%2525.png"))
    }

    @Test
    fun `invalid references are rejected`() {
        assertTrue(RelativePath.resolve(emptyList(), "") is RelativePath.Result.Invalid)
        assertTrue(RelativePath.resolve(emptyList(), "a%2.png") is RelativePath.Result.Invalid)
        assertTrue(RelativePath.resolve(emptyList(), "C:\\Windows\\f") is RelativePath.Result.Invalid)
        assertTrue(RelativePath.resolve(emptyList(), "\\\\srv\\share") is RelativePath.Result.Invalid)
        assertTrue(RelativePath.resolve(emptyList(), "a\u0000b") is RelativePath.Result.Invalid)
    }

    @Test
    fun `fragments and queries are stripped`() {
        assertEquals(listOf("a.png"), ok(emptyList(), "a.png#frag?x=1"))
        assertEquals(listOf("a.png"), ok(emptyList(), "a.png?x=1#frag"))
    }

    @Test
    fun `unicode and spaces survive`() {
        assertEquals(listOf("图片", "中文 名.png"), ok(listOf("图片"), "中文 名.png"))
    }
}
