package dev.slop.duckweed.companion

import android.animation.ValueAnimator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.widget.TextView

class AsciiAnimator(
    private val target: TextView,
    private val frames: List<String>,
    private val frameDelayMs: Long = 420L,
) {
    private val handler = Handler(Looper.getMainLooper())
    private var frame = 0
    private val advance = object : Runnable {
        override fun run() {
            frame = (frame + 1) % frames.size
            target.text = frames[frame]
            handler.postDelayed(this, frameDelayMs)
        }
    }

    init {
        require(frames.isNotEmpty())
        target.text = frames.first()
    }

    fun start() {
        stop()
        val animationsEnabled =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.O || ValueAnimator.areAnimatorsEnabled()
        if (animationsEnabled && frames.size > 1) {
            handler.postDelayed(advance, frameDelayMs)
        }
    }

    fun stop() {
        handler.removeCallbacks(advance)
    }

    companion object {
        val DUCK = listOf(
            "      ___       \n  ___/ o )      \n /      /   ~   \n~~~~\\___/~~~~~~~",
            "      ___       \n  ___/ o )      \n /      / ~     \n~~~\\___/~~~~~~~~",
            "      ___       \n  ___/ o )      \n /      /     ~ \n~~~~~\\___/~~~~~~",
            "      ___       \n  ___/ o )      \n /      /  ~    \n~~~~\\___/~~~~~~~",
        )

        val CONNECTION = listOf(
            "     .----- .     \n  .-'    *    '-.  \n (   .       .   ) \n  '-.    |    .-'  \n     '---+---'     ",
            "     . ----- .     \n  .-'   *     '-.   \n (    .     .    )  \n  '-.    |    .-'   \n     '---+---'      ",
            "      .----- .      \n   .-'     *  '-.    \n  (   .       .   )  \n   '-.   |     .-'   \n      '---+---'       ",
        )

        val UPDATE = listOf(
            "      +------+      \n      |  \\ / |      \n      |   V  |      \n      +--[_]-+      ",
            "      +------+      \n      |   |  |      \n      |  \\V/ |      \n      +--[_]-+      ",
            "      +------+      \n      |      |      \n      |  \\|/ |      \n      +--[V]-+      ",
        )
    }
}
