package dev.slop.duckweed.companion

import android.util.Base64
import org.json.JSONObject
import org.json.JSONArray
import java.nio.charset.StandardCharsets
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Crypto {
    private fun decode(value: String): ByteArray =
        Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    fun encode(value: ByteArray): String =
        Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun hmac(key: ByteArray, value: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(value)
    }

    private fun encryptionKey(input: ByteArray, pairId: String): ByteArray {
        val prk = hmac(pairId.toByteArray(StandardCharsets.UTF_8), input)
        return hmac(prk, "duckweed/mobile/encryption/v1\u0001".toByteArray(StandardCharsets.UTF_8))
    }

    fun pairingProof(secret: String, pairId: String, deviceId: String, name: String): String {
        val value = "$pairId\n$deviceId\n$name".toByteArray(StandardCharsets.UTF_8)
        return encode(hmac(decode(secret), value))
    }

    fun decrypt(
        credentials: PairCredentials,
        messageId: String,
        kind: String,
        envelope: EncryptedEnvelope,
    ): CompletionRecord {
        val plain = decryptBytes(
            decode(credentials.masterKey),
            credentials.pairId,
            messageId,
            kind,
            decode(envelope.nonce),
            decode(envelope.ciphertext),
        )
        val json = JSONObject(String(plain, StandardCharsets.UTF_8))
        check(json.getInt("version") == 1 && json.getString("id") == messageId) {
            "Notification identity did not match its encrypted payload"
        }
        return CompletionRecord(
            id = messageId,
            pairId = json.optString("pairId").takeIf { it.isNotBlank() } ?: credentials.pairId,
            sentAt = json.getLong("sentAt"),
            agent = json.optString("agent", "Agent"),
            project = json.optString("project", "Duckweed"),
            projectId = json.optString("projectId").takeIf { it.isNotBlank() },
            terminalId = json.optString("terminalId").takeIf { it.isNotBlank() },
            terminalTitle = json.optString("terminalTitle").takeIf { it.isNotBlank() },
            kind = json.optString("kind", "completed"),
            response = if (json.isNull("response")) null else json.getString("response"),
            durationMs = if (json.isNull("durationMs")) null else json.getLong("durationMs"),
            soundCue = if (json.isNull("soundCue")) null else json.optInt("soundCue").takeIf { it in 0..5 },
            unreadOnDesktop = if (json.has("unreadOnDesktop")) json.optBoolean("unreadOnDesktop") else null,
            workspace = parseWorkspace(credentials.pairId, json),
        )
    }

    fun encrypt(
        credentials: PairCredentials,
        messageId: String,
        kind: String,
        plain: ByteArray,
    ): EncryptedEnvelope {
        val nonce = ByteArray(12).also(java.security.SecureRandom()::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.ENCRYPT_MODE,
            SecretKeySpec(encryptionKey(decode(credentials.masterKey), credentials.pairId), "AES"),
            GCMParameterSpec(128, nonce),
        )
        cipher.updateAAD("v1\n${credentials.pairId}\n$messageId\n$kind".toByteArray(StandardCharsets.UTF_8))
        return EncryptedEnvelope(encode(nonce), encode(cipher.doFinal(plain)))
    }

    private fun parseWorkspace(pairId: String, json: JSONObject): WorkspaceSnapshot? {
        if (json.optString("kind") != "workspace" || !json.has("projects")) return null
        val projectsJson = json.optJSONArray("projects") ?: JSONArray()
        val projects = (0 until projectsJson.length()).mapNotNull { projectIndex ->
            val project = projectsJson.optJSONObject(projectIndex) ?: return@mapNotNull null
            val terminalsJson = project.optJSONArray("terminals") ?: JSONArray()
            RemoteProject(
                id = project.optString("id"),
                name = project.optString("name", "Project"),
                path = project.optString("path"),
                branch = if (project.isNull("branch")) null else project.optString("branch").takeIf { it.isNotBlank() },
                terminals = (0 until terminalsJson.length()).mapNotNull { terminalIndex ->
                    val terminal = terminalsJson.optJSONObject(terminalIndex) ?: return@mapNotNull null
                    val conversationJson = terminal.optJSONArray("conversation") ?: JSONArray()
                    val permissionJson = terminal.optJSONObject("permission")
                    RemoteTerminal(
                        id = terminal.optString("id"),
                        title = terminal.optString("title", "Terminal"),
                        shell = terminal.optString("shell", "Terminal"),
                        agent = if (terminal.isNull("agent")) null else terminal.optString("agent").takeIf { it.isNotBlank() },
                        model = if (terminal.isNull("model")) null else terminal.optString("model").takeIf { it.isNotBlank() },
                        status = terminal.optString("status", "idle"),
                        unreadOnDesktop = if (terminal.has("unreadOnDesktop")) {
                            terminal.optBoolean("unreadOnDesktop")
                        } else {
                            null
                        },
                        conversation = (0 until conversationJson.length()).mapNotNull { messageIndex ->
                            val message = conversationJson.optJSONObject(messageIndex) ?: return@mapNotNull null
                            val role = message.optString("role")
                            val text = message.optString("text").trim()
                            if ((role != "user" && role != "assistant") || text.isEmpty()) {
                                return@mapNotNull null
                            }
                            RemoteConversationMessage(
                                id = message.optString("id", "remote-$messageIndex"),
                                sentAt = message.optLong("sentAt", json.optLong("sentAt")),
                                role = role,
                                text = text,
                            )
                        },
                        permission = permissionJson?.let { permission ->
                            val optionsJson = permission.optJSONArray("options") ?: JSONArray()
                            val options = (0 until optionsJson.length()).mapNotNull { optionIndex ->
                                val option = optionsJson.optJSONObject(optionIndex) ?: return@mapNotNull null
                                val id = option.optString("id")
                                val label = option.optString("label")
                                val kind = option.optString("kind")
                                if (id.isBlank() || label.isBlank() || kind !in setOf(
                                        "allow", "allow-always", "reject", "reject-always",
                                    )
                                ) return@mapNotNull null
                                RemotePermissionOption(id, label, kind)
                            }
                            RemotePermission(
                                id = permission.optString("id"),
                                title = permission.optString("title", "Approval required"),
                                detail = permission.optString("detail").takeIf { it.isNotBlank() },
                                command = permission.optString("command").takeIf { it.isNotBlank() },
                                options = options,
                            ).takeIf { it.id.isNotBlank() && it.options.isNotEmpty() }
                        },
                    )
                }.filter { it.id.isNotBlank() },
            )
        }.filter { it.id.isNotBlank() }
        return WorkspaceSnapshot(pairId, json.optLong("sentAt", System.currentTimeMillis()), projects)
    }

    internal fun decryptBytes(
        secret: ByteArray,
        pairId: String,
        messageId: String,
        kind: String,
        nonce: ByteArray,
        ciphertext: ByteArray,
    ): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(encryptionKey(secret, pairId), "AES"),
            GCMParameterSpec(128, nonce),
        )
        cipher.updateAAD("v1\n$pairId\n$messageId\n$kind".toByteArray(StandardCharsets.UTF_8))
        return cipher.doFinal(ciphertext)
    }
}
