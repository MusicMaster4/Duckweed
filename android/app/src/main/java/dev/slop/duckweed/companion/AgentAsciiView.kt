package dev.slop.duckweed.companion

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat

/** Draws one randomly selected custom-agent ASCII scene at the duck's visual scale. */
class AgentAsciiView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val scene = scenePicker.pick()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.MONOSPACE
        color = ContextCompat.getColor(context, R.color.duckweed_accent)
    }
    private var cellWidth = 0f
    private var lineHeight = 0f
    private var originMs = SystemClock.uptimeMillis()

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        val contentWidth = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        val contentHeight = (height - paddingTop - paddingBottom).coerceAtLeast(0)
        if (contentWidth == 0 || contentHeight == 0) return
        val density = resources.displayMetrics.density
        val fontDp = AgentAsciiRenderer.fontSize(
            contentWidth / density.toDouble(),
            contentHeight / density.toDouble(),
        )
        paint.textSize = fontDp * density
        cellWidth = paint.measureText("0")
        lineHeight = paint.textSize * 1.1f
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (cellWidth == 0f || lineHeight == 0f) return
        val animate = animationsEnabled()
        val seconds = if (animate) (SystemClock.uptimeMillis() - originMs) / 1000.0 else 17.0
        val rows = AgentAsciiRenderer.render(scene, seconds)
        val gridWidth = AgentAsciiRenderer.WIDTH * cellWidth
        val gridHeight = AgentAsciiRenderer.HEIGHT * lineHeight
        val x = paddingLeft + (width - paddingLeft - paddingRight - gridWidth) / 2f
        var baseline = paddingTop +
            (height - paddingTop - paddingBottom - gridHeight) / 2f -
            paint.fontMetrics.ascent

        paint.alpha = (255 * 0.38f).toInt()
        rows.forEach { row ->
            canvas.drawText(row, x, baseline, paint)
            baseline += lineHeight
        }
        paint.alpha = 255

        if (animate && isShown) postInvalidateDelayed(1000L / AgentAsciiRenderer.FPS)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        originMs = SystemClock.uptimeMillis()
        invalidate()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (visibility == VISIBLE) invalidate()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility == VISIBLE) invalidate()
    }

    private fun animationsEnabled(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ValueAnimator.areAnimatorsEnabled()

    private companion object {
        val scenePicker = AgentAsciiScenePicker()
    }
}
