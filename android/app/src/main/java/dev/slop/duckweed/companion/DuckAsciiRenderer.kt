package dev.slop.duckweed.companion

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * Android port of src/lib/duckAscii.ts.
 *
 * Keeping the traced silhouette, density ramp, waves, shimmer, and timing in
 * sync makes the companion render the same procedural duck as the desktop.
 */
object DuckAsciiRenderer {
    const val FPS = 15

    private const val SRC_W = 247.0
    private const val SRC_H = 106.0
    private const val SPAN_COLS = 124
    private const val RAMP = " .,:;i1tfLCG08@"
    private const val SURFACE = "~-_"
    private val TAU = Math.PI * 2.0
    private const val ROWS_BELOW = 3
    private const val WIDTH_SHARE = 0.52
    private const val MIN_DUCK_COLS = 12
    private const val MAX_DUCK_COLS = 76
    private const val BOB_ROWS = 0.3
    private const val BOB_PERIOD = 5.5
    private const val ROCK_ROWS = 0.55
    private const val ROCK_PERIOD = 8.3
    private const val SHIMMER = 0.24

    private const val SPAN_DATA =
        "13140000101600000z1700000y1700000y1700000x1700000x1700000w1700000v1700000u1700000t1600000s1600000q1600000p1500000n1500000i1400000e142b2t0b14262y0814222y06141z2y05141w2y03151t2y02161r2y01161o2y01171k2y00191f2y002y0000002y0000002y0000002y0000002y0000002y0000012y0000012y0000022y0000032y0000052y0000062y0000082y00000a1s1w2y0d1l1z2y0h1f1z2y0m181z2y1y2y00001y2y00001x2y00001w2y00001v2y00001u2y00001t2y00001s2y00001s2y00001r2y00001q2y00001p2y00001p2y00001o2y00001o2y00001n2y00001n2y00001m2y00001m2y00001m2y00001l2y00001l2y00001l2y00001l2y00001l2y00001l2y00001k2y00001k2y00001k2y00001k2y00001k2y00001k2y00001k2y00001k2y00001l2y00001l2y00001l2y00001l2y00001l2y00001l2y00001l2y00001m2y00001m2y00001m2y00001m2y00001m2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001n2y00001m2y00001m2y00001m2y00001m2y00001l2y00001l2y00001l2y00001k2y00001j2y00001i2y00001i2x00001h2w00001g2u00001f2s00001e2q00001d1q1s2o1c1n1r2m1b1k1r2j1c1e202h1p1w202e1o1u1z2c1o1s1z2a1y2800001y2600001x2400001x210000"

    private val spans = ShortArray(SPAN_COLS * 4) { index ->
        SPAN_DATA.substring(index * 2, index * 2 + 2).toInt(36).toShort()
    }

    data class Layout(
        val cols: Int,
        val rows: Int,
        val duckCols: Int,
        val duckRows: Double,
    )

    data class Frame(
        val duck: List<String>,
        val water: List<String>,
    )

    fun fontSize(width: Double, height: Double): Int =
        min(height / 18.0, width / 62.0).roundToInt().coerceIn(7, 16)

    fun layout(width: Double, height: Double, cellWidth: Double, cellHeight: Double): Layout {
        val cols = max(1, floor(width / cellWidth).toInt())
        val rows = max(1, floor(height / cellHeight).toInt())
        val rowsPerCol = (SRC_H / SRC_W) * (cellWidth / cellHeight)
        val availableDuckRows = max(1.0, rows - waterRows(rows).toDouble())
        val upperDuckCols = min(MAX_DUCK_COLS, cols)
        val duckCols = min(cols * WIDTH_SHARE, availableDuckRows / rowsPerCol)
            .coerceIn(min(MIN_DUCK_COLS, upperDuckCols).toDouble(), upperDuckCols.toDouble())
            .roundToInt()
        return Layout(
            cols = cols,
            rows = rows,
            duckCols = duckCols,
            duckRows = max(2.0, duckCols * rowsPerCol),
        )
    }

    fun render(layout: Layout, timeSeconds: Double): Frame {
        val baseline = layout.rows - waterRows(layout.rows)
        val surface = DoubleArray(layout.cols) { column ->
            (baseline + wave(column, timeSeconds)).coerceIn(
                min(0.6, layout.rows - 0.2),
                layout.rows - 0.2,
            )
        }
        val left = floor((layout.cols - layout.duckCols) / 2.0).toInt()
        val centre = (left + (layout.duckCols shr 1)).coerceIn(0, layout.cols - 1)
        val bottom = surface[centre] + BOB_ROWS * sin((TAU * timeSeconds) / BOB_PERIOD)
        val rock = ROCK_ROWS * sin((TAU * timeSeconds) / ROCK_PERIOD)
        val bird = ArrayList<String>(layout.rows)
        val pond = ArrayList<String>(layout.rows)

        for (row in 0 until layout.rows) {
            val ink = StringBuilder(layout.cols)
            val wet = StringBuilder(layout.cols)
            for (column in 0 until layout.cols) {
                val depth = surface[column] - row
                var glyph = ' '
                val duckColumn = column - left
                if (duckColumn >= 0 && duckColumn < layout.duckCols && depth >= 0.15) {
                    val top = bottom - layout.duckRows +
                        (duckColumn.toDouble() / layout.duckCols - 0.5) * rock
                    var y0 = ((row - top) / layout.duckRows) * SRC_H
                    var y1 = ((row + 1 - top) / layout.duckRows) * SRC_H
                    val over = max(0.0, y1 - SRC_H)
                    y0 -= over
                    y1 -= over
                    if (y1 > 0) {
                        val fill = coverage(
                            (duckColumn.toDouble() / layout.duckCols) * SRC_W,
                            ((duckColumn + 1.0) / layout.duckCols) * SRC_W,
                            y0,
                            y1,
                        ) * (1 + SHIMMER * shimmer(column, row, timeSeconds))
                        val sampled = floor(fill * RAMP.length).toInt()
                        val step = if (fill > 0 && layout.rows <= 3) max(1, sampled) else sampled
                        glyph = RAMP[step.coerceIn(0, RAMP.lastIndex)]
                    }
                }
                ink.append(glyph)

                when {
                    depth >= 0 && depth < 1 ->
                        wet.append(SURFACE[if (depth < 0.34) 0 else if (depth < 0.67) 1 else 2])
                    depth < 0 && shimmer(column, row, timeSeconds) > 0.62 -> wet.append('.')
                    else -> wet.append(' ')
                }
            }
            bird += ink.toString()
            pond += wet.toString()
        }

        if (layout.rows <= 3 && bird.none { line -> line.any { !it.isWhitespace() } }) {
            val row = (baseline - 1).coerceIn(0, layout.rows - 1)
            val line = StringBuilder(bird[row])
            line.set(centre, RAMP[(RAMP.length * 0.65).toInt()])
            bird[row] = line.toString()
        }

        return Frame(bird, pond)
    }

    private fun waterRows(rows: Int): Int = min(ROWS_BELOW, max(1, rows / 4))

    private fun wave(column: Int, time: Double): Double =
        0.42 * sin(column * 0.21 - time * 1.15) +
            0.26 * sin(column * 0.085 - time * 0.42) +
            0.12 * sin(column * 0.5 - time * 2.1)

    private fun shimmer(column: Int, row: Int, time: Double): Double =
        0.6 * sin(column * 0.8 + time * 1.9) * sin(row * 1.6 - time * 1.3) +
            0.4 * sin((column + row * 2) * 0.35 - time * 2.7)

    private fun coverage(x0: Double, x1: Double, y0: Double, y1: Double): Double {
        val first = floor((x0 / SRC_W) * SPAN_COLS).toInt().coerceIn(0, SPAN_COLS - 1)
        val last = ceil((x1 / SRC_W) * SPAN_COLS).toInt().coerceIn(first + 1, SPAN_COLS)
        var ink = 0.0
        for (column in first until last) {
            val index = column * 4
            ink += max(0.0, min(spans[index + 1].toDouble(), y1) - max(spans[index].toDouble(), y0))
            ink += max(0.0, min(spans[index + 3].toDouble(), y1) - max(spans[index + 2].toDouble(), y0))
        }
        return ink / ((y1 - y0) * (last - first))
    }
}
