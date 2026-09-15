package dev.slop.duckweed.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileNotificationVisibilityTest {
    @Test
    fun `locked or sleeping phone never consumes visible conversation alerts`() {
        val state = MobileNotificationUiState(true, "desktop-1", "terminal-1")
        for (kind in listOf("completed", "attention")) {
            val message = completion(kind = kind)
            assertFalse(shouldSuppressVisibleConversationNotification(
                state, message, deviceInteractive = false, keyguardLocked = false,
            ))
            assertFalse(shouldSuppressVisibleConversationNotification(
                state, message, deviceInteractive = true, keyguardLocked = true,
            ))
            assertFalse(shouldSuppressVisibleConversationNotification(
                state, message, deviceInteractive = false, keyguardLocked = true,
            ))
            assertTrue(shouldSuppressVisibleConversationNotification(
                state, message, deviceInteractive = true, keyguardLocked = false,
            ))
        }
    }

    private fun completion(
        pairId: String? = "desktop-1",
        terminalId: String? = "terminal-1",
        kind: String = "completed",
    ) = CompletionRecord(
        id = "completion-1",
        sentAt = 1_000L,
        agent = "Codex",
        project = "Duckweed",
        kind = kind,
        response = "Done",
        durationMs = 500L,
        pairId = pairId,
        terminalId = terminalId,
    )

    @Test
    fun `suppresses completion for conversation visible in the app`() {
        val state = MobileNotificationUiState(
            appVisible = true,
            pairId = "desktop-1",
            terminalId = "terminal-1",
        )

        assertTrue(shouldSuppressVisibleConversationNotification(state, completion()))
        assertTrue(
            shouldSuppressVisibleConversationNotification(
                state,
                completion(kind = "attention"),
            ),
        )
    }

    @Test
    fun `keeps notifications for background app and other conversations`() {
        val visible = MobileNotificationUiState(
            appVisible = true,
            pairId = "desktop-1",
            terminalId = "terminal-1",
        )

        assertFalse(
            shouldSuppressVisibleConversationNotification(
                visible.copy(appVisible = false),
                completion(),
            ),
        )
        assertFalse(
            shouldSuppressVisibleConversationNotification(
                visible,
                completion(terminalId = "terminal-2"),
            ),
        )
        assertFalse(
            shouldSuppressVisibleConversationNotification(
                visible,
                completion(pairId = "desktop-2"),
            ),
        )
    }

    @Test
    fun `does not suppress unrouted or non completion messages`() {
        val state = MobileNotificationUiState(
            appVisible = true,
            pairId = "desktop-1",
            terminalId = "terminal-1",
        )

        assertFalse(
            shouldSuppressVisibleConversationNotification(
                state,
                completion(terminalId = null),
            ),
        )
        assertFalse(
            shouldSuppressVisibleConversationNotification(
                state,
                completion(kind = "test"),
            ),
        )
    }
}
