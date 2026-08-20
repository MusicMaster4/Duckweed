package dev.slop.duckweed.companion

import kotlin.math.floor
import kotlin.math.roundToInt
import kotlin.math.roundToLong

object UsageLimitCopy {
    fun percentUsed(percent: Double): String = "${percent.coerceIn(0.0, 100.0).roundToInt()}% used"

    fun resetTime(resetsAt: Long?, now: Long): String? {
        resetsAt ?: return null
        val remaining = resetsAt - now
        if (remaining <= 0) return "Resetting now"
        return "Resets in ${span(remaining)}"
    }

    fun activeTimeLeft(hours: Double?): String? {
        if (hours == null || !hours.isFinite() || hours < 0.0) return null
        val minutes = (hours * 60.0).roundToLong()
        if (minutes <= 0) return "No use left"
        return "About ${span(minutes * 60_000)} of use left"
    }

    private fun span(milliseconds: Long): String {
        val minutes = (milliseconds.coerceAtLeast(0) / 60_000.0).roundToLong()
        if (minutes < 60) return "${minutes}m"
        val hours = floor(minutes / 60.0).toLong()
        if (hours < 24) {
            val remainingMinutes = minutes % 60
            return if (remainingMinutes == 0L) "${hours}h" else "${hours}h ${remainingMinutes}m"
        }
        return "${(hours / 24.0).roundToLong()}d"
    }
}
