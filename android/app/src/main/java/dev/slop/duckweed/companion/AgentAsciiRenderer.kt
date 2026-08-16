package dev.slop.duckweed.companion

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.random.Random

/**
 * A compact Android port of the 28 x 10 animation canvas used by the desktop
 * custom agent UI. The selected scenes intentionally keep the same geometry,
 * timing, and density ramp on both surfaces.
 */
object AgentAsciiRenderer {
    const val WIDTH = 28
    const val HEIGHT = 10
    const val FPS = 15

    private const val CELL_RATIO = 0.6
    private const val ASPECT = (WIDTH * CELL_RATIO) / HEIGHT
    private const val RAMP = " .:-=+*▒#%@▓█"
    private const val COMET_LANES = 7
    private val TAU = PI * 2.0

    enum class Scene {
        BRAID,
        HELIX,
        CUBE,
        OCTAHEDRON,
        GLOBE,
        RIBBON,
        COMETS,
        BOUNCE,
        PENDULUM,
        CLOCK,
    }

    val scenes: List<Scene> = Scene.entries

    fun fontSize(widthDp: Double, heightDp: Double): Int =
        min(widthDp / 36.0, heightDp / 12.5).roundToInt().coerceIn(7, 16)

    fun render(scene: Scene, timeSeconds: Double): List<String> = when (scene) {
        Scene.BRAID -> paintBraid(timeSeconds)
        Scene.HELIX -> paintHelix(timeSeconds)
        Scene.CUBE -> paintWireframe(CUBE_VERTICES, CUBE_EDGES, timeSeconds, 1.1, 0.95)
        Scene.OCTAHEDRON -> paintWireframe(OCTAHEDRON_VERTICES, OCTAHEDRON_EDGES, timeSeconds, 1.35, 0.95)
        Scene.GLOBE -> paintGlobe(timeSeconds)
        Scene.RIBBON -> paintRibbon(timeSeconds)
        Scene.COMETS -> paintField(timeSeconds, ::cometField)
        Scene.BOUNCE -> paintBounce(timeSeconds)
        Scene.PENDULUM -> paintPendulum(timeSeconds)
        Scene.CLOCK -> paintClock(timeSeconds)
    }

    private fun paintBraid(time: Double): List<String> = paintPlotted { plot ->
        repeat(2) { strand ->
            val phase = strand / 2.0 * TAU
            for (sample in 0..180) {
                val u = sample / 180.0 * ASPECT * 2 - ASPECT
                val envelope = cos((u / ASPECT) * (PI / 2))
                val angle = u * 1.3 - time * 2.2 + phase
                val depth = (cos(angle) + 1) / 2
                plot(
                    u,
                    sin(angle) * 0.8 * envelope.pow(0.55),
                    (0.2 + 0.8 * depth * depth) * envelope.pow(0.45),
                )
            }
        }
    }

    private fun paintHelix(time: Double): List<String> = paintPlotted { plot ->
        for (rung in 0 until 9) {
            val u = -ASPECT + rung / 8.0 * ASPECT * 2
            val angle = u * 2.1 - time * 0.7
            val top = sin(angle) * 0.74
            for (step in 0..10) plot(u, top + (-top - top) * (step / 10.0), 0.1)
        }
        for (sample in 0..170) {
            val u = sample / 170.0 * ASPECT * 2 - ASPECT
            val angle = u * 2.1 - time * 0.7
            val depth = (cos(angle) + 1) / 2
            plot(u, sin(angle) * 0.74, 0.25 + 0.75 * depth)
            plot(u, -sin(angle) * 0.74, 0.25 + 0.75 * (1 - depth))
        }
    }

    private fun paintWireframe(
        vertices: List<Vertex>,
        edges: List<Edge>,
        time: Double,
        spin: Double,
        size: Double,
    ): List<String> {
        val yaw = time * spin
        val pitch = 0.5 + sin(time * 0.6) * 0.3
        val projected = vertices.map { (x, y, z) ->
            val rotatedX = x * cos(yaw) + z * sin(yaw)
            val rotatedZ = z * cos(yaw) - x * sin(yaw)
            val rotatedY = y * cos(pitch) - rotatedZ * sin(pitch)
            val depth = rotatedZ * cos(pitch) + y * sin(pitch)
            val scale = 1.9 / (3.6 + depth) * size
            Vertex(rotatedX * scale, rotatedY * scale, depth)
        }
        return paintPlotted { plot ->
            edges.forEach { (from, to) ->
                val a = projected[from]
                val b = projected[to]
                for (step in 0..34) {
                    val fraction = step / 34.0
                    val depth = a.z + (b.z - a.z) * fraction
                    plot(
                        a.x + (b.x - a.x) * fraction,
                        a.y + (b.y - a.y) * fraction,
                        0.3 + 0.7 * clamp01((1.8 - depth) / 3.6),
                    )
                }
            }
        }
    }

    private fun paintGlobe(time: Double): List<String> {
        val yaw = time * 0.85
        val tilt = 0.42
        fun project(latitude: Double, longitude: Double): Vertex {
            val x = cos(latitude) * cos(longitude + yaw)
            val y = sin(latitude)
            val z = cos(latitude) * sin(longitude + yaw)
            return Vertex(x, y * cos(tilt) - z * sin(tilt), y * sin(tilt) + z * cos(tilt))
        }
        return paintPlotted { plot ->
            repeat(5) { ring ->
                val latitude = -PI / 3 + ring / 4.0 * (2 * PI / 3)
                for (step in 0..90) {
                    val point = project(latitude, step / 90.0 * TAU)
                    if (point.z >= 0) plot(point.x * 0.9, point.y * 0.9, 0.22 + 0.78 * point.z)
                }
            }
            repeat(6) { meridian ->
                val longitude = meridian / 6.0 * TAU
                for (step in 0..70) {
                    val point = project(-PI / 2 + step / 70.0 * PI, longitude)
                    if (point.z >= 0) plot(point.x * 0.9, point.y * 0.9, 0.22 + 0.78 * point.z)
                }
            }
        }
    }

    private fun paintRibbon(time: Double): List<String> {
        val anchors = listOf(
            Point(-ASPECT * 0.92, sin(time * 1.1) * 0.65),
            Point(-ASPECT * 0.3, sin(time * 1.7 + 1) * 0.88),
            Point(ASPECT * 0.3, sin(time * 1.3 + 2) * 0.88),
            Point(ASPECT * 0.92, sin(time * 0.9 + 3) * 0.65),
        )
        return paintPlotted { plot ->
            for (band in -2..2) {
                for (step in 0..130) {
                    val s = step / 130.0
                    val m = 1 - s
                    val weights = doubleArrayOf(m * m * m, 3 * m * m * s, 3 * m * s * s, s * s * s)
                    val x = anchors.indices.sumOf { anchors[it].x * weights[it] }
                    val y = anchors.indices.sumOf { anchors[it].y * weights[it] }
                    val edge = 1 - abs(band) / 3.0
                    plot(x, y + band * 0.08, edge * (0.35 + 0.65 * sin(s * PI)))
                }
            }
        }
    }

    private fun cometField(u: Double, v: Double, time: Double): Double {
        val along = u * 0.82 - v * 0.57
        val across = u * 0.57 + v * 0.82
        var best = 0.0
        repeat(COMET_LANES) { laneIndex ->
            val cycle = positiveMod(time * 0.45 + laneIndex * 0.29, 1.0)
            val head = -2.4 + cycle * 5.2
            val lead = head - along
            val body = if (lead < 0) exp(-(lead * lead) / 0.02) else exp(-lead / 0.36)
            val lane = exp(-((across - (laneIndex - (COMET_LANES - 1) / 2.0) * 0.42) / 0.3).pow(2))
            best = max(best, body * lane)
        }
        val vignette = exp(-hypot(u * 0.6, v * 0.95).pow(5))
        return best * vignette * 1.3
    }

    private fun paintBounce(time: Double): List<String> = paintPlotted { plot ->
        for (step in 0..44) plot(step / 44.0 * ASPECT * 2 - ASPECT, 0.9, 0.12)
        for (ghost in 9 downTo 0) {
            val moment = time - ghost * 0.05
            val u = sin(moment * 1.05) * ASPECT * 0.72
            val v = 0.78 - abs(sin(moment * 3.1)) * 1.6
            val weight = (1 - ghost / 10.0).pow(2)
            var angle = 0.0
            while (angle < TAU) {
                var radius = 0.5
                while (radius <= 1.001) {
                    plot(u + cos(angle) * 0.17 * radius, v + sin(angle) * 0.17 * radius, weight)
                    radius += 0.5
                }
                angle += 0.5
            }
        }
    }

    private fun paintPendulum(time: Double): List<String> = paintPlotted { plot ->
        for (step in 0..60) plot(step / 60.0 * ASPECT * 1.7 - ASPECT * 0.85, -0.95, 0.09)
        repeat(9) { bob ->
            val u = -ASPECT * 0.78 + bob / 8.0 * ASPECT * 1.56
            val v = sin(time * (1.45 + bob * 0.13)) * 0.68
            plot(u, v, 1.0)
            plot(u, v - 0.15, 0.38)
            plot(u, v + 0.15, 0.38)
        }
    }

    private fun paintClock(time: Double): List<String> = paintPlotted { plot ->
        repeat(12) { tick ->
            val angle = tick / 12.0 * TAU
            plot(cos(angle) * 1.3, sin(angle) * 0.86, if (tick % 3 == 0) 0.75 else 0.28)
        }
        val minute = PI / 2 - time * 2.4
        val hour = PI / 2 - time * 0.2
        for (step in 0..30) {
            val fraction = step / 30.0
            plot(cos(minute) * 1.12 * fraction, -sin(minute) * 0.74 * fraction, 0.9)
            if (fraction <= 0.6) {
                plot(cos(hour) * 1.12 * fraction, -sin(hour) * 0.74 * fraction, 0.55)
            }
        }
        plot(0.0, 0.0, 1.0)
    }

    private fun paintField(time: Double, field: (Double, Double, Double) -> Double): List<String> =
        List(HEIGHT) { y ->
            buildString(WIDTH) {
                repeat(WIDTH) { x -> append(shade(field(fieldU(x), fieldV(y), time))) }
            }
        }

    private fun paintPlotted(draw: (((Double, Double, Double) -> Unit)) -> Unit): List<String> {
        val buffer = DoubleArray(WIDTH * HEIGHT)
        draw { u, v, weight ->
            if (weight > 0) {
                val gridX = ((u / ASPECT + 1) / 2) * WIDTH - 0.5
                val gridY = ((v + 1) / 2) * HEIGHT - 0.5
                val x0 = floor(gridX).toInt()
                val y0 = floor(gridY).toInt()
                for (dy in 0..1) for (dx in 0..1) {
                    val x = x0 + dx
                    val y = y0 + dy
                    if (x !in 0 until WIDTH || y !in 0 until HEIGHT) continue
                    val falloff = (1 - abs(gridX - x)) * (1 - abs(gridY - y))
                    if (falloff <= 0) continue
                    val index = y * WIDTH + x
                    buffer[index] = max(buffer[index], weight * min(1.0, falloff * 1.7))
                }
            }
        }
        return List(HEIGHT) { y ->
            buildString(WIDTH) {
                repeat(WIDTH) { x -> append(shade(buffer[y * WIDTH + x])) }
            }
        }
    }

    private fun fieldU(x: Int): Double = ((x + 0.5) / WIDTH * 2 - 1) * ASPECT
    private fun fieldV(y: Int): Double = (y + 0.5) / HEIGHT * 2 - 1
    private fun shade(value: Double): Char = RAMP[(clamp01(value) * (RAMP.length - 1)).roundToInt()]
    private fun clamp01(value: Double): Double = value.coerceIn(0.0, 1.0)
    private fun positiveMod(value: Double, divisor: Double): Double = ((value % divisor) + divisor) % divisor

    private data class Point(val x: Double, val y: Double)
    private data class Vertex(val x: Double, val y: Double, val z: Double)
    private data class Edge(val from: Int, val to: Int)

    private val CUBE_VERTICES = listOf(
        Vertex(-1.0, -1.0, -1.0), Vertex(1.0, -1.0, -1.0),
        Vertex(1.0, 1.0, -1.0), Vertex(-1.0, 1.0, -1.0),
        Vertex(-1.0, -1.0, 1.0), Vertex(1.0, -1.0, 1.0),
        Vertex(1.0, 1.0, 1.0), Vertex(-1.0, 1.0, 1.0),
    )
    private val CUBE_EDGES = listOf(
        Edge(0, 1), Edge(1, 2), Edge(2, 3), Edge(3, 0),
        Edge(4, 5), Edge(5, 6), Edge(6, 7), Edge(7, 4),
        Edge(0, 4), Edge(1, 5), Edge(2, 6), Edge(3, 7),
    )
    private val OCTAHEDRON_VERTICES = listOf(
        Vertex(1.35, 0.0, 0.0), Vertex(-1.35, 0.0, 0.0),
        Vertex(0.0, 1.35, 0.0), Vertex(0.0, -1.35, 0.0),
        Vertex(0.0, 0.0, 1.35), Vertex(0.0, 0.0, -1.35),
    )
    private val OCTAHEDRON_EDGES = listOf(
        Edge(0, 2), Edge(0, 3), Edge(0, 4), Edge(0, 5),
        Edge(1, 2), Edge(1, 3), Edge(1, 4), Edge(1, 5),
        Edge(2, 4), Edge(4, 3), Edge(3, 5), Edge(5, 2),
    )
}

/** Random selection with the same 70% recent-scene cooldown as the desktop. */
internal class AgentAsciiScenePicker(
    private val random: Random = Random.Default,
) {
    private val recent = ArrayDeque<AgentAsciiRenderer.Scene>()
    private val cooldown = floor(AgentAsciiRenderer.scenes.size * 0.7).toInt()

    @Synchronized
    fun pick(): AgentAsciiRenderer.Scene {
        val eligible = AgentAsciiRenderer.scenes.filterNot(recent::contains)
            .ifEmpty { AgentAsciiRenderer.scenes }
        val selected = eligible[random.nextInt(eligible.size)]
        recent.addLast(selected)
        while (recent.size > cooldown) recent.removeFirst()
        return selected
    }
}
