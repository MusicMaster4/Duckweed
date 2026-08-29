package dev.slop.duckweed.companion

sealed class ConversationTimelineItem {
    abstract val id: String
    abstract val at: Long

    data class Message(val record: CompletionRecord) : ConversationTimelineItem() {
        override val id: String = "message:${record.id}"
        override val at: Long = record.sentAt
    }

    data class Activity(val record: RemoteAgentActivity) : ConversationTimelineItem() {
        override val id: String = "activity:${record.id}"
        override val at: Long = record.at
    }
}

object ConversationTimelinePolicy {
    fun build(
        messages: List<CompletionRecord>,
        activity: List<RemoteAgentActivity>,
        agentWorking: Boolean,
        thinkingId: String,
    ): List<ConversationTimelineItem> {
        val hasLiveActivity = activity.any { it.status == "running" || it.status == "pending" }
        val activityRows = activity
            .filterNot { it.kind == "plan" }
            .distinctBy { it.id }
            .toMutableList()
        if (agentWorking && !hasLiveActivity) {
            val newestAt = maxOf(
                messages.maxOfOrNull { it.sentAt } ?: 0L,
                activityRows.maxOfOrNull { it.at } ?: 0L,
            )
            activityRows += RemoteAgentActivity(
                id = "mobile-thinking:$thinkingId",
                at = newestAt + 1L,
                kind = "thinking",
                title = "Thinking",
                detail = null,
                status = "running",
            )
        }

        return buildList {
            messages.forEach { add(ConversationTimelineItem.Message(it)) }
            activityRows.forEach { add(ConversationTimelineItem.Activity(it)) }
        }.sortedWith(
            compareBy<ConversationTimelineItem> { it.at }
                .thenBy { rowOrder(it) }
                .thenBy { it.id },
        )
    }

    private fun rowOrder(item: ConversationTimelineItem): Int = when (item) {
        is ConversationTimelineItem.Message -> if (item.record.kind == "user") 0 else 2
        is ConversationTimelineItem.Activity -> 1
    }
}
