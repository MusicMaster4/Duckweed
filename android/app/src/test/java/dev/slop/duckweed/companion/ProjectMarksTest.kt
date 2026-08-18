package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ProjectMarksTest {
    private val projects = listOf(
        ProjectMarkIdentity("desktop-a/project", "Duckweed"),
        ProjectMarkIdentity("desktop-b/project", "Duckweed"),
        ProjectMarkIdentity("desktop-a/api", "API"),
    )

    @Test
    fun marksAreUniqueEvenWhenProjectNamesMatch() {
        val marks = ProjectMarks.assign(projects)
        assertEquals(projects.size, marks.values.toSet().size)
        assertNotEquals(marks[projects[0].key], marks[projects[1].key])
    }

    @Test
    fun marksDoNotDependOnListOrder() {
        assertEquals(ProjectMarks.assign(projects), ProjectMarks.assign(projects.reversed()))
    }
}
