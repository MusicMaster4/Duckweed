package dev.slop.duckweed.companion

data class CompletionNotificationCopy(
    val title: String,
    val text: String,
    val expandedText: String,
    val context: String,
)

/** Builds concise notification copy while keeping the app and project explicit. */
object CompletionNotificationCopyBuilder {
    fun build(message: CompletionRecord): CompletionNotificationCopy {
        val agent = message.agent.trim().ifEmpty { "Agent" }
        val project = message.project.trim().ifEmpty { "Unknown project" }
        val needsAttention = message.kind == "attention"
        val title = if (needsAttention) {
            "$agent needs attention in $project"
        } else {
            "$agent finished in $project"
        }
        val context = "Duckweed • Project: $project"
        val response = message.response
            ?.trim()
            ?.takeIf(String::isNotEmpty)
        val fallback = if (needsAttention) {
            "Open Duckweed to review and continue."
        } else {
            "Open Duckweed to review the result."
        }
        val summary = response?.replace(Regex("\\s+"), " ") ?: fallback
        val timing = if (needsAttention) null else formatDuration(message.durationMs)
        val text = listOfNotNull(timing, summary).joinToString(" • ")
        val details = buildList {
            add("Project: $project")
            timing?.let(::add)
            add("")
            add(response ?: fallback)
        }.joinToString("\n")

        return CompletionNotificationCopy(title, text, details, context)
    }

    private fun formatDuration(durationMs: Long?): String? {
        if (durationMs == null || durationMs < 0) return null
        val totalSeconds = (durationMs / 1_000).coerceAtLeast(1)
        val minutes = totalSeconds / 60
        val seconds = totalSeconds % 60
        val duration = when {
            minutes == 0L -> "${seconds}s"
            seconds == 0L -> "${minutes}m"
            else -> "${minutes}m ${seconds}s"
        }
        return "Completed in $duration"
    }
}
