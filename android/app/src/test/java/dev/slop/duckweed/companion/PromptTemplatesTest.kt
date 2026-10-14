package dev.slop.duckweed.companion

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PromptTemplatesTest {
    private fun prompt(id: String, content: String = "Review this code\nKeep all spacing. \uD83E\uDD86") =
        RemotePromptTemplate(id, "Code review", content, 1, 2)
    private fun part(at: Long, index: Int = 0, count: Int = 1, rows: List<RemotePromptTemplate> = listOf(prompt("a"))) =
        PromptTemplatesPart(at, "revision-$at", index, count, rows)
    private fun rows(state: JSONObject) = PromptTemplatesJson.readTemplates(state.getJSONArray("templates"))

    @Test fun fullTextSurvivesJsonAndSearchFindsContent() {
        val original = prompt("a", "a\n\t\"\uD83E\uDD86".repeat(2_000))
        assertEquals(listOf(original), PromptTemplatesJson.readTemplates(JSONArray(PromptTemplatesJson.writeTemplates(listOf(original)).toString())))
        val row = PromptTemplateRow("desktop", original)
        assertEquals(listOf(row), PromptTemplatesJson.search(listOf(row), "CODE \uD83E\uDD86"))
        assertTrue(PromptTemplatesJson.search(listOf(row), "missing").isEmpty())
    }
    @Test fun outOfOrderPartsCommitOnlyWhenComplete() {
        val state = JSONObject()
        PromptTemplatesJson.merge(state, part(10, 1, 2, listOf(prompt("b"))))
        assertFalse(state.has("templates"))
        PromptTemplatesJson.merge(state, part(10, 0, 2))
        assertEquals(listOf("a", "b"), rows(state).map { it.id })
    }
    @Test fun editAndDeleteReplaceTheLibrary() {
        val state = JSONObject()
        PromptTemplatesJson.merge(state, part(10, rows = listOf(prompt("a"), prompt("b"))))
        PromptTemplatesJson.merge(state, part(20, rows = listOf(prompt("a", "Edited"))))
        assertEquals(listOf(prompt("a", "Edited")), rows(state))
        PromptTemplatesJson.merge(state, part(30, rows = emptyList()))
        assertTrue(rows(state).isEmpty())
    }
    @Test fun stalePartsAndDuplicateDeliveriesCannotRestoreDeletedPrompts() {
        val state = JSONObject()
        PromptTemplatesJson.merge(state, part(20, rows = emptyList()))
        assertFalse(PromptTemplatesJson.merge(state, part(10)))
        assertFalse(PromptTemplatesJson.merge(state, part(20)))
        assertTrue(rows(state).isEmpty())
    }
    @Test fun newRevisionDiscardsIncompleteTransferAndKeepsCommittedPromptsVisible() {
        val state = JSONObject()
        PromptTemplatesJson.merge(state, part(10))
        PromptTemplatesJson.merge(state, part(20, 0, 2, listOf(prompt("b"))))
        assertEquals(listOf("a"), rows(state).map { it.id })
        PromptTemplatesJson.merge(state, part(30, 1, 2, listOf(prompt("d"))))
        assertFalse(PromptTemplatesJson.merge(state, part(20, 1, 2)))
        // Partial transfers survive a process restart.
        val restored = JSONObject(state.toString())
        PromptTemplatesJson.merge(restored, part(30, 0, 2, listOf(prompt("c"))))
        assertEquals(listOf("c", "d"), rows(restored).map { it.id })
    }
    @Test fun previewIsNotAnEmptyLibrary() {
        assertNull(PromptTemplatesJson.readPart(JSONObject().put("kind", "prompt_templates")))
    }
    @Test(expected = IllegalArgumentException::class) fun invalidPartCountIsRejected() {
        PromptTemplatesJson.readPart(JSONObject().put("kind", "prompt_templates").put("revision", "v")
            .put("sentAt", 1).put("part", 0).put("parts", 201).put("templates", JSONArray()))
    }
}
