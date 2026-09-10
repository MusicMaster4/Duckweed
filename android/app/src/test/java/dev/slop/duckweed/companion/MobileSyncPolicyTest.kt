package dev.slop.duckweed.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertEquals
import org.junit.Test

class MobileSyncPolicyTest {
    @Test
    fun delayedPreviewForReadCompletionDoesNotAlertEvenWithALaterSendTime() {
        assertTrue(MobileSyncPolicy.isCompletionAlreadyRead(7, 7, 90_000, 50_000))
        assertTrue(MobileSyncPolicy.isCompletionAlreadyRead(6, 7, 90_000, 50_000))
        assertFalse(MobileSyncPolicy.isNotificationPending(null, 50_000))
        assertFalse(MobileSyncPolicy.isNotificationPending(50_000, null))
        assertTrue(MobileSyncPolicy.isNotificationPending(null, null))
    }

    @Test
    fun newerCompletionsRemainUnreadEvenWhenThePhoneClockIsAhead() {
        assertFalse(MobileSyncPolicy.isCompletionAlreadyRead(8, 7, 40_000, 50_000))
        assertTrue(MobileSyncPolicy.isSyncedMessageUnread(true, true, 40_000, 50_000, 8, 7))
        assertFalse(MobileSyncPolicy.isSyncedMessageUnread(true, true, 90_000, 50_000, 7, 7))
        assertTrue(MobileSyncPolicy.isCompletionAlreadyRead(null, null, 40_000, 50_000))
        assertFalse(MobileSyncPolicy.isCompletionAlreadyRead(null, null, 60_000, 50_000))
    }

    @Test
    fun lateNetworkCallbacksCannotUndoDesktopConfirmation() {
        assertEquals("delivered", MobileSyncPolicy.nextDeliveryState("delivered", "received"))
        assertEquals("delivered", MobileSyncPolicy.nextDeliveryState("delivered", "failed"))
        assertEquals("received", MobileSyncPolicy.nextDeliveryState("received", "sent"))
        assertEquals("sending", MobileSyncPolicy.nextDeliveryState("failed", "sending"))
        assertEquals("failed", MobileSyncPolicy.nextDeliveryState("sending", "failed"))
    }

    @Test
    fun desktopReadAlwaysClearsTheMobileUnreadState() {
        assertFalse(
            MobileSyncPolicy.isSyncedMessageUnread(
                unreadOnDesktop = false,
                latestAssistantMessage = true,
                sentAt = 2_000L,
                mobileReadAt = 0L,
            ),
        )
    }

    @Test
    fun mobileReadDoesNotChangeTheDesktopStateOrReappearLocally() {
        assertFalse(
            MobileSyncPolicy.isSyncedMessageUnread(
                unreadOnDesktop = true,
                latestAssistantMessage = true,
                sentAt = 2_000L,
                mobileReadAt = 2_500L,
            ),
        )
        assertTrue(
            MobileSyncPolicy.isSyncedMessageUnread(
                unreadOnDesktop = true,
                latestAssistantMessage = true,
                sentAt = 3_000L,
                mobileReadAt = 2_500L,
            ),
        )
    }

    @Test
    fun onlyFreshSnapshotsAreOnline() {
        assertTrue(MobileSyncPolicy.isDesktopOnline(100_000L, 160_000L, 75_000L))
        assertFalse(MobileSyncPolicy.isDesktopOnline(100_000L, 180_000L, 75_000L))
        assertFalse(MobileSyncPolicy.isDesktopOnline(null, 180_000L, 75_000L))
    }
}
