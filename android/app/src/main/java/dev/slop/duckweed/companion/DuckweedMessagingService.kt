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
        val credentials = SecretStore.load(this) ?: return
        executor.execute {
            runCatching { RelayClient.refreshFcmToken(credentials, token) }
        }
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        val data = remoteMessage.data
        if (data["version"] != "1") return
        val credentials = SecretStore.load(this) ?: return
        val pairId = data["pair_id"] ?: return
        val messageId = data["message_id"] ?: return
        val nonce = data["preview_nonce"] ?: return
        val ciphertext = data["preview_ciphertext"] ?: return
        if (pairId != credentials.pairId) return

        val preview = runCatching {
            Crypto.decrypt(
                credentials,
                messageId,
                "preview",
                EncryptedEnvelope(nonce, ciphertext),
            )
        }.getOrNull() ?: return
        MessageStore(this).put(preview)
        NotificationTools.show(this, preview)
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
