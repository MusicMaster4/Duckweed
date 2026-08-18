package dev.slop.duckweed.companion

import android.content.Context
import org.json.JSONObject

data class ConversationDraft(
    val text: String,
    val attachment: MobileImageAttachment?,
)

class DraftStore(context: Context) {
    private val preferences = context.getSharedPreferences("duckweed-conversation-drafts", Context.MODE_PRIVATE)

    fun load(pairId: String, terminalId: String): ConversationDraft = runCatching {
        val stored = preferences.getString(key(pairId, terminalId), null)
            ?: return ConversationDraft("", null)
        val json = JSONObject(String(SecretStore.decryptLocal(stored), Charsets.UTF_8))
        ConversationDraft(
            text = json.optString("text"),
            attachment = json.optJSONObject("attachment")?.let { attachment ->
                MobileImageAttachment(
                    id = attachment.getString("id"),
                    name = attachment.getString("name"),
                    mimeType = attachment.getString("mimeType"),
                    dataUrl = attachment.getString("dataUrl"),
                    size = attachment.getInt("size"),
                )
            },
        )
    }.getOrElse { ConversationDraft("", null) }

    fun save(pairId: String, terminalId: String, draft: ConversationDraft) {
        if (draft.text.isBlank() && draft.attachment == null) {
            clear(pairId, terminalId)
            return
        }
        val json = JSONObject().put("text", draft.text)
        draft.attachment?.let { attachment ->
            val dataUrl = attachment.dataUrl ?: return@let
            json.put(
                "attachment",
                JSONObject()
                    .put("id", attachment.id)
                    .put("name", attachment.name)
                    .put("mimeType", attachment.mimeType)
                    .put("dataUrl", dataUrl)
                    .put("size", attachment.size),
            )
        }
        val encrypted = SecretStore.encryptLocal(json.toString().toByteArray(Charsets.UTF_8))
        preferences.edit().putString(key(pairId, terminalId), encrypted).apply()
    }

    fun clear(pairId: String, terminalId: String) {
        preferences.edit().remove(key(pairId, terminalId)).apply()
    }

    private fun key(pairId: String, terminalId: String): String = "$pairId:$terminalId"
}
