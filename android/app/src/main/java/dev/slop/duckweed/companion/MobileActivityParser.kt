package dev.slop.duckweed.companion

import org.json.JSONArray

internal fun parseFileChanges(json: JSONArray?): List<RemoteFileChange> {
    if (json == null) return emptyList()
    return (0 until json.length()).mapNotNull { index ->
        val item = json.optJSONObject(index) ?: return@mapNotNull null
        val path = item.optString("path").trim()
        if (path.isEmpty()) return@mapNotNull null
        RemoteFileChange(
            path = path,
            insertions = item.optInt("insertions").coerceAtLeast(0),
            deletions = item.optInt("deletions").coerceAtLeast(0),
            diff = item.optString("diff").trim().takeIf { it.isNotEmpty() },
        )
    }
}
