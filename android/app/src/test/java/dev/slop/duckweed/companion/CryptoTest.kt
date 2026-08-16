package dev.slop.duckweed.companion

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Test

class CryptoTest {
    private fun decode(value: String): ByteArray = Base64.getUrlDecoder().decode(value)

    @Test
    fun decryptsTheRustTestVector() {
        val plain = Crypto.decryptBytes(
            secret = ByteArray(32),
            pairId = "pair-vector",
            messageId = "00000000-0000-4000-8000-000000000001",
            kind = "payload",
            nonce = decode("AAECAwQFBgcICQoL"),
            ciphertext = decode(
                "-THbvBtozACwNq8TVDZDL57l0-PY1uxSEq8aEX34X-nJx7giYUPOy-twOsawTfB1QcQ",
            ),
        )
        assertEquals("{\"version\":1,\"project\":\"Duckweed\"}", plain.toString(Charsets.UTF_8))
    }
}
