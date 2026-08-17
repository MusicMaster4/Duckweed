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
    val readAt: Long? = null,
    val attachments: List<MobileImageAttachment> = emptyList(),
    val deliveryState: String? = null,
    val deliveryError: String? = null,
)

data class MobileImageAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val dataUrl: String?,
    val size: Int,
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
    val conversation: List<RemoteConversationMessage> = emptyList(),
    val permission: RemotePermission? = null,
) {
    val isWorking: Boolean get() = status == "working" || status == "waiting"
}

data class RemotePermission(
    val id: String,
    val title: String,
    val detail: String?,
    val command: String?,
    val options: List<RemotePermissionOption>,
)

data class RemotePermissionOption(
    val id: String,
    val label: String,
    val kind: String,
)

data class RemoteConversationMessage(
    val id: String,
    val sentAt: Long,
    val role: String,
    val text: String,
)

data class ConversationTarget(
    val pairId: String,
    val projectId: String,
    val projectName: String,
    val terminal: RemoteTerminal,
)
