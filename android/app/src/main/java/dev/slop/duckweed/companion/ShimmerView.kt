package dev.slop.duckweed.companion

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.os.Build
import android.os.SystemClock
import android.util.AttributeSet
import android.view.Choreographer
import android.view.View
import android.view.animation.PathInterpolator
import kotlin.math.roundToInt

/** A quiet moving highlight for cards whose terminal is actively working. */
class ShimmerView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
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
    private var running = false
    private var callbackPosted = false
    private val frameCallback = Choreographer.FrameCallback { _ ->
        callbackPosted = false
        if (!running) return@FrameCallback
        updateTranslation()
        postFrame()
    }

    init {
        paint.shader = shimmerShader
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        isClickable = false
        isFocusable = false
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = bandWidth.roundToInt().coerceAtLeast(1)
        val height = when (MeasureSpec.getMode(heightMeasureSpec)) {
            MeasureSpec.EXACTLY, MeasureSpec.AT_MOST -> MeasureSpec.getSize(heightMeasureSpec)
            else -> suggestedMinimumHeight
        }
        setMeasuredDimension(width, height)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        updateTranslation()
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
        stopAnimating()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (width <= 0 || height <= 0) return
        paint.alpha = if (animatorsEnabled()) 255 else 115
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), paint)
    }

    override fun hasOverlappingRendering(): Boolean = false

    private fun syncAnimation() {
        if (isAttachedToWindow && isShown && windowVisibility == VISIBLE && animatorsEnabled()) {
            startAnimating()
        } else {
            stopAnimating()
            updateTranslation()
            invalidate()
        }
    }

    private fun startAnimating() {
        if (running) return
        running = true
        setLayerType(LAYER_TYPE_HARDWARE, null)
        updateTranslation()
        postFrame()
    }

    private fun stopAnimating() {
        if (!running) return
        running = false
        if (callbackPosted) {
            Choreographer.getInstance().removeFrameCallback(frameCallback)
            callbackPosted = false
        }
        setLayerType(LAYER_TYPE_NONE, null)
    }

    private fun postFrame() {
        if (callbackPosted) return
        callbackPosted = true
        Choreographer.getInstance().postFrameCallback(frameCallback)
    }

    private fun updateTranslation() {
        val span = (parent as? View)?.width?.toFloat() ?: 0f
        if (span <= 0f) {
            translationX = -bandWidth
            return
        }
        val progress = if (animatorsEnabled()) {
            // RecyclerView can detach and reattach a visible card during a refresh. A clock-based
            // phase survives that lifecycle churn, unlike restarting a ValueAnimator on attach.
            val cyclePosition =
                (SystemClock.uptimeMillis() % DURATION_MS).toFloat() / DURATION_MS.toFloat()
            easing.getInterpolation(cyclePosition)
        } else {
            0.42f
        }
        translationX = -bandWidth + progress * (span + bandWidth)
    }

    private fun animatorsEnabled(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ValueAnimator.areAnimatorsEnabled()

    private companion object {
        const val DURATION_MS = 1_800L
    }
}
