package dev.slop.duckweed.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class WorkspaceStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("duckweed-workspaces", Context.MODE_PRIVATE)

    fun put(snapshot: WorkspaceSnapshot) {
        val projects = JSONArray()
        snapshot.projects.forEach { project ->
            val terminals = JSONArray()
            project.terminals.forEach { terminal ->
                terminals.put(
                    JSONObject()
                        .put("id", terminal.id)
                        .put("title", terminal.title)
                        .put("shell", terminal.shell)
                        .put("agent", terminal.agent)
                        .put("model", terminal.model)
                        .put("status", terminal.status),
                )
            }
            projects.put(
                JSONObject()
                    .put("id", project.id)
                    .put("name", project.name)
                    .put("path", project.path)
                    .put("branch", project.branch)
                    .put("terminals", terminals),
            )
        }
        val raw = JSONObject()
            .put("pairId", snapshot.pairId)
            .put("updatedAt", snapshot.updatedAt)
            .put("projects", projects)
            .toString()
            .toByteArray(Charsets.UTF_8)
        preferences.edit().putString(snapshot.pairId, SecretStore.encryptLocal(raw)).apply()
    }

    fun all(): List<WorkspaceSnapshot> = preferences.all.values.mapNotNull { stored ->
        val encrypted = stored as? String ?: return@mapNotNull null
        runCatching {
            val json = JSONObject(String(SecretStore.decryptLocal(encrypted), Charsets.UTF_8))
            val projectsJson = json.optJSONArray("projects") ?: JSONArray()
            WorkspaceSnapshot(
                pairId = json.getString("pairId"),
                updatedAt = json.getLong("updatedAt"),
                projects = (0 until projectsJson.length()).map { projectIndex ->
                    val project = projectsJson.getJSONObject(projectIndex)
                    val terminalsJson = project.optJSONArray("terminals") ?: JSONArray()
                    RemoteProject(
                        id = project.getString("id"),
                        name = project.optString("name", "Project"),
                        path = project.optString("path"),
                        branch = if (project.isNull("branch")) null else project.optString("branch").takeIf { it.isNotBlank() },
                        terminals = (0 until terminalsJson.length()).map { terminalIndex ->
                            val terminal = terminalsJson.getJSONObject(terminalIndex)
                            RemoteTerminal(
                                id = terminal.getString("id"),
                                title = terminal.optString("title", "Terminal"),
                                shell = terminal.optString("shell", "Terminal"),
                                agent = if (terminal.isNull("agent")) null else terminal.optString("agent").takeIf { it.isNotBlank() },
                                model = if (terminal.isNull("model")) null else terminal.optString("model").takeIf { it.isNotBlank() },
                                status = terminal.optString("status", "idle"),
                            )
                        },
                    )
                },
            )
        }.getOrNull()
    }.sortedByDescending { it.updatedAt }

    fun remove(pairId: String) {
        preferences.edit().remove(pairId).apply()
    }
}
