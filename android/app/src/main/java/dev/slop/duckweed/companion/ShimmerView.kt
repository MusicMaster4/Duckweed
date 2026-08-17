package dev.slop.duckweed.companion

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.os.Build
import android.util.AttributeSet
import android.view.View
import android.view.animation.PathInterpolator

/** A quiet moving highlight for cards whose terminal is actively working. */
class ShimmerView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shaderMatrix = Matrix()
    private val bandWidth = 72f * resources.displayMetrics.density
    private var progress = 0f
    private val shimmerShader = LinearGradient(
        0f,
        0f,
        bandWidth,
        0f,
        intArrayOf(
            0x00FFFFFF,
            0x0AFFFFFF,
            0x2EFFFFFF,
            0x0AFFFFFF,
            0x00FFFFFF,
        ),
        floatArrayOf(0f, 0.25f, 0.5f, 0.75f, 1f),
        Shader.TileMode.CLAMP,
    )
    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 1_800
        repeatCount = ValueAnimator.INFINITE
        interpolator = PathInterpolator(0.42f, 0f, 0.58f, 1f)
        addUpdateListener {
            progress = it.animatedValue as Float
            invalidate()
        }
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        syncAnimation()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
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
        val left = -bandWidth + progress * (width + bandWidth)
        shaderMatrix.setTranslate(left, 0f)
        shimmerShader.setLocalMatrix(shaderMatrix)
        paint.shader = shimmerShader
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }

    private fun syncAnimation() {
        val animatorsEnabled = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            ValueAnimator.areAnimatorsEnabled()
        paint.alpha = if (animatorsEnabled) 255 else 115
        if (isAttachedToWindow && isShown && windowVisibility == VISIBLE && animatorsEnabled) {
            if (!animator.isRunning) animator.start()
        } else {
            animator.cancel()
            progress = if (animatorsEnabled) 0f else 0.42f
            invalidate()
        }
    }
}
