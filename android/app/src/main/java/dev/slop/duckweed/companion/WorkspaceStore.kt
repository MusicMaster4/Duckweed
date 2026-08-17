package dev.slop.duckweed.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class WorkspaceStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("duckweed-workspaces", Context.MODE_PRIVATE)

    fun put(snapshot: WorkspaceSnapshot): Boolean {
        val currentUpdatedAt = preferences.getString(snapshot.pairId, null)?.let { stored ->
            runCatching {
                JSONObject(String(SecretStore.decryptLocal(stored), Charsets.UTF_8))
                    .optLong("updatedAt")
            }.getOrNull()
        } ?: 0L
        if (currentUpdatedAt > snapshot.updatedAt) return false
        val projects = JSONArray()
        snapshot.projects.forEach { project ->
            val terminals = JSONArray()
            project.terminals.forEach { terminal ->
                val conversation = JSONArray()
                terminal.conversation.forEach { message ->
                    conversation.put(
                        JSONObject()
                            .put("id", message.id)
                            .put("sentAt", message.sentAt)
                            .put("role", message.role)
                            .put("text", message.text),
                    )
                }
                val permission = terminal.permission?.let { pending ->
                    JSONObject()
                        .put("id", pending.id)
                        .put("title", pending.title)
                        .put("detail", pending.detail)
                        .put("command", pending.command)
                        .put(
                            "options",
                            JSONArray().apply {
                                pending.options.forEach { option ->
                                    put(
                                        JSONObject()
                                            .put("id", option.id)
                                            .put("label", option.label)
                                            .put("kind", option.kind),
                                    )
                                }
                            },
                        )
                }
                terminals.put(
                    JSONObject()
                        .put("id", terminal.id)
                        .put("title", terminal.title)
                        .put("shell", terminal.shell)
                        .put("agent", terminal.agent)
                        .put("model", terminal.model)
                        .put("status", terminal.status)
                        .put("unreadOnDesktop", terminal.unreadOnDesktop)
                        .put("conversation", conversation)
                        .put("permission", permission),
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
        return true
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
                            val conversationJson = terminal.optJSONArray("conversation") ?: JSONArray()
                            val permissionJson = terminal.optJSONObject("permission")
                            RemoteTerminal(
                                id = terminal.getString("id"),
                                title = terminal.optString("title", "Terminal"),
                                shell = terminal.optString("shell", "Terminal"),
                                agent = if (terminal.isNull("agent")) null else terminal.optString("agent").takeIf { it.isNotBlank() },
                                model = if (terminal.isNull("model")) null else terminal.optString("model").takeIf { it.isNotBlank() },
                                status = terminal.optString("status", "idle"),
                                unreadOnDesktop = if (terminal.has("unreadOnDesktop") && !terminal.isNull("unreadOnDesktop")) {
                                    terminal.optBoolean("unreadOnDesktop")
                                } else {
                                    null
                                },
                                conversation = (0 until conversationJson.length()).mapNotNull { messageIndex ->
                                    val message = conversationJson.optJSONObject(messageIndex) ?: return@mapNotNull null
                                    val role = message.optString("role")
                                    val text = message.optString("text").trim()
                                    if ((role != "user" && role != "assistant") || text.isEmpty()) {
                                        return@mapNotNull null
                                    }
                                    RemoteConversationMessage(
                                        id = message.optString("id", "remote-$messageIndex"),
                                        sentAt = message.optLong("sentAt", json.optLong("updatedAt")),
                                        role = role,
                                        text = text,
                                    )
                                },
                                permission = permissionJson?.let { permission ->
                                    val optionsJson = permission.optJSONArray("options") ?: JSONArray()
                                    RemotePermission(
                                        id = permission.optString("id"),
                                        title = permission.optString("title", "Approval required"),
                                        detail = permission.optString("detail").takeIf { it.isNotBlank() },
                                        command = permission.optString("command").takeIf { it.isNotBlank() },
                                        options = (0 until optionsJson.length()).mapNotNull { optionIndex ->
                                            val option = optionsJson.optJSONObject(optionIndex) ?: return@mapNotNull null
                                            val id = option.optString("id")
                                            val label = option.optString("label")
                                            val kind = option.optString("kind")
                                            if (id.isBlank() || label.isBlank()) return@mapNotNull null
                                            RemotePermissionOption(id, label, kind)
                                        },
                                    ).takeIf { it.id.isNotBlank() && it.options.isNotEmpty() }
                                },
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
