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
    val pairId: String? = null,
    val projectId: String? = null,
    val terminalId: String? = null,
    val terminalTitle: String? = null,
    val soundCue: Int? = null,
    val workspace: WorkspaceSnapshot? = null,
)

data class EncryptedEnvelope(val nonce: String, val ciphertext: String)

data class WorkspaceSnapshot(
    val pairId: String,
    val updatedAt: Long,
    val projects: List<RemoteProject>,
)

data class RemoteProject(
    val id: String,
    val name: String,
    val path: String,
    val branch: String?,
    val terminals: List<RemoteTerminal>,
)

data class RemoteTerminal(
    val id: String,
    val title: String,
    val shell: String,
    val agent: String?,
    val model: String?,
    val status: String,
) {
    val isWorking: Boolean get() = status == "working" || status == "waiting"
}

data class ConversationTarget(
    val pairId: String,
    val projectId: String,
    val projectName: String,
    val terminal: RemoteTerminal,
)
