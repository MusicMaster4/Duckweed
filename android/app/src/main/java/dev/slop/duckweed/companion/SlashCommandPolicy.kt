package dev.slop.duckweed.companion

import java.util.Locale

data class SlashSuggestion(val value: String, val title: String, val description: String, val current: Boolean = false)

/** Pure filtering rules shared by the mobile slash-command picker and tests. */
object SlashCommandPolicy {
    fun matches(value: String, commands: List<RemoteSlashCommand>): List<RemoteSlashCommand> {
        if (!value.startsWith("/") || value.any(Char::isWhitespace)) return emptyList()
        val query = value.lowercase(Locale.ROOT).removePrefix("/")
        return commands.distinctBy { it.name }.filter {
            it.name.lowercase(Locale.ROOT).contains(query) || it.description.lowercase(Locale.ROOT).contains(query)
        }.sortedBy { if (it.name.lowercase(Locale.ROOT).removePrefix("/").startsWith(query)) 0 else 1 }
    }

    fun suggestions(value: String, commands: List<RemoteSlashCommand>): List<SlashSuggestion> {
        if (!value.startsWith("/") || value.contains('\n')) return emptyList()
        val separator = value.indexOfFirst(Char::isWhitespace)
        if (separator < 0) return matches(value, commands).map {
            SlashSuggestion(completion(it), it.name, it.description)
        }
        val command = commands.firstOrNull { it.name.equals(value.take(separator), ignoreCase = true) } ?: return emptyList()
        val argument = value.substring(separator + 1)
        // A completed choice has a trailing space; keep the menu out of the way.
        if (argument.isNotEmpty() && argument.last().isWhitespace()) return emptyList()
        val query = argument.trim().lowercase(Locale.ROOT)
        return command.options.filter {
            it.value.lowercase(Locale.ROOT).contains(query) || it.label.lowercase(Locale.ROOT).contains(query)
        }.map { SlashSuggestion("${command.name} ${it.value} ", it.label, it.description, it.current) }
    }

    fun isQuery(value: String, commands: List<RemoteSlashCommand>): Boolean =
        value.startsWith("/") && !value.contains('\n') &&
            (value.none(Char::isWhitespace) || commands.any {
                it.options.isNotEmpty() && value.startsWith("${it.name} ", ignoreCase = true) &&
                    (value.equals("${it.name} ", ignoreCase = true) || !value.last().isWhitespace())
            })

    fun completion(command: RemoteSlashCommand): String = "${command.name} "
}
