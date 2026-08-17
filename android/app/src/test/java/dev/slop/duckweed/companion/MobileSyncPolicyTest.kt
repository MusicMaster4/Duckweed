package dev.slop.duckweed.companion

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileSyncPolicyTest {
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
