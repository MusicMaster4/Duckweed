package dev.slop.duckweed.companion

import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import androidx.core.content.ContextCompat
import kotlin.math.roundToInt

internal object MobileTabColorStyle {
    private const val FILL_RATIO = 0.24f

    fun parse(color: String?): Int? = color?.let {
        runCatching { Color.parseColor(it) }.getOrNull()
    }

    fun apply(view: View, accent: Int?, unread: Boolean = false) {
        val context = view.context
        val density = context.resources.displayMetrics.density
        val surface = ContextCompat.getColor(context, R.color.duckweed_surface)
        val border = ContextCompat.getColor(context, R.color.duckweed_border)
        val unreadColor = ContextCompat.getColor(context, R.color.duckweed_unread)
        val strokeWidth = when {
            unread -> (2 * density).roundToInt()
            accent == null -> density.roundToInt().coerceAtLeast(1)
            else -> 0
        }
        val strokeColor = when {
            unread -> unreadColor
            accent == null -> border
            else -> Color.TRANSPARENT
        }

        view.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = 16 * density
            setColor(fillColor(surface, accent))
            setStroke(strokeWidth, strokeColor)
        }
    }

    internal fun fillColor(surface: Int, accent: Int?): Int =
        accent?.let { blendArgb(surface, it, FILL_RATIO) } ?: surface

    internal fun blendArgb(background: Int, foreground: Int, foregroundRatio: Float): Int {
        val ratio = foregroundRatio.coerceIn(0f, 1f)
        val inverse = 1f - ratio
        fun channel(shift: Int): Int = (
            ((background ushr shift) and 0xff) * inverse +
                ((foreground ushr shift) and 0xff) * ratio
        ).roundToInt()

        return (channel(24) shl 24) or
            (channel(16) shl 16) or
            (channel(8) shl 8) or
            channel(0)
    }
}
