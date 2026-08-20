package dev.slop.duckweed.companion

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileActivityParserTest {
    @Test
    fun `parses one plan with all of its tracker steps`() {
        val activities = parseAgentActivities(
            JSONArray(
                """[{"id":"plan-1","at":20,"kind":"plan","title":"Ship mobile UI","planType":"tasks","status":"running","steps":[{"text":"Inspect","status":"done"},{"text":"Implement","status":"running"}]}]""",
            ),
            fallbackAt = 10,
        )

        assertEquals(1, activities.size)
        assertEquals("plan-1", activities.single().id)
        assertEquals(listOf("Inspect", "Implement"), activities.single().steps.map { it.text })
        assertEquals("tasks", activities.single().planType)
    }

    @Test
    fun `parses agent questions with single multi select and notes metadata`() {
        val permission = parseRemotePermission(
            JSONObject(
                """{
                  "id":"permission-1",
                  "kind":"question",
                  "title":"Choose an approach",
                  "options":[{"id":"deny","label":"Skip","kind":"reject"}],
                  "questions":[
                    {
                      "id":"q0",
                      "header":"Database",
                      "question":"Which database should we use?",
                      "multiSelect":false,
                      "options":[{"id":"postgres","label":"PostgreSQL","description":"Use the existing cluster","preview":null}]
                    },
                    {
                      "id":"q1",
                      "header":"Scope",
                      "question":"Which features should ship?",
                      "multiSelect":true,
                      "options":[{"id":"search","label":"Search","description":"Full text","preview":"rg query"}]
                    }
                  ]
                }""",
            ),
        )

        assertNotNull(permission)
        assertEquals("question", permission?.kind)
        assertEquals(2, permission?.questions?.size)
        assertTrue(permission?.questions?.last()?.multiSelect == true)
        assertEquals("rg query", permission?.questions?.last()?.options?.single()?.preview)
    }

    @Test
    fun `rejects an empty question permission`() {
        assertNull(
            parseRemotePermission(
                JSONObject(
                    """{"id":"permission-1","kind":"question","title":"Question","options":[],"questions":[]}""",
                ),
            ),
        )
    }
}
