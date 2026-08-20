package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ConversationMergePolicyTest {
    @Test
    fun syncedOutgoingMessageClearsItsPendingPresentation() {
        val phone = message(
            id = "command-1",
            sentAt = 1_000L,
            text = "Run tests",
            deliveryState = "received",
            kind = "user",
        )
        val desktop = message(
            id = "workspace:pair-1:terminal-1:user-1",
            sentAt = 1_400L,
            text = "Run tests",
            deliveryState = null,
            kind = "user",
        )

        val merged = ConversationMergePolicy.merge(listOf(desktop), listOf(phone))

        assertEquals(1, merged.size)
        assertEquals("command-1", merged.single().id)
        assertEquals("delivered", merged.single().deliveryState)
    }

    @Test
    fun outgoingImageMessageMergesWithDelayedWorkspaceConfirmation() {
        val image = MobileImageAttachment("image-1", "photo.jpg", "image/jpeg", null, 42)
        val workspace = message("workspace:pair:term:turn-1", 14_000L, "Check this", null)
        val outgoing = message("command-1", 10_000L, "Check this", "delivered", listOf(image))

        val merged = ConversationMergePolicy.merge(listOf(workspace), listOf(outgoing))

        assertEquals(1, merged.size)
        assertEquals("command-1", merged.single().id)
        assertEquals(listOf(image), merged.single().attachments)
        assertEquals("delivered", merged.single().deliveryState)
    }

    @Test
    fun repeatedMessagesAreMatchedOneToOneByNearestTimestamp() {
        val synced = listOf(
            message("workspace:pair:term:turn-1", 12_000L, "Continue", null),
            message("workspace:pair:term:turn-2", 18_000L, "Continue", null),
        )
        val stored = listOf(
            message("command-1", 10_000L, "Continue", "delivered"),
            message("command-2", 17_000L, "Continue", "delivered"),
        )

        val merged = ConversationMergePolicy.merge(synced, stored)

        assertEquals(listOf("command-1", "command-2"), merged.map { it.id })
    }

    @Test
    fun unrelatedOlderMessageIsNotCollapsed() {
        val workspace = message("workspace:pair:term:turn-1", 25_000L, "Same text", null)
        val outgoing = message("command-1", 10_000L, "Same text", "delivered")

        val merged = ConversationMergePolicy.merge(listOf(workspace), listOf(outgoing))

        assertEquals(2, merged.size)
    }

    @Test
    fun exactTimestampStillMergesNonOutgoingTransportCopies() {
        val workspace = message("workspace:pair:term:turn-1", 10_000L, "Done", null, kind = "completed")
        val notification = message("notification-1", 10_000L, "Done", null, kind = "completed")

        val merged = ConversationMergePolicy.merge(listOf(workspace), listOf(notification))

        assertEquals(1, merged.size)
        assertEquals("notification-1", merged.single().id)
        assertNull(merged.single().deliveryState)
    }

    private fun message(
        id: String,
        sentAt: Long,
        text: String,
        deliveryState: String?,
        attachments: List<MobileImageAttachment> = emptyList(),
        kind: String = "user",
    ) = CompletionRecord(
        id = id,
        sentAt = sentAt,
        agent = if (kind == "user") "You" else "Codex",
        project = "Duckweed",
        kind = kind,
        response = text,
        durationMs = null,
        pairId = "pair",
        projectId = "project",
        terminalId = "term",
        attachments = attachments,
        deliveryState = deliveryState,
    )
}
