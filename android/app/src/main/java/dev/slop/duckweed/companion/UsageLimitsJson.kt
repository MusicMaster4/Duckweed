package dev.slop.duckweed.companion

import org.json.JSONArray
import org.json.JSONObject

object UsageLimitsJson {
    fun parse(quotasJson: JSONArray?): List<RemoteUsageQuota> {
        val quotas = quotasJson ?: return emptyList()
        return (0 until quotas.length()).mapNotNull { quotaIndex ->
            val quota = quotas.optJSONObject(quotaIndex) ?: return@mapNotNull null
            val limitsJson = quota.optJSONArray("limits") ?: JSONArray()
            val limits = (0 until limitsJson.length()).mapNotNull { limitIndex ->
                parseLimit(limitsJson.optJSONObject(limitIndex) ?: return@mapNotNull null, limitIndex)
            }
            if (limits.isEmpty()) return@mapNotNull null
            RemoteUsageQuota(
                agent = quota.optString("agent"),
                label = quota.optString("label", "Agent"),
                plan = if (quota.isNull("plan")) {
                    null
                } else {
                    quota.optString("plan").takeIf { it.isNotBlank() }
                },
                limits = limits,
            )
        }
    }

    fun write(quotas: List<RemoteUsageQuota>): JSONArray = JSONArray().apply {
        quotas.forEach { quota ->
            put(
                JSONObject()
                    .put("agent", quota.agent)
                    .put("label", quota.label)
                    .put("plan", quota.plan)
                    .put(
                        "limits",
                        JSONArray().apply {
                            quota.limits.forEach { limit ->
                                put(
                                    JSONObject()
                                        .put("id", limit.id)
                                        .put("label", limit.label)
                                        .put("percent", limit.percent)
                                        .put("resetsAt", limit.resetsAt)
                                        .put("usageHoursLeft", limit.usageHoursLeft)
                                        .put("perHour", limit.perHour)
                                        .put("projectedPercent", limit.projectedPercent)
                                        .put("runsOutAt", limit.runsOutAt)
                                        .put("basis", limit.basis),
                                )
                            }
                        },
                    ),
            )
        }
    }

    private fun parseLimit(limit: JSONObject, index: Int): RemoteUsageLimit? {
        val percent = limit.optDouble("percent", Double.NaN)
        if (!percent.isFinite()) return null
        return RemoteUsageLimit(
            id = limit.optString("id", "limit-$index"),
            label = limit.optString("label", "Usage limit"),
            percent = percent.coerceIn(0.0, 100.0),
            resetsAt = limit.optionalLong("resetsAt"),
            usageHoursLeft = limit.optionalFiniteDouble("usageHoursLeft", min = 0.0),
            perHour = limit.optionalFiniteDouble("perHour", min = 0.0),
            projectedPercent = limit.optionalFiniteDouble("projectedPercent"),
            runsOutAt = limit.optionalLong("runsOutAt"),
            basis = limit.optionalString("basis"),
        )
    }

    private fun JSONObject.optionalLong(key: String): Long? {
        if (!has(key) || isNull(key)) return null
        return optLong(key)
    }

    private fun JSONObject.optionalFiniteDouble(key: String, min: Double? = null): Double? {
        if (!has(key) || isNull(key)) return null
        val value = optDouble(key)
        if (!value.isFinite()) return null
        if (min != null && value < min) return null
        return value
    }

    private fun JSONObject.optionalString(key: String): String? {
        if (!has(key) || isNull(key)) return null
        return optString(key).takeIf { it.isNotBlank() }
    }
}
