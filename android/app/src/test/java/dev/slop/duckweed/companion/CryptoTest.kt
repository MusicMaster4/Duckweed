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

    @Test
    fun keepsCommandsAndDiffsFromAgentActivity() {
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
                    "terminals":[{
                      "id":"terminal",
                      "title":"Codex",
                      "shell":"PowerShell",
                      "agent":"Codex",
                      "status":"working",
                      "mode":"conversation",
                      "activity":[{
                        "id":"tool",
                        "at":40,
                        "kind":"tool",
                        "title":"Update the mobile timeline",
                        "detail":"Applied patch",
                        "command":"git diff -- app.kt",
                        "changes":[{
                          "path":"app.kt",
                          "insertions":2,
                          "deletions":1,
                          "diff":"@@\n-old\n+new"
                        }],
                        "status":"done"
                      }],
                      "conversation":[],
                      "permission":null
                    }]
                  }]
                }
                """.trimIndent(),
            ),
        )

        val activity = snapshot!!.projects.single().terminals.single().activity.single()
        assertEquals("git diff -- app.kt", activity.command)
        assertEquals("app.kt", activity.changes.single().path)
        assertEquals(2, activity.changes.single().insertions)
        assertEquals("@@\n-old\n+new", activity.changes.single().diff)
    }
}
