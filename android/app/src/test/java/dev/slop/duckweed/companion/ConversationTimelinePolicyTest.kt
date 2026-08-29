package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationTimelinePolicyTest {
    @Test
    fun `interleaves messages and agent work in timestamp order`() {
        val rows = ConversationTimelinePolicy.build(
            messages = listOf(
                message("user", 10, "user"),
                message("answer", 40, "completed"),
            ),
            activity = listOf(
                RemoteAgentActivity("thinking", 20, "thinking", "Reasoning", "Inspecting", status = "done"),
                RemoteAgentActivity("tool", 30, "tool", "Read files", null, status = "done"),
            ),
            agentWorking = false,
            thinkingId = "terminal",
        )

        assertEquals(
            listOf("message:user", "activity:thinking", "activity:tool", "message:answer"),
            rows.map { it.id },
        )
    }

    @Test
    fun `adds a stable thinking row when no live activity has arrived yet`() {
        val rows = ConversationTimelinePolicy.build(
            messages = listOf(message("user", 10, "user")),
            activity = emptyList(),
            agentWorking = true,
            thinkingId = "terminal",
        )

        val thinking = rows.last() as ConversationTimelineItem.Activity
        assertEquals("activity:mobile-thinking:terminal", thinking.id)
        assertEquals("running", thinking.record.status)
    }

    @Test
    fun `does not duplicate an existing live row`() {
        val rows = ConversationTimelinePolicy.build(
            messages = emptyList(),
            activity = listOf(
                RemoteAgentActivity("tool", 20, "tool", "Run tests", null, status = "running"),
            ),
            agentWorking = true,
            thinkingId = "terminal",
        )

        assertEquals(1, rows.size)
        assertTrue(rows.single() is ConversationTimelineItem.Activity)
    }

    @Test
    fun `keeps a plan out of the timeline because it has a docked tracker`() {
        val rows = ConversationTimelinePolicy.build(
            messages = listOf(message("user", 10, "user")),
            activity = listOf(
                RemoteAgentActivity(
                    id = "plan",
                    at = 20,
                    kind = "plan",
                    title = "Implement mobile UI",
                    detail = null,
                    status = "running",
                    steps = listOf(RemotePlanStep("Implement mobile UI", "running")),
                ),
            ),
            agentWorking = true,
            thinkingId = "terminal",
        )

        assertEquals(listOf("message:user"), rows.map { it.id })
    }

    private fun message(id: String, at: Long, kind: String) = CompletionRecord(
        id = id,
        sentAt = at,
        agent = "Codex",
        project = "Project",
        kind = kind,
        response = id,
        durationMs = null,
    )
}
