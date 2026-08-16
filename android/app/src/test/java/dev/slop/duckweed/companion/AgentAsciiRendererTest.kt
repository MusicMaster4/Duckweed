package dev.slop.duckweed.companion

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AgentAsciiRendererTest {
    @Test
    fun `all mobile scenes fill the shared desktop grid and move`() {
        AgentAsciiRenderer.scenes.forEach { scene ->
            val first = AgentAsciiRenderer.render(scene, 0.31)
            val later = AgentAsciiRenderer.render(scene, 1.17)

            assertEquals(AgentAsciiRenderer.HEIGHT, first.size)
            assertTrue(first.all { it.length == AgentAsciiRenderer.WIDTH })
            assertTrue(first.any { row -> row.any { !it.isWhitespace() } })
            assertNotEquals("$scene should animate", first, later)
        }
    }

    @Test
    fun `picker avoids recently used scenes`() {
        val picker = AgentAsciiScenePicker(Random(7))
        val firstSeven = List(7) { picker.pick() }

        assertEquals(7, firstSeven.distinct().size)
        assertTrue(picker.pick() !in firstSeven)
    }

    @Test
    fun `scene scale stays close to the duck on a phone sized surface`() {
        assertEquals(9, AgentAsciiRenderer.fontSize(320.0, 120.0))
        assertEquals(7, AgentAsciiRenderer.fontSize(240.0, 86.0))
    }
}
