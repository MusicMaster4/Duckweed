package dev.slop.duckweed.companion

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.util.concurrent.Executors

class DuckweedMessagingService : FirebaseMessagingService() {
    private val executor = Executors.newSingleThreadExecutor()

    override fun onCreate() {
        super.onCreate()
        NotificationTools.createChannel(this)
    }

    override fun onNewToken(token: String) {
        val credentials = SecretStore.loadAll(this)
        executor.execute {
            credentials.forEach { pairing ->
                runCatching { RelayClient.refreshFcmToken(pairing, token) }
            }
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        if (data["version"] != "1") return
        val pairId = data["pair_id"] ?: return
        val credentials = SecretStore.load(this, pairId) ?: return
        val messageId = data["message_id"] ?: return
        val nonce = data["preview_nonce"] ?: return
        val ciphertext = data["preview_ciphertext"] ?: return
        val preview = runCatching {
            Crypto.decrypt(
                credentials,
                messageId,
                "preview",
                EncryptedEnvelope(nonce, ciphertext),
            )
        }.getOrNull() ?: return
        // A successfully decrypted push proves that this desktop pairing is
        // reachable. Use the phone's clock so clock skew cannot turn a message
        // that just arrived into an "offline" state.
        WorkspaceStore(this).markPresence(pairId, System.currentTimeMillis())
        if (preview.kind != "workspace" && preview.kind != "presence") {
            val store = MessageStore(this)
            store.put(preview)
            if (!NotificationPreference.isEnabled(this) || preview.unreadOnDesktop == false) {
                store.markNotified(preview.id, preview.sentAt)
            } else if (store.isNotificationPending(preview.id) && NotificationTools.show(this, preview)) {
                store.markNotified(preview.id)
            }
        }
        NotificationTools.announceChanged(this)

        MessageFetchScheduler.enqueue(this, pairId, messageId)
    }
}
