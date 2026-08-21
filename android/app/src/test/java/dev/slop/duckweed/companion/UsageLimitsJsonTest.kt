package dev.slop.duckweed.companion

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class UsageLimitsJsonTest {
    @Test
    fun roundTripsForecastFieldsThePhoneNeedsForDesktopCopy() {
        val original = listOf(
            RemoteUsageQuota(
                agent = "codex",
                label = "Codex",
                plan = "pro",
                limits = listOf(
                    RemoteUsageLimit(
                        id = "weekly",
                        label = "7-day limit",
                        percent = 16.0,
                        resetsAt = 1_800_000_000_000L,
                        usageHoursLeft = 12.5,
                        perHour = 0.3,
                        projectedPercent = 40.0,
                        runsOutAt = 1_803_600_000_000L,
                        basis = "recent",
                    ),
                ),
            ),
        )

        val parsed = UsageLimitsJson.parse(UsageLimitsJson.write(original))
        val limit = parsed.single().limits.single()
        assertEquals("codex", parsed.single().agent)
        assertEquals("pro", parsed.single().plan)
        assertEquals(16.0, limit.percent, 0.001)
        assertEquals(12.5, limit.usageHoursLeft!!, 0.001)
        assertEquals(0.3, limit.perHour!!, 0.001)
        assertEquals(40.0, limit.projectedPercent!!, 0.001)
        assertEquals(1_803_600_000_000L, limit.runsOutAt)
        assertEquals("recent", limit.basis)
    }

    @Test
    fun olderPayloadsWithoutForecastFieldsStillParse() {
        val json = JSONArray().put(
            JSONObject()
                .put("agent", "grok")
                .put("label", "Grok")
                .put("plan", JSONObject.NULL)
                .put(
                    "limits",
                    JSONArray().put(
                        JSONObject()
                            .put("id", "weekly")
                            .put("label", "Weekly credit limit")
                            .put("percent", 24.0)
                            .put("resetsAt", 1_800_000_000_000L),
                    ),
                ),
        )

        val limit = UsageLimitsJson.parse(json).single().limits.single()
        assertEquals(24.0, limit.percent, 0.001)
        assertNull(limit.usageHoursLeft)
        assertNull(limit.perHour)
        assertNull(limit.projectedPercent)
        assertNull(limit.runsOutAt)
        assertNull(limit.basis)
        assertEquals("76%", UsageLimitCopy.remainingLabel(limit.percent))
        assertEquals("76% left", UsageLimitCopy.describeForecast(limit, 1_700_000_000_000L).text)
    }
}
