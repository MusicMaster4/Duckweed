package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class MobileTabColorStyleTest {
    @Test
    fun coloredCardsMatchTheDesktopRestingTabFill() {
        val surface = 0xff161b17.toInt()
        val moss = 0xff7be05a.toInt()

        assertEquals(0xff2e4a27.toInt(), MobileTabColorStyle.fillColor(surface, moss))
    }

    @Test
    fun cardsWithoutATabColorKeepTheNeutralSurface() {
        val surface = 0xff161b17.toInt()

        assertEquals(surface, MobileTabColorStyle.fillColor(surface, null))
    }
}
