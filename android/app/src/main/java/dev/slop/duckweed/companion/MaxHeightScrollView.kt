package dev.slop.duckweed.companion

import android.content.Context
import android.util.AttributeSet
import android.view.View
import android.widget.ScrollView

class MaxHeightScrollView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : ScrollView(context, attrs, defStyleAttr) {
    var maxHeightPx: Int = Int.MAX_VALUE

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val available = if (View.MeasureSpec.getMode(heightMeasureSpec) == View.MeasureSpec.UNSPECIFIED) {
            maxHeightPx
        } else {
            View.MeasureSpec.getSize(heightMeasureSpec)
        }
        val capped = minOf(available, maxHeightPx)
        super.onMeasure(
            widthMeasureSpec,
            View.MeasureSpec.makeMeasureSpec(capped, View.MeasureSpec.AT_MOST),
        )
    }
}
