package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DuckAsciiRendererTest {
    @Test
    fun `desktop renderer port keeps aligned changing layers`() {
        val layout = DuckAsciiRenderer.layout(240.0, 86.0, 4.2, 7.7)
        val first = DuckAsciiRenderer.render(layout, 0.0)
        val later = DuckAsciiRenderer.render(layout, 0.7)

        assertEquals(layout.rows, first.duck.size)
        assertEquals(layout.rows, first.water.size)
        assertTrue(first.duck.all { it.length == layout.cols })
        assertTrue(first.water.all { it.length == layout.cols })
        assertTrue(first.duck.any { it.isNotBlank() })
        assertTrue(first.water.any { it.isNotBlank() })
        assertNotEquals(first.duck, later.duck)
        assertNotEquals(first.water, later.water)
    }

    @Test
    fun `font sizing matches desktop breakpoints`() {
        assertEquals(7, DuckAsciiRenderer.fontSize(240.0, 86.0))
        assertEquals(16, DuckAsciiRenderer.fontSize(1200.0, 500.0))
    }
}
