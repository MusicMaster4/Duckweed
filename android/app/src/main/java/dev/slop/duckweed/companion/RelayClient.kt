package dev.slop.duckweed.companion

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.util.UUID

object RelayClient {
    private val tokenPattern = Regex("^[A-Za-z0-9_-]{32,256}$")

    data class PairingCode(
        val relayUrl: String,
        val pairId: String,
        val registrationToken: String,
        val secret: String,
        val expiresAt: Long,
    )

    fun parsePairingCode(raw: String): PairingCode {
        val json = JSONObject(raw)
        require(json.getInt("version") == 1) { "This pairing code uses an unsupported version." }
        val relayUrl = json.getString("relayUrl").trimEnd('/')
        val pairId = json.getString("pairId")
        val registrationToken = json.getString("registrationToken")
        val secret = json.getString("secret")
        val expiresAt = json.getLong("expiresAt")
        require(relayUrl.startsWith("https://")) { "Pairing requires a secure HTTPS relay." }
        require(runCatching { UUID.fromString(pairId) }.isSuccess) { "The pairing identifier is invalid." }
        require(tokenPattern.matches(registrationToken) && tokenPattern.matches(secret)) {
            "The pairing code is incomplete."
        }
        require(expiresAt > System.currentTimeMillis()) { "This pairing code has expired." }
        return PairingCode(relayUrl, pairId, registrationToken, secret, expiresAt)
    }

    private fun randomToken(): String {
        val bytes = ByteArray(32)
        SecureRandom().nextBytes(bytes)
        return Crypto.encode(bytes)
    }

    private fun deviceName(): String {
        val manufacturer = Build.MANUFACTURER.trim().replaceFirstChar { it.uppercase() }
        val model = Build.MODEL.trim()
        return "$manufacturer $model".trim().take(80)
    }

    fun register(code: PairingCode, fcmToken: String): PairCredentials {
        val deviceId = UUID.randomUUID().toString()
        val receiveToken = randomToken()
        val name = deviceName()
        val proof = Crypto.pairingProof(code.secret, code.pairId, deviceId, name)
        request(
            method = "POST",
            url = "${code.relayUrl}/v1/pairings/${code.pairId}/register",
            payload = JSONObject()
                .put("registrationToken", code.registrationToken)
                .put("receiveToken", receiveToken)
                .put("fcmToken", fcmToken)
                .put("deviceId", deviceId)
                .put("name", name)
                .put("proof", proof),
        )
        return PairCredentials(
            pairId = code.pairId,
            relayUrl = code.relayUrl,
            masterKey = code.secret,
            receiveToken = receiveToken,
            deviceId = deviceId,
            deviceName = name,
        )
    }

    fun refreshFcmToken(credentials: PairCredentials, fcmToken: String) {
        request(
            method = "PUT",
            url = "${credentials.relayUrl}/v1/pairings/${credentials.pairId}/device",
            bearer = credentials.receiveToken,
            payload = JSONObject().put("fcmToken", fcmToken),
        )
    }

    fun disconnect(credentials: PairCredentials) {
        request(
            method = "DELETE",
            url = "${credentials.relayUrl}/v1/pairings/${credentials.pairId}/device",
            bearer = credentials.receiveToken,
        )
    }

    fun fetch(credentials: PairCredentials, messageId: String): EncryptedEnvelope {
        val result = request(
            method = "GET",
            url = "${credentials.relayUrl}/v1/pairings/${credentials.pairId}/messages/$messageId",
            bearer = credentials.receiveToken,
        )
        val payload = result.getJSONObject("payload")
        return EncryptedEnvelope(
            nonce = payload.getString("nonce"),
            ciphertext = payload.getString("ciphertext"),
        )
    }

    fun acknowledge(credentials: PairCredentials, messageId: String) {
        request(
            method = "DELETE",
            url = "${credentials.relayUrl}/v1/pairings/${credentials.pairId}/messages/$messageId",
            bearer = credentials.receiveToken,
        )
    }

    data class SentCommand(val id: String, val sentAt: Long)

    fun sendCommand(
        credentials: PairCredentials,
        projectId: String,
        terminalId: String,
        text: String,
        attachments: List<MobileImageAttachment> = emptyList(),
        commandId: String = UUID.randomUUID().toString(),
        sentAt: Long = System.currentTimeMillis(),
    ): SentCommand {
        require(attachments.size <= 1) { "Only one image can be sent at a time." }
        return sendEncryptedCommand(
            credentials,
            JSONObject()
                .put("kind", "input")
                .put("projectId", projectId)
                .put("terminalId", terminalId)
                .put("text", text)
                .put(
                    "images",
                    JSONArray().apply {
                        attachments.forEach { attachment ->
                            val dataUrl = attachment.dataUrl
                                ?: error("The selected image is no longer available.")
                            put(
                                JSONObject()
                                    .put("id", attachment.id)
                                    .put("name", attachment.name)
                                    .put("mimeType", attachment.mimeType)
                                    .put("dataUrl", dataUrl)
                                    .put("size", attachment.size),
                            )
                        }
                    },
                ),
            commandId,
            sentAt,
        )
    }

    fun sendApproval(
        credentials: PairCredentials,
        projectId: String,
        terminalId: String,
        permissionId: String,
        optionId: String,
    ): SentCommand = sendEncryptedCommand(
        credentials,
        JSONObject()
            .put("kind", "approval")
            .put("projectId", projectId)
            .put("terminalId", terminalId)
            .put("permissionId", permissionId)
            .put("optionId", optionId),
    )

    private fun sendEncryptedCommand(
        credentials: PairCredentials,
        fields: JSONObject,
        commandId: String = UUID.randomUUID().toString(),
        sentAt: Long = System.currentTimeMillis(),
    ): SentCommand {
        val plain = fields
            .put("version", 1)
            .put("id", commandId)
            .put("sentAt", sentAt)
            .toString()
            .toByteArray(Charsets.UTF_8)
        val encrypted = Crypto.encrypt(credentials, commandId, "command", plain)
        request(
            method = "POST",
            url = "${credentials.relayUrl}/v1/pairings/${credentials.pairId}/commands",
            bearer = credentials.receiveToken,
            payload = JSONObject()
                .put("commandId", commandId)
                .put("sentAt", sentAt)
                .put(
                    "payload",
                    JSONObject()
                        .put("nonce", encrypted.nonce)
                        .put("ciphertext", encrypted.ciphertext),
                ),
        )
        return SentCommand(commandId, sentAt)
    }

    fun isCommandPending(credentials: PairCredentials, commandId: String): Boolean =
        request(
            method = "GET",
            url = "${credentials.relayUrl}/v1/pairings/${credentials.pairId}/commands/$commandId",
            bearer = credentials.receiveToken,
        ).optBoolean("pending", false)

    fun requestWorkspaceRefresh(credentials: PairCredentials) {
        val commandId = UUID.randomUUID().toString()
        val sentAt = System.currentTimeMillis()
        val plain = JSONObject()
            .put("version", 1)
            .put("id", commandId)
            .put("sentAt", sentAt)
            .put("kind", "refresh")
            .toString()
            .toByteArray(Charsets.UTF_8)
        val encrypted = Crypto.encrypt(credentials, commandId, "command", plain)
        request(
            method = "POST",
            url = "${credentials.relayUrl}/v1/pairings/${credentials.pairId}/commands",
            bearer = credentials.receiveToken,
            payload = JSONObject()
                .put("commandId", commandId)
                .put("sentAt", sentAt)
                .put(
                    "payload",
                    JSONObject()
                        .put("nonce", encrypted.nonce)
                        .put("ciphertext", encrypted.ciphertext),
                ),
        )
    }

    private fun request(
        method: String,
        url: String,
        bearer: String? = null,
        payload: JSONObject? = null,
    ): JSONObject {
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 12_000
            readTimeout = 18_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "DuckweedCompanion/${BuildConfig.VERSION_NAME}")
            if (bearer != null) setRequestProperty("Authorization", "Bearer $bearer")
            if (payload != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
            }
        }
        try {
            if (payload != null) {
                connection.outputStream.use { it.write(payload.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val content = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            if (status !in 200..299) {
                val detail = runCatching { JSONObject(content).optString("error") }.getOrNull()
                throw IOException(detail?.takeIf { it.isNotBlank() } ?: "Relay returned HTTP $status")
            }
            return if (content.isBlank()) JSONObject() else JSONObject(content)
        } finally {
            connection.disconnect()
        }
    }
}
