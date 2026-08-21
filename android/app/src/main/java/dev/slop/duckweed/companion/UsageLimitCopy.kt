package dev.slop.duckweed.companion

import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.roundToLong

object UsageLimitCopy {
    enum class Tone { Critical, Warning, Ok, Muted }

    enum class MeterLevel { Critical, Warning, Ok }

    data class ForecastCopy(
        val tone: Tone,
        val text: String,
        val detail: String?,
    )

    fun remainingPercent(percent: Double): Int =
        (100.0 - percent.coerceIn(0.0, 100.0)).roundToInt().coerceIn(0, 100)

    fun remainingLabel(percent: Double): String = "${remainingPercent(percent)}%"

    fun meterLevel(percent: Double): MeterLevel {
        val remaining = (100.0 - percent.coerceIn(0.0, 100.0)).coerceIn(0.0, 100.0)
        return when {
            remaining < 10.0 -> MeterLevel.Critical
            remaining < 30.0 -> MeterLevel.Warning
            else -> MeterLevel.Ok
        }
    }

    fun untilReset(resetsAt: Long?, now: Long): String? {
        resetsAt ?: return null
        val remaining = resetsAt - now
        if (remaining <= 0) return "resetting"
        return "in ${span(remaining)}"
    }

    fun resetHint(resetsAt: Long?, now: Long): String? {
        val remaining = untilReset(resetsAt, now) ?: return null
        return if (remaining == "resetting") remaining else "resets $remaining"
    }

    fun formatPace(perHour: Double): String {
        if (perHour >= 10) return "${perHour.roundToInt()}%/h"
        if (perHour >= 1) {
            val text = "%.1f".format(java.util.Locale.US, perHour)
            return "${text.removeSuffix(".0")}%/h"
        }
        return "%.1f".format(java.util.Locale.US, perHour) + "%/h"
    }

    fun describeForecast(limit: RemoteUsageLimit, now: Long): ForecastCopy {
        if (limit.basis == "exhausted" || limit.percent >= 99.5) {
            return ForecastCopy(Tone.Critical, "No quota left", null)
        }

        val hasForecast = limit.basis != null ||
            limit.perHour != null ||
            limit.projectedPercent != null ||
            limit.runsOutAt != null

        if (!hasForecast) {
            if (limit.percent <= 0) {
                return ForecastCopy(Tone.Ok, "Unused", null)
            }
            return ForecastCopy(
                Tone.Muted,
                "${remainingPercent(limit.percent)}% left",
                null,
            )
        }

        val pace = limit.perHour?.let { formatPace(it) }
        val runsOut = limit.runsOutAt
        val resets = limit.resetsAt

        if (runsOut != null && (resets == null || runsOut < resets)) {
            val usageTimeLeft = limit.usageHoursLeft?.let { hours -> hours * 3_600_000.0 }
            val timeLeft = usageTimeLeft ?: (runsOut - now).toDouble()
            val tone = if (usageTimeLeft != null) {
                if (usageTimeLeft <= 2 * 3_600_000.0) Tone.Critical else Tone.Warning
            } else {
                if (runsOut - now <= 3_600_000L) Tone.Critical else Tone.Warning
            }
            return ForecastCopy(tone, "${span(timeLeft)} left", pace)
        }

        val projected = limit.projectedPercent
        if (projected == null) {
            return ForecastCopy(Tone.Ok, "Within limit", pace)
        }
        val leftAtReset = (100.0 - projected).coerceIn(0.0, 100.0)
        return ForecastCopy(
            if (leftAtReset <= 10.0) Tone.Warning else Tone.Ok,
            "${leftAtReset.roundToInt()}% by reset",
            pace,
        )
    }

    fun agentSwatch(agent: String): Int = when (agent.lowercase(java.util.Locale.US)) {
        "claude" -> 0xFF3987E5.toInt()
        "codex" -> 0xFFD95926.toInt()
        "gemini" -> 0xFF199E70.toInt()
        "opencode" -> 0xFFC98500.toInt()
        "grok" -> 0xFFD55181.toInt()
        "droid" -> 0xFF008300.toInt()
        "kilocode" -> 0xFF9085E9.toInt()
        "kimi" -> 0xFFE66767.toInt()
        "pi" -> 0xFF1599B0.toInt()
        "claudex" -> 0xFFA13D8F.toInt()
        else -> 0xFF5C665E.toInt()
    }

    internal fun span(milliseconds: Long): String = span(milliseconds.toDouble())

    internal fun span(milliseconds: Double): String {
        val minutes = (milliseconds.coerceAtLeast(0.0) / 60_000.0).roundToLong()
        if (minutes < 60) return "${minutes}m"
        val hours = floor(minutes / 60.0).toLong()
        if (hours < 24) {
            val remainingMinutes = minutes % 60
            return if (remainingMinutes == 0L) "${hours}h" else "${hours}h ${remainingMinutes}m"
        }
        return "${(hours / 24.0).roundToLong()}d"
    }
}
