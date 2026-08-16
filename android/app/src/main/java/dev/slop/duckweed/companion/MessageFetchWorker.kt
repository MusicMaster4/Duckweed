package dev.slop.duckweed.companion

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class MessageFetchWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val pairId = inputData.getString(PAIR_ID) ?: return Result.failure()
        val messageId = inputData.getString(MESSAGE_ID) ?: return Result.failure()
        val credentials = SecretStore.load(applicationContext, pairId) ?: return Result.failure()
        return try {
            val envelope = RelayClient.fetch(credentials, messageId)
            val message = Crypto.decrypt(credentials, messageId, "payload", envelope)
            if (message.workspace != null) {
                WorkspaceStore(applicationContext).put(message.workspace)
            } else {
                MessageStore(applicationContext).put(message)
            }
            RelayClient.acknowledge(credentials, messageId)
            NotificationTools.announceChanged(applicationContext)
            Result.success()
        } catch (_: Exception) {
            if (runAttemptCount < 6) Result.retry() else Result.failure()
        }
    }

    companion object {
        const val PAIR_ID = "pair_id"
        const val MESSAGE_ID = "message_id"
    }
}
