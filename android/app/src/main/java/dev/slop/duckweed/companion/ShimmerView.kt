package dev.slop.duckweed.companion

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator

/** A quiet moving highlight for cards whose terminal is actively working. */
class ShimmerView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var progress = -0.5f
    private val animator = ValueAnimator.ofFloat(-0.5f, 1.5f).apply {
        duration = 1_650
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            progress = it.animatedValue as Float
            invalidate()
        }
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        syncAnimation()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        syncAnimation()
    }

    override fun onDetachedFromWindow() {
        animator.cancel()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return
        val center = progress * width
        val band = width * 0.3f
        paint.shader = LinearGradient(
            center - band,
            0f,
            center + band,
            0f,
            intArrayOf(0x007BE05A, 0x247BE05A, 0x007BE05A),
            floatArrayOf(0f, 0.5f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }

    private fun syncAnimation() {
        if (isAttachedToWindow && visibility == VISIBLE) {
            if (!animator.isStarted) animator.start()
        } else {
            animator.cancel()
        }
    }
}
