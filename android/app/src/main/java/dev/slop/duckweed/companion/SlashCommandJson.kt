package dev.slop.duckweed.companion

import org.json.JSONArray
import org.json.JSONObject

object SlashCommandJson {
    fun read(command: JSONObject): RemoteSlashCommand? {
        val name = command.optString("name").trim()
        if (!name.startsWith("/")) return null
        val options = command.optJSONArray("options") ?: JSONArray()
        return RemoteSlashCommand(name, command.optString("description").trim(),
            (0 until options.length()).mapNotNull { index ->
                val option = options.optJSONObject(index) ?: return@mapNotNull null
                val value = option.optString("value").trim().takeIf { it.isNotEmpty() } ?: return@mapNotNull null
                RemoteCommandOption(value, option.optString("label").ifBlank { value },
                    option.optString("description"), option.optBoolean("current"))
            })
    }

    fun write(command: RemoteSlashCommand): JSONObject = JSONObject()
        .put("name", command.name).put("description", command.description)
        .put("options", JSONArray().apply {
            command.options.forEach { option ->
                put(JSONObject().put("value", option.value).put("label", option.label)
                    .put("description", option.description).put("current", option.current))
            }
        })
}
