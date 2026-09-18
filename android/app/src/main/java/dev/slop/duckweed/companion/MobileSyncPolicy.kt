package dev.slop.duckweed.companion

/** Pure cross-device rules shared by storage and UI code. */
object MobileSyncPolicy {
    fun nextDeliveryState(current: String?, incoming: String): String {
        val progress = listOf("sending", "sent", "received", "delivered")
        if (current == "delivered" || (current == "received" && incoming == "failed")) return current
        return if (incoming in progress && current in progress &&
            progress.indexOf(current) > progress.indexOf(incoming)) current!! else incoming
    }

    fun isCompletionAlreadyRead(
        completionSeq: Long?,
        readCompletionSeq: Long?,
        sentAt: Long,
        readAt: Long,
    ): Boolean = if (completionSeq != null && readCompletionSeq != null) {
        completionSeq <= readCompletionSeq
    } else {
        sentAt <= readAt
    }

    fun isNotificationPending(notifiedAt: Long?, readAt: Long?): Boolean =
        notifiedAt == null && readAt == null

    fun isDesktopOnline(updatedAt: Long?, now: Long, freshnessMs: Long): Boolean =
        updatedAt != null && now >= updatedAt && now - updatedAt <= freshnessMs

    fun isSyncedMessageUnread(
        unreadOnDesktop: Boolean?,
        latestAssistantMessage: Boolean,
        sentAt: Long,
        mobileReadAt: Long,
        completionSeq: Long? = null,
        readCompletionSeq: Long? = null,
    ): Boolean = unreadOnDesktop == true && latestAssistantMessage &&
        !isCompletionAlreadyRead(completionSeq, readCompletionSeq, sentAt, mobileReadAt)
}
