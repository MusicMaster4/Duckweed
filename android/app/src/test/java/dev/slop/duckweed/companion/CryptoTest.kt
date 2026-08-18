package dev.slop.duckweed.companion

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.json.JSONObject

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

    @Test
    fun keepsTerminalPresentationFieldsFromWorkspacePayload() {
        val snapshot = Crypto.parseWorkspace(
            "pair",
            JSONObject(
                """
                {
                  "kind":"workspace",
                  "sentAt":42,
                  "projects":[{
                    "id":"project",
                    "name":"Duckweed",
                    "path":"C:/duckweed",
                    "branch":"main",
                    "color":"#7BE05A",
                    "terminals":[{
                      "id":"terminal",
                      "title":"Codex",
                      "shell":"PowerShell",
                      "agent":"Codex",
                      "model":null,
                      "status":"idle",
                      "mode":"terminal",
                      "terminalColumns":120,
                      "terminalRows":32,
                      "terminalOutput":"Codex ready",
                      "conversation":[],
                      "permission":null
                    }]
                  }]
                }
                """.trimIndent(),
            ),
        )

        assertNotNull(snapshot)
        val project = snapshot!!.projects.single()
        val terminal = project.terminals.single()
        assertEquals("#7BE05A", project.color)
        assertEquals("terminal", terminal.mode)
        assertEquals(120, terminal.terminalColumns)
        assertEquals(32, terminal.terminalRows)
        assertEquals("Codex ready", terminal.terminalOutput)
    }
}
