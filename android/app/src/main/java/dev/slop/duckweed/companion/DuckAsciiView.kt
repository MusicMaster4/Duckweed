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

/** Draws the desktop duck's two ASCII layers without turning them into a bitmap. */
class DuckAsciiView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        typeface = Typeface.MONOSPACE
        color = ContextCompat.getColor(context, R.color.duckweed_accent)
    }
    private var layout: DuckAsciiRenderer.Layout? = null
    private var cellWidth = 0f
    private var lineHeight = 0f
    private var originMs = SystemClock.uptimeMillis()

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        val contentWidth = (width - paddingLeft - paddingRight).coerceAtLeast(0)
        val contentHeight = (height - paddingTop - paddingBottom).coerceAtLeast(0)
        if (contentWidth == 0 || contentHeight == 0) {
            layout = null
            return
        }
        val density = resources.displayMetrics.density
        val fontDp = DuckAsciiRenderer.fontSize(contentWidth / density.toDouble(), contentHeight / density.toDouble())
        paint.textSize = fontDp * density
        cellWidth = paint.measureText("0")
        lineHeight = paint.textSize * 1.1f
        layout = DuckAsciiRenderer.layout(
            contentWidth.toDouble(),
            contentHeight.toDouble(),
            cellWidth.toDouble(),
            lineHeight.toDouble(),
        )
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val currentLayout = layout ?: return
        val animate = animationsEnabled()
        val seconds = if (animate) (SystemClock.uptimeMillis() - originMs) / 1000.0 else 17.0
        val frame = DuckAsciiRenderer.render(currentLayout, seconds)
        val gridWidth = currentLayout.cols * cellWidth
        val gridHeight = currentLayout.rows * lineHeight
        val x = paddingLeft + ((width - paddingLeft - paddingRight - gridWidth) / 2f)
        val metrics = paint.fontMetrics
        var baseline = paddingTop + ((height - paddingTop - paddingBottom - gridHeight) / 2f) - metrics.ascent

        paint.alpha = (255 * 0.17f).toInt()
        frame.water.forEach { row ->
            canvas.drawText(row, x, baseline, paint)
            baseline += lineHeight
        }

        baseline = paddingTop + ((height - paddingTop - paddingBottom - gridHeight) / 2f) - metrics.ascent
        paint.alpha = (255 * 0.38f).toInt()
        frame.duck.forEach { row ->
            canvas.drawText(row, x, baseline, paint)
            baseline += lineHeight
        }
        paint.alpha = 255

        if (animate && isShown) postInvalidateDelayed(1000L / DuckAsciiRenderer.FPS)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        originMs = SystemClock.uptimeMillis()
        invalidate()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        if (visibility == VISIBLE) invalidate()
    }

    private fun animationsEnabled(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ValueAnimator.areAnimatorsEnabled()
}
