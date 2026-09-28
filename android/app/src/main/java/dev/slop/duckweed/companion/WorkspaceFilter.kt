package dev.slop.duckweed.companion

import java.util.Locale

enum class ConversationFilter { ALL, NEEDS_YOU, UNREAD }

object WorkspaceFilter {
    private fun matches(query: String, values: List<String?>): Boolean {
        val terms = query.trim().lowercase(Locale.ROOT).split(Regex("\\s+")).filter(String::isNotEmpty)
        val haystack = values.filterNotNull().joinToString(" ").lowercase(Locale.ROOT)
        return terms.all(haystack::contains)
    }

    fun project(row: ProjectRow, query: String): Boolean = matches(query,
        listOf(row.project.name, row.project.path, row.project.branch) +
            row.project.terminals.flatMap { listOf(it.title, it.agent, it.model) })

    fun conversation(target: ConversationTarget, query: String, filter: ConversationFilter): Boolean =
        (filter != ConversationFilter.NEEDS_YOU || target.terminal.permission != null || target.terminal.status == "waiting") &&
            (filter != ConversationFilter.UNREAD || target.unread) &&
            matches(query, listOf(target.projectName, target.terminal.title, target.terminal.agent, target.terminal.model))
}
