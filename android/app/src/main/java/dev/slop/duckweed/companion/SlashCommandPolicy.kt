package dev.slop.duckweed.companion

/** Pure filtering rules shared by the mobile slash-command picker and tests. */
object SlashCommandPolicy {
    fun matches(value: String, commands: List<RemoteSlashCommand>): List<RemoteSlashCommand> {
        if (!value.startsWith("/") || value.any(Char::isWhitespace)) return emptyList()
        val query = value.lowercase()
        return commands.filter { it.name.lowercase().startsWith(query) }
    }

    fun completion(command: RemoteSlashCommand): String = "${command.name} "
}
