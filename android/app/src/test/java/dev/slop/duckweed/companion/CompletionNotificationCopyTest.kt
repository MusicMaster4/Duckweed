package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class CompletionNotificationCopyTest {
    @Test
    fun `completion identifies the agent app project duration and result`() {
        val copy = CompletionNotificationCopyBuilder.build(
            record(
                response = "Notifications are ready.\nYou can test them now.",
                durationMs = 72_000,
            ),
        )

        assertEquals("Codex finished in duckweed", copy.title)
        assertEquals(
            "Completed in 1m 12s • Notifications are ready. You can test them now.",
            copy.text,
        )
        assertEquals("Duckweed • Project: duckweed", copy.context)
        assertEquals(
            "Project: duckweed\nCompleted in 1m 12s\n\nNotifications are ready.\nYou can test them now.",
            copy.expandedText,
        )
    }

    @Test
    fun `attention notification says where the agent is waiting`() {
        val copy = CompletionNotificationCopyBuilder.build(
            record(kind = "attention", response = null, durationMs = 8_000),
        )

        assertEquals("Codex needs attention in duckweed", copy.title)
        assertEquals("Open Duckweed to review and continue.", copy.text)
        assertEquals(
            "Project: duckweed\n\nOpen Duckweed to review and continue.",
            copy.expandedText,
        )
    }

    private fun record(
        kind: String = "completed",
        response: String?,
        durationMs: Long?,
    ) = CompletionRecord(
        id = "message-1",
        sentAt = 1,
        agent = "Codex",
        project = "duckweed",
        kind = kind,
        response = response,
        durationMs = durationMs,
    )
}
