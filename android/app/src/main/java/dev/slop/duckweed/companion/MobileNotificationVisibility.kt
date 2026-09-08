package dev.slop.duckweed.companion

import android.app.KeyguardManager
import android.content.Context
import android.os.PowerManager

data class MobileNotificationUiState(
    val appVisible: Boolean = false,
    val pairId: String? = null,
    val terminalId: String? = null,
)

fun shouldSuppressVisibleConversationNotification(
    state: MobileNotificationUiState,
    message: CompletionRecord,
    deviceInteractive: Boolean = true,
    keyguardLocked: Boolean = false,
): Boolean =
    state.appVisible && deviceInteractive && !keyguardLocked &&
        (message.kind == "completed" || message.kind == "attention") &&
        message.pairId != null &&
        message.terminalId != null &&
        state.pairId == message.pairId &&
        state.terminalId == message.terminalId

/**
 * Process-local view of the conversation the user can currently see.
 * FirebaseMessagingService runs in the same application process, so it can
 * avoid alerting for the exact response already visible in MainActivity.
 */
object MobileNotificationVisibility {
    @Volatile
    private var state = MobileNotificationUiState()

    @Synchronized
    fun activityStarted() {
        state = state.copy(appVisible = true)
    }

    @Synchronized
    fun activityStopped() {
        state = MobileNotificationUiState()
    }

    @Synchronized
    fun showConversation(pairId: String?, terminalId: String?) {
        state = state.copy(pairId = pairId, terminalId = terminalId)
    }

    @Synchronized
    fun hideConversation() {
        state = state.copy(pairId = null, terminalId = null)
    }

    fun isViewing(context: Context, message: CompletionRecord): Boolean =
        shouldSuppressVisibleConversationNotification(
            state,
            message,
            deviceInteractive = context.getSystemService(PowerManager::class.java)?.isInteractive == true,
            keyguardLocked = context.getSystemService(KeyguardManager::class.java)?.isKeyguardLocked != false,
        )

    /**
     * Store the response normally, but consume its alert as a synchronized
     * read when the matching conversation is already visible.
     */
    fun consumeIfVisible(
        context: Context,
        store: MessageStore,
        message: CompletionRecord,
    ): Boolean {
        // Activity lifecycle callbacks can lag behind the screen locking.
        // Never consume an unseen response or send its read receipt in that gap.
        if (!isViewing(context, message)) return false
        val pairId = message.pairId ?: return false
        val terminalId = message.terminalId ?: return false
        val wasUnread = store.message(message.id)?.readAt == null
        val cleared = if (wasUnread) {
            store.markConversationRead(
                pairId,
                terminalId,
                message.completionSeq,
                at = maxOf(System.currentTimeMillis(), message.sentAt),
            )
        } else {
            emptyList()
        }
        store.markNotified(message.id)
        NotificationTools.cancelIds(context, (cleared + message.id).distinct())
        if (wasUnread) ReadSyncScheduler.enqueue(context)
        return true
    }
}
