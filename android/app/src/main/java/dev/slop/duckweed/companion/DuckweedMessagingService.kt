package dev.slop.duckweed.companion

import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
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
        val store = MessageStore(this)
        store.put(preview)
        if (store.isNotificationPending(preview.id) && NotificationTools.show(this, preview)) {
            store.markNotified(preview.id)
        }
        NotificationTools.announceChanged(this)

        val input = Data.Builder()
            .putString(MessageFetchWorker.PAIR_ID, pairId)
            .putString(MessageFetchWorker.MESSAGE_ID, messageId)
            .build()
        val work = OneTimeWorkRequestBuilder<MessageFetchWorker>()
            .setInputData(input)
            .build()
        WorkManager.getInstance(this).enqueueUniqueWork(
            "duckweed-message-$messageId",
            ExistingWorkPolicy.KEEP,
            work,
        )
    }
}
