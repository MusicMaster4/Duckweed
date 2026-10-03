package dev.slop.duckweed.companion

import org.junit.Assert.*
import org.junit.Test

class WorkspaceFilterTest {
    private val terminal = RemoteTerminal("t", "Terminal", "PowerShell", "Codex", "Fast", "waiting")
    private val target = ConversationTarget("p", "tab", "Duckweed mobile", null, terminal, unread = true)

    @Test fun searchCombinesTermsAcrossTabAndAgentMetadata() {
        assertTrue(WorkspaceFilter.conversation(target, "mobile codex", ConversationFilter.ALL))
        assertFalse(WorkspaceFilter.conversation(target, "other", ConversationFilter.ALL))
        assertTrue(WorkspaceFilter.conversation(target, "", ConversationFilter.NEEDS_YOU))
        assertTrue(WorkspaceFilter.conversation(target, "", ConversationFilter.UNREAD))
        assertFalse(WorkspaceFilter.conversation(target.copy(unread = false), "", ConversationFilter.UNREAD))
        assertFalse(WorkspaceFilter.conversation(target.copy(terminal = terminal.copy(status = "idle")), "", ConversationFilter.NEEDS_YOU))
    }
}
