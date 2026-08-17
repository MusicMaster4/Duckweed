package dev.slop.duckweed.companion

/** Pure cross-device rules shared by storage and UI code. */
object MobileSyncPolicy {
    fun isDesktopOnline(updatedAt: Long?, now: Long, freshnessMs: Long): Boolean =
        updatedAt != null && now >= updatedAt && now - updatedAt <= freshnessMs

    fun isSyncedMessageUnread(
        unreadOnDesktop: Boolean?,
        latestAssistantMessage: Boolean,
        sentAt: Long,
        mobileReadAt: Long,
    ): Boolean = unreadOnDesktop == true && latestAssistantMessage && sentAt > mobileReadAt
}
