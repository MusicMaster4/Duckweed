package dev.slop.duckweed.companion

data class PairCredentials(
    val pairId: String,
    val relayUrl: String,
    val masterKey: String,
    val receiveToken: String,
    val deviceId: String,
    val deviceName: String,
)

data class CompletionRecord(
    val id: String,
    val sentAt: Long,
    val agent: String,
    val project: String,
    val kind: String,
    val response: String?,
    val durationMs: Long?,
)

data class EncryptedEnvelope(val nonce: String, val ciphertext: String)
