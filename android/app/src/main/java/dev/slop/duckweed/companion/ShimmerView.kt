package dev.slop.duckweed.companion

import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
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
    private val easing = PathInterpolator(0.42f, 0f, 0.58f, 1f)
    private val bandWidth = 72f * resources.displayMetrics.density
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

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        invalidate()
    }

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return
        val animatorsEnabled = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            android.animation.ValueAnimator.areAnimatorsEnabled()
        val progress = if (animatorsEnabled) {
            // RecyclerView can detach and reattach a visible card during a refresh. A clock-based
            // phase survives that lifecycle churn, unlike restarting a ValueAnimator on attach.
            val cyclePosition =
                (SystemClock.uptimeMillis() % DURATION_MS).toFloat() / DURATION_MS.toFloat()
            easing.getInterpolation(cyclePosition)
        } else {
            0.42f
        }
        val left = -bandWidth + progress * (width + bandWidth)
        shaderMatrix.setTranslate(left, 0f)
        shimmerShader.setLocalMatrix(shaderMatrix)
        paint.alpha = if (animatorsEnabled) 255 else 115
        paint.shader = shimmerShader
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
        if (animatorsEnabled && isShown && windowVisibility == VISIBLE) {
            postInvalidateOnAnimation()
        }
    }

    private companion object {
        const val DURATION_MS = 1_800L
    }
}
