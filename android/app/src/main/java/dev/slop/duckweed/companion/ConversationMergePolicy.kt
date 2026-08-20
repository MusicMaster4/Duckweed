package dev.slop.duckweed.companion

import kotlin.math.abs

object ConversationMergePolicy {
    // A remote command can wait for the desktop poll before it becomes a
    // workspace message. Both rows describe the same send even though their
    // clocks differ by a few seconds.
    private const val OUTGOING_CONFIRMATION_WINDOW_MS = 10_000L

    fun merge(
        synced: List<CompletionRecord>,
        stored: List<CompletionRecord>,
    ): List<CompletionRecord> {
        val storedById = stored.associateBy { it.id }
        val merged = synced.map { storedById[it.id] ?: it }.toMutableList()
        val syncedIds = synced.mapTo(mutableSetOf()) { it.id }

        stored.asSequence()
            .filter { it.id !in syncedIds }
            .forEach { candidate ->
                val duplicate = merged.indices
                    .filter { index -> isCrossSourceDuplicate(merged[index], candidate) }
                    .minByOrNull { index -> abs(merged[index].sentAt - candidate.sentAt) }
                if (duplicate == null) {
                    merged += candidate
                } else if (merged[duplicate].id.startsWith("workspace:")) {
                    // Keep the phone record because it owns delivery state and
                    // attachment metadata that is not part of the snapshot.
                    merged[duplicate] = candidate.copy(
                        deliveryState = if (candidate.kind == "user") {
                            "delivered"
                        } else {
                            candidate.deliveryState
                        },
                        deliveryError = null,
                    )
                }
            }
        return merged.sortedBy { it.sentAt }
    }

    private fun isCrossSourceDuplicate(
        first: CompletionRecord,
        second: CompletionRecord,
    ): Boolean {
        val firstIsWorkspace = first.id.startsWith("workspace:")
        val secondIsWorkspace = second.id.startsWith("workspace:")
        if (
            firstIsWorkspace == secondIsWorkspace ||
            first.pairId != second.pairId ||
            first.projectId != second.projectId ||
            first.terminalId != second.terminalId ||
            first.kind != second.kind ||
            first.response != second.response
        ) return false

        if (first.sentAt == second.sentAt) return true
        val phoneRecord = if (firstIsWorkspace) second else first
        return phoneRecord.kind == "user" &&
            phoneRecord.deliveryState != null &&
            abs(first.sentAt - second.sentAt) <= OUTGOING_CONFIRMATION_WINDOW_MS
    }
}
