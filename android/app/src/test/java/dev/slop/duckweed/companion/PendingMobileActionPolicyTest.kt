package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingMobileActionPolicyTest {
    @Test
    fun createRemainsPendingUntilANewTerminalAppears() {
        val action = action(
            id = "create-1",
            kind = PendingMobileAction.CREATE_TERMINAL,
            projectId = "project-1",
            baselineTerminalIds = setOf("terminal-1"),
        )

        assertEquals(
            listOf(action),
            PendingMobileActionPolicy.reconcile(
                listOf(action),
                listOf(snapshot("terminal-1")),
                now = 2_000L,
            ).pending,
        )
        assertTrue(
            "create-1" in PendingMobileActionPolicy.reconcile(
                listOf(action),
                listOf(snapshot("terminal-1", "terminal-2")),
                now = 2_000L,
            ).completedIds,
        )
    }

    @Test
    fun oneNewTerminalOnlyConfirmsOneConcurrentCreate() {
        val first = action(
            id = "create-1",
            kind = PendingMobileAction.CREATE_TERMINAL,
            projectId = "project-1",
            baselineTerminalIds = setOf("terminal-1"),
            createdAt = 1_000L,
        )
        val second = first.copy(id = "create-2", createdAt = 1_100L)
        val result = PendingMobileActionPolicy.reconcile(
            listOf(first, second),
            listOf(snapshot("terminal-1", "terminal-2")),
            now = 2_000L,
        )

        assertEquals(setOf("create-1"), result.completedIds)
        assertEquals(
            listOf(second.copy(baselineTerminalIds = setOf("terminal-1", "terminal-2"))),
            result.pending,
        )
        assertTrue(
            PendingMobileActionPolicy.reconcile(
                result.pending,
                listOf(snapshot("terminal-1", "terminal-2")),
                now = 2_100L,
            ).completedIds.isEmpty(),
        )
    }

    @Test
    fun closeAndDecisionWaitForTheirVisibleDesktopState() {
        val close = action(
            id = "close-1",
            kind = PendingMobileAction.CLOSE_TERMINAL,
            terminalId = "terminal-1",
        )
        val decision = action(
            id = "decision-1",
            kind = PendingMobileAction.DECISION,
            terminalId = "terminal-2",
            permissionId = "permission-1",
        )
        val waiting = snapshot(
            terminals = listOf(
                terminal("terminal-1"),
                terminal("terminal-2", permissionId = "permission-1"),
            ),
        )
        assertEquals(
            listOf(close, decision),
            PendingMobileActionPolicy.reconcile(listOf(close, decision), listOf(waiting), 2_000L).pending,
        )

        val confirmed = snapshot(terminals = listOf(terminal("terminal-2")))
        assertEquals(
            setOf("close-1", "decision-1"),
            PendingMobileActionPolicy.reconcile(listOf(close, decision), listOf(confirmed), 2_000L).completedIds,
        )
    }

    @Test
    fun abandonedActionsExpire() {
        val action = action(id = "old", kind = PendingMobileAction.CLOSE_TERMINAL)
        val now = PendingMobileActionPolicy.MAX_PENDING_AGE_MS + 1_001L
        val result = PendingMobileActionPolicy.reconcile(listOf(action), emptyList(), now)

        assertTrue(result.pending.isEmpty())
        assertEquals(setOf("old"), result.expiredIds)
    }

    private fun action(
        id: String,
        kind: String,
        projectId: String? = null,
        terminalId: String? = null,
        permissionId: String? = null,
        baselineTerminalIds: Set<String> = emptySet(),
        createdAt: Long = 1_000L,
    ) = PendingMobileAction(
        id = id,
        kind = kind,
        pairId = "pair-1",
        projectId = projectId,
        terminalId = terminalId,
        permissionId = permissionId,
        baselineTerminalIds = baselineTerminalIds,
        createdAt = createdAt,
    )

    private fun snapshot(vararg terminalIds: String): WorkspaceSnapshot =
        snapshot(terminals = terminalIds.map(::terminal))

    private fun snapshot(terminals: List<RemoteTerminal>): WorkspaceSnapshot = WorkspaceSnapshot(
        pairId = "pair-1",
        updatedAt = 1_500L,
        projects = listOf(
            RemoteProject(
                id = "project-1",
                name = "Project",
                path = "/project",
                branch = null,
                terminals = terminals,
            ),
        ),
    )

    private fun terminal(id: String, permissionId: String? = null) = RemoteTerminal(
        id = id,
        title = id,
        shell = "Terminal",
        agent = null,
        model = null,
        status = "idle",
        permission = permissionId?.let {
            RemotePermission(
                id = it,
                title = "Permission",
                detail = null,
                command = null,
                options = emptyList(),
            )
        },
    )
}
