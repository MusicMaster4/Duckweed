package dev.slop.duckweed.companion

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

data class PendingMobileAction(
    val id: String,
    val kind: String,
    val pairId: String,
    val projectId: String? = null,
    val terminalId: String? = null,
    val permissionId: String? = null,
    val label: String? = null,
    val baselineTerminalIds: Set<String> = emptySet(),
    val createdAt: Long,
) {
    companion object {
        const val CREATE_TERMINAL = "create_terminal"
        const val CLOSE_TERMINAL = "close_terminal"
        const val DECISION = "decision"
    }
}

data class PendingMobileActionReconciliation(
    val pending: List<PendingMobileAction>,
    val completedIds: Set<String>,
    val expiredIds: Set<String>,
)

object PendingMobileActionPolicy {
    const val MAX_PENDING_AGE_MS = 10 * 60 * 1_000L

    fun reconcile(
        actions: List<PendingMobileAction>,
        snapshots: List<WorkspaceSnapshot>,
        now: Long,
    ): PendingMobileActionReconciliation {
        val completed = mutableSetOf<String>()
        val expired = actions
            .filter { now - it.createdAt > MAX_PENDING_AGE_MS }
            .mapTo(mutableSetOf()) { it.id }
        val active = actions.filterNot { it.id in expired }
        val updatedActions = active.associateBy { it.id }.toMutableMap()
        val snapshotsByPair = snapshots.associateBy { it.pairId }

        active.filter { it.kind != PendingMobileAction.CREATE_TERMINAL }.forEach { action ->
            val snapshot = snapshotsByPair[action.pairId] ?: return@forEach
            val terminal = snapshot.projects
                .asSequence()
                .flatMap { it.terminals.asSequence() }
                .firstOrNull { it.id == action.terminalId }
            when (action.kind) {
                PendingMobileAction.CLOSE_TERMINAL -> if (terminal == null) completed += action.id
                PendingMobileAction.DECISION -> if (
                    terminal == null || terminal.permission?.id != action.permissionId
                ) completed += action.id
            }
        }

        active.filter { it.kind == PendingMobileAction.CREATE_TERMINAL }
            .groupBy { Pair(it.pairId, it.projectId) }
            .forEach { (scope, scopedActions) ->
                val project = snapshotsByPair[scope.first]
                    ?.projects
                    ?.firstOrNull { it.id == scope.second }
                    ?: return@forEach
                val currentIds = project.terminals.mapTo(linkedSetOf()) { it.id }
                val claimedIds = mutableSetOf<String>()
                scopedActions.sortedBy { it.createdAt }.forEach { action ->
                    val createdTerminal = currentIds.firstOrNull {
                        it !in action.baselineTerminalIds && it !in claimedIds
                    }
                    if (createdTerminal != null) {
                        claimedIds += createdTerminal
                        completed += action.id
                    }
                }
                if (claimedIds.isNotEmpty()) {
                    scopedActions
                        .filterNot { it.id in completed }
                        .forEach { action ->
                            updatedActions[action.id] = action.copy(
                                baselineTerminalIds = action.baselineTerminalIds + claimedIds,
                            )
                        }
                }
            }

        return PendingMobileActionReconciliation(
            pending = active
                .filterNot { it.id in completed }
                .map { updatedActions.getValue(it.id) },
            completedIds = completed,
            expiredIds = expired,
        )
    }
}

class PendingMobileActionStore(private val context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    @Synchronized
    fun all(): List<PendingMobileAction> = runCatching {
        val stored = preferences.getString(VALUE, null) ?: return emptyList()
        val json = JSONArray(String(SecretStore.decryptLocal(stored), Charsets.UTF_8))
        (0 until json.length()).mapNotNull { index -> fromJson(json.optJSONObject(index)) }
    }.getOrDefault(emptyList())

    @Synchronized
    fun put(action: PendingMobileAction) {
        write(all().filterNot { it.id == action.id } + action)
    }

    @Synchronized
    fun remove(id: String) {
        write(all().filterNot { it.id == id })
    }

    @Synchronized
    fun replace(actions: List<PendingMobileAction>) {
        write(actions)
    }

    @Synchronized
    fun removePair(pairId: String) {
        write(all().filterNot { it.pairId == pairId })
    }

    private fun write(actions: List<PendingMobileAction>) {
        if (actions.isEmpty()) {
            preferences.edit().remove(VALUE).apply()
            return
        }
        val json = JSONArray()
        actions.forEach { action ->
            json.put(
                JSONObject()
                    .put("id", action.id)
                    .put("kind", action.kind)
                    .put("pairId", action.pairId)
                    .put("projectId", action.projectId)
                    .put("terminalId", action.terminalId)
                    .put("permissionId", action.permissionId)
                    .put("label", action.label)
                    .put("baselineTerminalIds", JSONArray(action.baselineTerminalIds.toList()))
                    .put("createdAt", action.createdAt),
            )
        }
        val encrypted = SecretStore.encryptLocal(json.toString().toByteArray(Charsets.UTF_8))
        preferences.edit().putString(VALUE, encrypted).apply()
    }

    private fun fromJson(json: JSONObject?): PendingMobileAction? {
        json ?: return null
        val id = json.optString("id").takeIf { it.isNotBlank() } ?: return null
        val kind = json.optString("kind").takeIf {
            it == PendingMobileAction.CREATE_TERMINAL ||
                it == PendingMobileAction.CLOSE_TERMINAL ||
                it == PendingMobileAction.DECISION
        } ?: return null
        val pairId = json.optString("pairId").takeIf { it.isNotBlank() } ?: return null
        val baseline = json.optJSONArray("baselineTerminalIds") ?: JSONArray()
        return PendingMobileAction(
            id = id,
            kind = kind,
            pairId = pairId,
            projectId = json.optionalString("projectId"),
            terminalId = json.optionalString("terminalId"),
            permissionId = json.optionalString("permissionId"),
            label = json.optionalString("label"),
            baselineTerminalIds = (0 until baseline.length())
                .mapNotNull { baseline.optString(it).takeIf(String::isNotBlank) }
                .toSet(),
            createdAt = json.optLong("createdAt"),
        )
    }

    private fun JSONObject.optionalString(name: String): String? =
        if (isNull(name)) null else optString(name).takeIf { it.isNotBlank() }

    companion object {
        private const val PREFERENCES = "duckweed-pending-mobile-actions"
        private const val VALUE = "actions"
    }
}
