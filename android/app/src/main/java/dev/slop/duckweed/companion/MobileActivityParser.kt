package dev.slop.duckweed.companion

import org.json.JSONArray
import org.json.JSONObject

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

internal fun parseAgentActivities(json: JSONArray?, fallbackAt: Long): List<RemoteAgentActivity> {
    if (json == null) return emptyList()
    return (0 until json.length()).mapNotNull { index ->
        val item = json.optJSONObject(index) ?: return@mapNotNull null
        val id = item.optString("id").trim()
        val title = item.optString("title").trim()
        val kind = item.optString("kind")
        val status = item.optString("status")
        if (id.isEmpty() || title.isEmpty() || kind !in setOf("thinking", "tool", "plan")) {
            return@mapNotNull null
        }
        val stepsJson = item.optJSONArray("steps") ?: JSONArray()
        val steps = (0 until stepsJson.length()).mapNotNull { stepIndex ->
            val step = stepsJson.optJSONObject(stepIndex) ?: return@mapNotNull null
            val text = step.optString("text").trim()
            val stepStatus = step.optString("status")
            if (text.isEmpty() || stepStatus !in setOf("pending", "running", "done")) {
                return@mapNotNull null
            }
            RemotePlanStep(text, stepStatus)
        }
        if (kind == "plan" && steps.isEmpty()) return@mapNotNull null
        RemoteAgentActivity(
            id = id,
            at = item.optLong("at", fallbackAt),
            kind = kind,
            title = title,
            detail = item.optString("detail").trim().takeIf { it.isNotEmpty() },
            command = item.optString("command").trim().takeIf { it.isNotEmpty() },
            changes = parseFileChanges(item.optJSONArray("changes")),
            status = status.takeIf { it in setOf("pending", "running", "done", "error") } ?: "done",
            planType = item.optString("planType").takeIf { it == "tasks" || it == "workflow" },
            steps = steps,
        )
    }
}

internal fun parseRemotePermission(permission: JSONObject?): RemotePermission? {
    permission ?: return null
    val optionsJson = permission.optJSONArray("options") ?: JSONArray()
    val options = (0 until optionsJson.length()).mapNotNull { optionIndex ->
        val option = optionsJson.optJSONObject(optionIndex) ?: return@mapNotNull null
        val id = option.optString("id").trim()
        val label = option.optString("label").trim()
        val kind = option.optString("kind")
        if (id.isEmpty() || label.isEmpty() || kind !in setOf(
                "allow", "allow-always", "reject", "reject-always",
            )
        ) return@mapNotNull null
        RemotePermissionOption(id, label, kind)
    }
    val questionsJson = permission.optJSONArray("questions") ?: JSONArray()
    val questions = (0 until questionsJson.length()).mapNotNull { questionIndex ->
        val question = questionsJson.optJSONObject(questionIndex) ?: return@mapNotNull null
        val id = question.optString("id").trim()
        val prompt = question.optString("question").trim()
        if (id.isEmpty() || prompt.isEmpty()) return@mapNotNull null
        val questionOptions = question.optJSONArray("options") ?: JSONArray()
        RemoteQuestion(
            id = id,
            header = question.optString("header").trim(),
            question = prompt,
            multiSelect = question.optBoolean("multiSelect", false),
            options = (0 until questionOptions.length()).mapNotNull { optionIndex ->
                val option = questionOptions.optJSONObject(optionIndex) ?: return@mapNotNull null
                val optionId = option.optString("id").trim()
                val label = option.optString("label").trim()
                if (optionId.isEmpty() || label.isEmpty()) return@mapNotNull null
                RemoteQuestionOption(
                    id = optionId,
                    label = label,
                    description = option.optString("description").trim(),
                    preview = option.optString("preview").trim().takeIf { it.isNotEmpty() },
                )
            },
        )
    }
    val kind = permission.optString("kind", "approval").takeIf {
        it == "approval" || it == "question"
    } ?: "approval"
    return RemotePermission(
        id = permission.optString("id").trim(),
        title = permission.optString("title", "Approval required"),
        detail = permission.optString("detail").takeIf { it.isNotBlank() },
        command = permission.optString("command").takeIf { it.isNotBlank() },
        options = options,
        kind = kind,
        questions = questions,
    ).takeIf {
        it.id.isNotBlank() && if (kind == "question") questions.isNotEmpty() else options.isNotEmpty()
    }
}
