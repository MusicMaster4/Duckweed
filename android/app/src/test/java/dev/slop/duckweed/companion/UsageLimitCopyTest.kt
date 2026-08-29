package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UsageLimitCopyTest {
    private val now = 1_800_000_000_000L
    private val hour = 3_600_000L

    @Test
    fun remainingInvertsUtilizationLikeTheDesktopMeter() {
        assertEquals("98%", UsageLimitCopy.remainingLabel(2.0))
        assertEquals("23%", UsageLimitCopy.remainingLabel(77.0))
        assertEquals("0%", UsageLimitCopy.remainingLabel(100.0))
        assertEquals("0%", UsageLimitCopy.remainingLabel(120.0))
        assertEquals("53%", UsageLimitCopy.remainingLabel(47.4))
    }

    @Test
    fun meterTurnsYellowThenRedAsRemainingDrains() {
        assertEquals(UsageLimitCopy.MeterLevel.Ok, UsageLimitCopy.meterLevel(16.0))
        assertEquals(UsageLimitCopy.MeterLevel.Warning, UsageLimitCopy.meterLevel(75.0))
        assertEquals(UsageLimitCopy.MeterLevel.Critical, UsageLimitCopy.meterLevel(92.0))
    }

    @Test
    fun resetHintMatchesDesktopCountdownCopy() {
        assertEquals("resets in 30m", UsageLimitCopy.resetHint(now + 30 * 60_000, now))
        assertEquals("resets in 3h 20m", UsageLimitCopy.resetHint(now + 200 * 60_000, now))
        assertEquals("resets in 2d", UsageLimitCopy.resetHint(now + 50 * hour, now))
        assertEquals("resetting", UsageLimitCopy.resetHint(now - 1, now))
        assertNull(UsageLimitCopy.resetHint(null, now))
    }

    @Test
    fun burnRatesKeepADecimalOnlyWhileTheyAreSmall() {
        assertEquals("21%/h", UsageLimitCopy.formatPace(21.4))
        assertEquals("2.5%/h", UsageLimitCopy.formatPace(2.5))
        assertEquals("3%/h", UsageLimitCopy.formatPace(3.04))
        assertEquals("0.4%/h", UsageLimitCopy.formatPace(0.4))
    }

    @Test
    fun aSpentWindowDoesNotRepeatItsResetTime() {
        val copy = UsageLimitCopy.describeForecast(
            limit(100.0, 2.0, basis = "exhausted", projectedPercent = 100.0, runsOutAt = now),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Critical, copy.tone)
        assertEquals("No quota left", copy.text)
        assertNull(copy.detail)
    }

    @Test
    fun aLimitThatEmptiesBeforeResetReportsOneFixedDuration() {
        val copy = UsageLimitCopy.describeForecast(
            limit(
                percent = 60.0,
                resetsInHours = 3.0,
                perHour = 20.0,
                basis = "recent",
                runsOutAt = now + 2 * hour,
                projectedPercent = 120.0,
            ),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Warning, copy.tone)
        assertEquals("2h left", copy.text)
        assertEquals("20%/h", copy.detail)
    }

    @Test
    fun underAnHourOfAllowanceLeftIsCritical() {
        val copy = UsageLimitCopy.describeForecast(
            limit(
                percent = 90.0,
                resetsInHours = 4.0,
                perHour = 20.0,
                basis = "recent",
                runsOutAt = now + 30 * 60_000,
                projectedPercent = 170.0,
            ),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Critical, copy.tone)
    }

    @Test
    fun aWindowThatRefillsFirstShowsWhereItLands() {
        val copy = UsageLimitCopy.describeForecast(
            limit(
                percent = 50.0,
                resetsInHours = 1.0,
                perHour = 10.0,
                basis = "recent",
                runsOutAt = now + 5 * hour,
                projectedPercent = 60.0,
            ),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Ok, copy.tone)
        assertEquals("40% by reset", copy.text)
        assertEquals("10%/h", copy.detail)
    }

    @Test
    fun aProjectionLandingNearTheCapIsFlaggedEvenThoughItHolds() {
        val copy = UsageLimitCopy.describeForecast(
            limit(
                percent = 80.0,
                resetsInHours = 1.0,
                perHour = 15.0,
                basis = "recent",
                runsOutAt = now + 80 * 60_000,
                projectedPercent = 95.0,
            ),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Warning, copy.tone)
        assertEquals("5% by reset", copy.text)
    }

    @Test
    fun aLongWindowUsesHoursOfUseWhenTheLimitBindsFirst() {
        val copy = UsageLimitCopy.describeForecast(
            limit(
                percent = 60.0,
                resetsInHours = 96.0,
                perHour = 10.0,
                basis = "recent",
                usageHoursLeft = 4.0,
                runsOutAt = now + 16 * hour,
                projectedPercent = 100.0,
            ),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Warning, copy.tone)
        assertEquals("4h left", copy.text)
        assertEquals("10%/h", copy.detail)
    }

    @Test
    fun aLongWindowThatOutlastsItsResetShowsTheBudget() {
        val copy = UsageLimitCopy.describeForecast(
            limit(
                percent = 30.0,
                resetsInHours = 48.0,
                perHour = 2.0,
                basis = "recent",
                usageHoursLeft = 35.0,
                runsOutAt = now + 140 * hour,
                projectedPercent = 55.0,
            ),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Ok, copy.tone)
        assertEquals("45% by reset", copy.text)
        assertEquals("2%/h", copy.detail)
    }

    @Test
    fun hoursOfUseLeftIsCriticalOnceItIsDownToAnAfternoon() {
        val copy = UsageLimitCopy.describeForecast(
            limit(
                percent = 95.0,
                resetsInHours = 72.0,
                perHour = 4.0,
                basis = "recent",
                usageHoursLeft = 1.25,
                runsOutAt = now + 5 * hour,
                projectedPercent = 100.0,
            ),
            now,
        )
        assertEquals(UsageLimitCopy.Tone.Critical, copy.tone)
        assertEquals("1h 15m left", copy.text)
    }

    @Test
    fun nothingToProjectFromFallsBackToPlainFacts() {
        val unused = UsageLimitCopy.describeForecast(limit(0.0, 3.0), now)
        assertEquals("Unused", unused.text)
        assertNull(unused.detail)

        val young = UsageLimitCopy.describeForecast(limit(8.0, 4.9), now)
        assertEquals(UsageLimitCopy.Tone.Muted, young.tone)
        assertEquals("92% left", young.text)
        assertNull(young.detail)
    }

    private fun limit(
        percent: Double,
        resetsInHours: Double?,
        perHour: Double? = null,
        basis: String? = null,
        usageHoursLeft: Double? = null,
        runsOutAt: Long? = null,
        projectedPercent: Double? = null,
    ) = RemoteUsageLimit(
        id = "five-hour",
        label = "5-hour limit",
        percent = percent,
        resetsAt = resetsInHours?.let { now + (it * hour).toLong() },
        usageHoursLeft = usageHoursLeft,
        perHour = perHour,
        projectedPercent = projectedPercent,
        runsOutAt = runsOutAt,
        basis = basis,
    )
}
