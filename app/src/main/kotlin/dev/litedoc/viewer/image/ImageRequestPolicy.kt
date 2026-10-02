package dev.litedoc.viewer.image

import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI

/**
 * Policy for the single network exit of the application.
 *
 * Pure JVM logic so it can be unit-tested without a device. The repository applies
 * it to the initial URL, to every redirect hop, and to the addresses actually
 * resolved for the host: all of them must be acceptable, otherwise a hostile DNS
 * answer could point one connection at an internal service.
 */
class ImageRequestPolicy(private val allowLan: () -> Boolean) {

    sealed interface Decision {
        data class Allow(val url: String, val host: String) : Decision
        data class Reject(val reason: Reason, val detail: String? = null) : Decision
    }

    enum class Reason {
        SCHEME_NOT_ALLOWED,
        USER_INFO_PRESENT,
        MISSING_HOST,
        INVALID_PORT,
        PRIVATE_ADDRESS,
        LOOPBACK_ADDRESS,
        LINK_LOCAL_ADDRESS,
        RESERVED_ADDRESS,
        DNS_FAILED,
        HTTPS_DOWNGRADE,
        TOO_MANY_REDIRECTS,
    }

    /** Syntactic checks; performs no name resolution. */
    fun validateUrl(raw: String): Decision {
        val trimmed = raw.trim()
        val uri = try {
            URI(trimmed)
        } catch (_: Exception) {
            return Decision.Reject(Reason.SCHEME_NOT_ALLOWED, "unparseable URL")
        }
        val scheme = uri.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") {
            return Decision.Reject(Reason.SCHEME_NOT_ALLOWED, scheme ?: "missing scheme")
        }
        if (uri.userInfo != null) return Decision.Reject(Reason.USER_INFO_PRESENT)
        val host = uri.host
        if (host.isNullOrBlank()) return Decision.Reject(Reason.MISSING_HOST)
        val port = uri.port
        if (port != -1 && (port < 1 || port > 65535)) return Decision.Reject(Reason.INVALID_PORT)
        return Decision.Allow(trimmed, host)
    }

    fun validateRedirect(from: String, to: String): Decision {
        val fromScheme = runCatching { URI(from).scheme?.lowercase() }.getOrNull()
        val toScheme = runCatching { URI(to).scheme?.lowercase() }.getOrNull()
        if (fromScheme == "https" && toScheme == "http") {
            return Decision.Reject(Reason.HTTPS_DOWNGRADE, "https -> http redirect refused")
        }
        return validateUrl(to)
    }

    /** Every resolved address must be acceptable; an empty answer is a failure. */
    fun validateAddresses(host: String, addresses: List<InetAddress>): Decision {
        if (addresses.isEmpty()) return Decision.Reject(Reason.DNS_FAILED, host)
        for (address in addresses) {
            val rejection = classify(address)
            if (rejection != null) return Decision.Reject(rejection, host)
        }
        return Decision.Allow(host, host)
    }

    /** Returns null when the address is acceptable, otherwise the rejection reason. */
    fun classify(address: InetAddress): Reason? {
        if (address.isLoopbackAddress) return Reason.LOOPBACK_ADDRESS
        if (address.isAnyLocalAddress) return Reason.RESERVED_ADDRESS
        if (address.isMulticastAddress) return Reason.RESERVED_ADDRESS

        if (address is Inet4Address) {
            val bytes = address.address
            val b0 = bytes[0].toInt() and 0xFF
            val b1 = bytes[1].toInt() and 0xFF
            if (b0 == 0) return Reason.RESERVED_ADDRESS
            if (b0 == 127) return Reason.LOOPBACK_ADDRESS
            if (b0 == 169 && b1 == 254) return Reason.LINK_LOCAL_ADDRESS
            if (b0 >= 224) return Reason.RESERVED_ADDRESS
            if (b0 == 100 && b1 in 64..127) return Reason.RESERVED_ADDRESS
            if (b0 == 192 && b1 == 0) return Reason.RESERVED_ADDRESS
            if (b0 == 198 && (b1 == 18 || b1 == 19)) return Reason.RESERVED_ADDRESS
            if (isPrivateV4(b0, b1)) return if (allowLan()) null else Reason.PRIVATE_ADDRESS
            return null
        }

        if (address is Inet6Address) {
            if (address.isLinkLocalAddress) return Reason.LINK_LOCAL_ADDRESS
            if (address.isSiteLocalAddress) return if (allowLan()) null else Reason.PRIVATE_ADDRESS
            val bytes = address.address
            if ((bytes[0].toInt() and 0xFE) == 0xFC) {
                return if (allowLan()) null else Reason.PRIVATE_ADDRESS
            }
            if (isIpv4Mapped(bytes)) {
                return classify(InetAddress.getByAddress(bytes.copyOfRange(12, 16)))
            }
            return null
        }

        return null
    }

    private fun isPrivateV4(b0: Int, b1: Int): Boolean =
        b0 == 10 || (b0 == 172 && b1 in 16..31) || (b0 == 192 && b1 == 168)

    private fun isIpv4Mapped(bytes: ByteArray): Boolean {
        if (bytes.size != 16) return false
        for (i in 0 until 10) if (bytes[i].toInt() != 0) return false
        return bytes[10].toInt() == 0xFF && bytes[11].toInt() == 0xFF
    }
}
