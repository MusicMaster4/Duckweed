package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UsageLimitCopyTest {
    @Test
    fun formatsProviderPercentAndResetCountdown() {
        val now = 1_800_000_000_000L
        assertEquals("48% used", UsageLimitCopy.percentUsed(47.6))
        assertEquals("100% used", UsageLimitCopy.percentUsed(120.0))
        assertEquals("Resets in 3h 20m", UsageLimitCopy.resetTime(now + 200 * 60_000, now))
        assertEquals("Resets in 2d", UsageLimitCopy.resetTime(now + 50 * 60 * 60_000, now))
        assertEquals("Resetting now", UsageLimitCopy.resetTime(now - 1, now))
        assertNull(UsageLimitCopy.resetTime(null, now))
    }

    @Test
    fun formatsEstimatedActiveUseSeparatelyFromTheResetClock() {
        assertEquals("About 2h 15m of use left", UsageLimitCopy.activeTimeLeft(2.25))
        assertEquals("No use left", UsageLimitCopy.activeTimeLeft(0.0))
        assertNull(UsageLimitCopy.activeTimeLeft(null))
    }
}
