package dev.slop.duckweed.companion

import android.content.Context
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager

class MessageFetchWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val pairId = inputData.getString(PAIR_ID) ?: return Result.failure()
        val messageId = inputData.getString(MESSAGE_ID) ?: return Result.failure()
        val credentials = SecretStore.load(applicationContext, pairId) ?: return Result.failure()
        return try {
            val envelope = RelayClient.fetch(credentials, messageId)
            val message = Crypto.decrypt(credentials, messageId, "payload", envelope)
            val receivedAt = System.currentTimeMillis()
            val workspaceStore = WorkspaceStore(applicationContext)
            if (message.kind == "presence") {
                workspaceStore.markPresence(pairId, receivedAt)
            } else if (message.workspace != null) {
                if (workspaceStore.put(message.workspace, receivedAt)) {
                    val cleared = MessageStore(applicationContext)
                        .putSyncedConversation(message.workspace)
                    NotificationTools.cancelIds(applicationContext, cleared)
                    NotificationTools.refreshApprovalActions(applicationContext)
                }
            } else {
                // Tests, completions, and attention messages are authenticated
                // desktop traffic too, so they also renew the connection.
                workspaceStore.markPresence(pairId, receivedAt)
                val store = MessageStore(applicationContext)
                store.put(message)
                val consumed = MobileNotificationVisibility.consumeIfVisible(
                    applicationContext,
                    store,
                    message,
                )
                val unread = store.message(message.id)?.readAt == null
                if (consumed || !unread) {
                    NotificationTools.cancelIds(applicationContext, listOf(message.id))
                } else if (
                    message.kind == "attention" &&
                    NotificationPreference.isEnabled(applicationContext)
                ) {
                    NotificationTools.show(applicationContext, message)
                }
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

object MessageFetchScheduler {
    fun enqueue(context: Context, pairId: String, messageId: String) {
        val input = Data.Builder()
            .putString(MessageFetchWorker.PAIR_ID, pairId)
            .putString(MessageFetchWorker.MESSAGE_ID, messageId)
            .build()
        val work = OneTimeWorkRequestBuilder<MessageFetchWorker>()
            .setInputData(input)
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            "duckweed-message-$pairId-$messageId",
            ExistingWorkPolicy.KEEP,
            work,
        )
    }
}
