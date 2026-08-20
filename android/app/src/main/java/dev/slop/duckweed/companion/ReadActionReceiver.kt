package dev.slop.duckweed.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast

class ReadActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_MARK_READ) return
        val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID) ?: return
        val pendingResult = goAsync()
        Thread({
            val result = runCatching {
                val store = MessageStore(context)
                val message = store.response(messageId) ?: error("This response is no longer available.")
                val pairId = message.pairId ?: error("This response is not linked to a desktop.")
                val terminalId = message.terminalId ?: error("This response is not linked to a terminal.")
                val cleared = store.markConversationRead(
                    pairId,
                    terminalId,
                    message.completionSeq,
                    at = message.sentAt,
                )
                NotificationTools.cancelIds(context, cleared.ifEmpty { listOf(messageId) })
                if (cleared.isNotEmpty()) ReadSyncScheduler.enqueue(context)
                NotificationTools.announceChanged(context)
            }
            Handler(Looper.getMainLooper()).post {
                result.onSuccess {
                    Toast.makeText(context, "Marked as read", Toast.LENGTH_SHORT).show()
                }.onFailure { error ->
                    Toast.makeText(
                        context,
                        error.message ?: "Could not mark this response as read.",
                        Toast.LENGTH_LONG,
                    ).show()
                }
                pendingResult.finish()
            }
        }, "duckweed-read-action").start()
    }

    companion object {
        const val ACTION_MARK_READ = "dev.slop.duckweed.companion.MARK_READ"
        const val EXTRA_MESSAGE_ID = "message_id"
    }
}
