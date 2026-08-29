package dev.slop.duckweed.companion

import kotlin.math.abs

object ConversationMergePolicy {
    // A remote command can wait for the desktop poll before it becomes a
    // workspace message. Both rows describe the same send even though their
    // clocks differ by a few seconds.
    private const val OUTGOING_CONFIRMATION_WINDOW_MS = 10_000L

    // Assistant rows are stamped when streaming starts. The completion push is
    // stamped after the turn settles, plus the desktop grace period (up to 60s).
    private const val COMPLETION_CONFIRMATION_WINDOW_MS = 90_000L

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
                    val previous = merged[duplicate]
                    merged[duplicate] = candidate.copy(
                        sentAt = minOf(previous.sentAt, candidate.sentAt),
                        deliveryState = if (candidate.kind == "user") {
                            "delivered"
                        } else {
                            candidate.deliveryState
                        },
                        deliveryError = null,
                        streaming = false,
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
            !kindsCompatible(first.kind, second.kind) ||
            !sameResponse(first.response, second.response)
        ) return false

        val delta = abs(first.sentAt - second.sentAt)
        if (delta == 0L) return true
        val phoneRecord = if (firstIsWorkspace) second else first
        return when (phoneRecord.kind) {
            "user" ->
                phoneRecord.deliveryState != null &&
                    delta <= OUTGOING_CONFIRMATION_WINDOW_MS
            "completed", "attention" ->
                delta <= COMPLETION_CONFIRMATION_WINDOW_MS
            else -> false
        }
    }

    private fun kindsCompatible(first: String, second: String): Boolean =
        first == second ||
            ((first == "completed" || first == "attention") &&
                (second == "completed" || second == "attention"))

    private fun sameResponse(first: String?, second: String?): Boolean {
        if (first == second) return true
        if (first.isNullOrEmpty() || second.isNullOrEmpty()) return false
        return truncatedCopy(first, second) || truncatedCopy(second, first)
    }

    private fun truncatedCopy(short: String, long: String): Boolean {
        if (short.length >= long.length) return false
        if (!short.endsWith("…") && !short.endsWith("...")) return false
        val stem = short.removeSuffix("…").removeSuffix("...")
        return stem.isNotEmpty() && long.startsWith(stem)
    }
}
