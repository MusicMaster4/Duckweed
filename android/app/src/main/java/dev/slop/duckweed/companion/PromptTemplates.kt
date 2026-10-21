package dev.slop.duckweed.companion

import org.json.JSONArray
import org.json.JSONObject

data class RemotePromptTemplate(
    val id: String, val title: String, val content: String,
    val createdAt: Long, val updatedAt: Long,
)
data class PromptTemplatesPart(
    val sentAt: Long, val revision: String, val part: Int, val parts: Int,
    val templates: List<RemotePromptTemplate>,
)
data class PromptTemplateRow(val pairId: String, val template: RemotePromptTemplate)

object PromptTemplatesJson {
    fun readTemplates(array: JSONArray): List<RemotePromptTemplate> =
        (0 until array.length()).map { index ->
            val row = array.getJSONObject(index)
            val id = row.getString("id")
            val title = row.getString("title")
            val content = row.getString("content")
            require(id.isNotBlank() && title.isNotBlank() && content.isNotBlank())
            require(title.length <= 80 && content.length <= 20_000)
            RemotePromptTemplate(id, title, content, row.getLong("createdAt"), row.getLong("updatedAt"))
        }.also { require(it.size <= 200) }

    fun writeTemplates(templates: List<RemotePromptTemplate>) = JSONArray().apply {
        templates.forEach { row -> put(JSONObject().put("id", row.id).put("title", row.title)
            .put("content", row.content).put("createdAt", row.createdAt).put("updatedAt", row.updatedAt)) }
    }

    fun readPart(json: JSONObject): PromptTemplatesPart? {
        if (json.optString("kind") != "prompt_templates" || !json.has("templates")) return null
        val revision = json.getString("revision")
        val part = json.getInt("part")
        val parts = json.getInt("parts")
        require(revision.isNotBlank() && revision.length <= 64 && parts in 1..200 && part in 0 until parts)
        return PromptTemplatesPart(json.getLong("sentAt"), revision, part, parts, readTemplates(json.getJSONArray("templates")))
    }

    fun search(rows: List<PromptTemplateRow>, query: String): List<PromptTemplateRow> {
        val terms = query.lowercase(java.util.Locale.ROOT).split(Regex("\\s+")).filter { it.isNotBlank() }
        return rows.filter { row ->
            val text = "${row.template.title}\n${row.template.content}".lowercase(java.util.Locale.ROOT)
            terms.all { it in text }
        }
    }

    /** Only commit a complete revision. Delayed parts cannot roll back the library. */
    fun merge(state: JSONObject, incoming: PromptTemplatesPart): Boolean {
        if (incoming.sentAt <= state.optLong("committedAt", -1L)) return false
        val pendingAt = state.optLong("pendingAt", -1L)
        if (incoming.sentAt < pendingAt) return false
        if (incoming.sentAt == pendingAt && state.optString("revision") != incoming.revision) return false
        if (incoming.sentAt > pendingAt) {
            state.put("pendingAt", incoming.sentAt).put("revision", incoming.revision)
                .put("parts", incoming.parts).put("chunks", JSONObject())
        }
        require(state.getInt("parts") == incoming.parts)
        val chunks = state.getJSONObject("chunks")
        chunks.put(incoming.part.toString(), writeTemplates(incoming.templates))
        if ((0 until incoming.parts).all { chunks.has(it.toString()) }) {
            val templates = (0 until incoming.parts).flatMap { readTemplates(chunks.getJSONArray(it.toString())) }
            require(templates.size <= 200 && templates.map { it.id }.distinct().size == templates.size)
            state.put("templates", writeTemplates(templates)).put("committedAt", incoming.sentAt)
            state.remove("chunks")
            state.remove("pendingAt")
            state.remove("revision")
            state.remove("parts")
        }
        return true
    }
}
