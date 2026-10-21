package dev.slop.duckweed.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Prompt text and partial transfers use the same Keystore encryption as workspaces. */
class PromptTemplateStore(context: Context) {
    private val preferences = context.getSharedPreferences("duckweed-prompt-templates", Context.MODE_PRIVATE)
    private fun decode(raw: String) = JSONObject(String(SecretStore.decryptLocal(raw), Charsets.UTF_8))

    fun put(pairId: String, part: PromptTemplatesPart) = synchronized(LOCK) {
        val state = preferences.getString(pairId, null)?.let(::decode) ?: JSONObject()
        if (PromptTemplatesJson.merge(state, part)) {
            val encrypted = SecretStore.encryptLocal(state.toString().toByteArray(Charsets.UTF_8))
            // Acknowledgement happens only after both partial and committed data reach disk.
            check(preferences.edit().putString(pairId, encrypted).commit()) { "Could not save prompt templates" }
            CACHE.remove(pairId)
        }
    }

    fun all(pairIds: Set<String>): List<PromptTemplateRow> = synchronized(LOCK) {
        pairIds.sorted().flatMap { pairId ->
            preferences.getString(pairId, null)?.let { raw ->
                CACHE[pairId]?.takeIf { it.first == raw }?.second ?: run {
                    val state = decode(raw)
                    PromptTemplatesJson.readTemplates(state.optJSONArray("templates") ?: JSONArray())
                        .map { PromptTemplateRow(pairId, it) }.also { CACHE[pairId] = Pair(raw, it) }
                }
            }.orEmpty()
        }
    }

    fun remove(pairId: String) = synchronized(LOCK) {
        CACHE.remove(pairId)
        preferences.edit().remove(pairId).commit()
    }
    companion object {
        private val LOCK = Any()
        private val CACHE = mutableMapOf<String, Pair<String, List<PromptTemplateRow>>>()
    }
}
