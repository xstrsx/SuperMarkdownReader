package dev.litedoc.viewer.image

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ImageRequestPolicyTest {

    private fun policy(allowLan: Boolean = false) = ImageRequestPolicy { allowLan }

    @Test
    fun `only http and https are allowed`() {
        assertTrue(policy().validateUrl("http://example.com/a.png") is ImageRequestPolicy.Decision.Allow)
        assertTrue(policy().validateUrl("https://example.com/a.png") is ImageRequestPolicy.Decision.Allow)
        for (bad in listOf("file:///etc/passwd", "data:image/png;base64,AA", "content://media/1", "ftp://x/y")) {
            val decision = policy().validateUrl(bad)
            assertEquals(
                ImageRequestPolicy.Reason.SCHEME_NOT_ALLOWED,
                (decision as ImageRequestPolicy.Decision.Reject).reason,
            )
        }
    }

    @Test
    fun `user info and malformed hosts are refused`() {
        assertEquals(
            ImageRequestPolicy.Reason.USER_INFO_PRESENT,
            (policy().validateUrl("https://u:p@example.com/a") as ImageRequestPolicy.Decision.Reject).reason,
        )
        assertTrue(policy().validateUrl("http://") is ImageRequestPolicy.Decision.Reject)
        assertTrue(policy().validateUrl("not a url") is ImageRequestPolicy.Decision.Reject)
    }

    @Test
    fun `loopback and link local are refused even with lan allowed`() {
        assertEquals(
            ImageRequestPolicy.Reason.LOOPBACK_ADDRESS,
            policy(true).classify(InetAddress.getByName("127.0.0.1")),
        )
        assertEquals(
            ImageRequestPolicy.Reason.LINK_LOCAL_ADDRESS,
            policy(true).classify(InetAddress.getByName("169.254.169.254")),
        )
    }

    @Test
    fun `private ranges follow the lan switch`() {
        val private10 = InetAddress.getByName("10.1.2.3")
        assertEquals(ImageRequestPolicy.Reason.PRIVATE_ADDRESS, policy(false).classify(private10))
        assertEquals(ImageRequestPolicy.Reason.PRIVATE_ADDRESS, policy(false).classify(InetAddress.getByName("192.168.0.5")))
        assertEquals(ImageRequestPolicy.Reason.PRIVATE_ADDRESS, policy(false).classify(InetAddress.getByName("172.20.5.5")))
        assertEquals(null, policy(true).classify(private10))
    }

    @Test
    fun `public addresses pass`() {
        assertEquals(null, policy().classify(InetAddress.getByName("93.184.216.34")))
        assertEquals(null, policy().classify(InetAddress.getByName("2606:2800:220:1:248:1893:25c8:1946")))
    }

    @Test
    fun `dns answers are all checked`() {
        val mixed = listOf(InetAddress.getByName("93.184.216.34"), InetAddress.getByName("10.0.0.1"))
        assertTrue(policy().validateAddresses("example.com", mixed) is ImageRequestPolicy.Decision.Reject)
        assertTrue(policy().validateAddresses("example.com", emptyList()) is ImageRequestPolicy.Decision.Reject)
    }

    @Test
    fun `redirect downgrade is refused`() {
        assertEquals(
            ImageRequestPolicy.Reason.HTTPS_DOWNGRADE,
            (policy().validateRedirect("https://a/b", "http://a/c") as ImageRequestPolicy.Decision.Reject).reason,
        )
        assertTrue(
            policy().validateRedirect("http://a/b", "https://a/c") is ImageRequestPolicy.Decision.Allow,
        )
    }
}
