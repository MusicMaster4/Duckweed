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
                            .put("text", message.text)
                            .put("streaming", message.streaming),
                    )
                }
                val commands = JSONArray().apply {
                    terminal.commands.forEach { command ->
                        put(JSONObject().put("name", command.name).put("description", command.description))
                    }
                }
                val activity = JSONArray().apply {
                    terminal.activity.forEach { item ->
                        put(
                            JSONObject()
                                .put("id", item.id)
                                .put("at", item.at)
                                .put("kind", item.kind)
                                .put("title", item.title)
                                .put("detail", item.detail)
                                .put("command", item.command)
                                .put(
                                    "changes",
                                    JSONArray().apply {
                                        item.changes.forEach { change ->
                                            put(
                                                JSONObject()
                                                    .put("path", change.path)
                                                    .put("insertions", change.insertions)
                                                    .put("deletions", change.deletions)
                                                    .put("diff", change.diff),
                                            )
                                        }
                                    },
                                )
                                .put("planType", item.planType)
                                .put(
                                    "steps",
                                    JSONArray().apply {
                                        item.steps.forEach { step ->
                                            put(JSONObject().put("text", step.text).put("status", step.status))
                                        }
                                    },
                                )
                                .put("status", item.status),
                        )
                    }
                }
                val permission = terminal.permission?.let { pending ->
                    JSONObject()
                        .put("id", pending.id)
                        .put("kind", pending.kind)
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
                        .put(
                            "questions",
                            JSONArray().apply {
                                pending.questions.forEach { question ->
                                    put(
                                        JSONObject()
                                            .put("id", question.id)
                                            .put("header", question.header)
                                            .put("question", question.question)
                                            .put("multiSelect", question.multiSelect)
                                            .put(
                                                "options",
                                                JSONArray().apply {
                                                    question.options.forEach { option ->
                                                        put(
                                                            JSONObject()
                                                                .put("id", option.id)
                                                                .put("label", option.label)
                                                                .put("description", option.description)
                                                                .put("preview", option.preview),
                                                        )
                                                    }
                                                },
                                            ),
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
                        .put("mode", terminal.mode)
                        .put("terminalColumns", terminal.terminalColumns)
                        .put("terminalRows", terminal.terminalRows)
                        .put("unreadOnDesktop", terminal.unreadOnDesktop)
                        .put("completionSeq", terminal.completionSeq)
                        .put("commands", commands)
                        .put("activity", activity)
                        .put("conversation", conversation)
                        .put("permission", permission)
                        .put("terminalOutput", terminal.terminalOutput),
                )
            }
            projects.put(
                JSONObject()
                    .put("id", project.id)
                    .put("name", project.name)
                    .put("path", project.path)
                    .put("branch", project.branch)
                    .put("color", project.color)
                    .put("terminals", terminals),
            )
        }
        val usageLimits = UsageLimitsJson.write(snapshot.usageLimits)
        val raw = JSONObject()
            .put("pairId", snapshot.pairId)
            .put("updatedAt", snapshot.updatedAt)
            .put("presenceAt", snapshot.presenceAt ?: snapshot.updatedAt)
            .put("projects", projects)
            .put("usageLimits", usageLimits)
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
                        color = if (project.isNull("color")) null else project.optString("color").takeIf { it.isNotBlank() },
                        terminals = (0 until terminalsJson.length()).map { terminalIndex ->
                            val terminal = terminalsJson.getJSONObject(terminalIndex)
                            val conversationJson = terminal.optJSONArray("conversation") ?: JSONArray()
                            val commandsJson = terminal.optJSONArray("commands") ?: JSONArray()
                            val activityJson = terminal.optJSONArray("activity") ?: JSONArray()
                            val permissionJson = terminal.optJSONObject("permission")
                            val agent = if (terminal.isNull("agent")) null else {
                                terminal.optString("agent").takeIf { it.isNotBlank() }
                            }
                            val terminalOutput = if (terminal.isNull("terminalOutput")) null else {
                                terminal.optString("terminalOutput").takeIf { it.isNotBlank() }
                            }
                            val mode = terminal.optString("mode").takeIf {
                                it == "terminal" || it == "conversation"
                            } ?: if (terminalOutput != null || agent == null) "terminal" else "conversation"
                            RemoteTerminal(
                                id = terminal.getString("id"),
                                title = terminal.optString("title", "Terminal"),
                                shell = terminal.optString("shell", "Terminal"),
                                agent = agent,
                                model = if (terminal.isNull("model")) null else terminal.optString("model").takeIf { it.isNotBlank() },
                                status = terminal.optString("status", "idle"),
                                mode = mode,
                                terminalColumns = terminal.optInt("terminalColumns").takeIf { it > 0 },
                                terminalRows = terminal.optInt("terminalRows").takeIf { it > 0 },
                                unreadOnDesktop = if (terminal.has("unreadOnDesktop") && !terminal.isNull("unreadOnDesktop")) {
                                    terminal.optBoolean("unreadOnDesktop")
                                } else {
                                    null
                                },
                                completionSeq = terminal.optLong("completionSeq"),
                                commands = (0 until commandsJson.length()).mapNotNull { commandIndex ->
                                    val command = commandsJson.optJSONObject(commandIndex) ?: return@mapNotNull null
                                    val name = command.optString("name").trim()
                                    if (!name.startsWith("/")) return@mapNotNull null
                                    RemoteSlashCommand(name, command.optString("description").trim())
                                },
                                activity = parseAgentActivities(activityJson, json.optLong("updatedAt")),
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
                                        streaming = message.optBoolean("streaming", false),
                                    )
                                },
                                permission = parseRemotePermission(permissionJson),
                                terminalOutput = terminalOutput,
                            )
                        },
                    )
                },
                usageLimits = UsageLimitsJson.parse(json.optJSONArray("usageLimits")),
                presenceAt = if (json.has("presenceAt") && !json.isNull("presenceAt")) {
                    json.optLong("presenceAt")
                } else {
                    null
                },
            )
        }.getOrNull()
    }.sortedByDescending { it.updatedAt }

    fun markPresence(pairId: String, at: Long): Boolean {
        val stored = preferences.getString(pairId, null) ?: return false
        val json = runCatching {
            JSONObject(String(SecretStore.decryptLocal(stored), Charsets.UTF_8))
        }.getOrNull() ?: return false
        val previous = if (json.has("presenceAt") && !json.isNull("presenceAt")) {
            json.optLong("presenceAt")
        } else {
            json.optLong("updatedAt")
        }
        if (at <= previous) return false
        json.put("presenceAt", at)
        preferences.edit()
            .putString(pairId, SecretStore.encryptLocal(json.toString().toByteArray(Charsets.UTF_8)))
            .apply()
        return true
    }

    fun remove(pairId: String) {
        preferences.edit().remove(pairId).apply()
    }
}
