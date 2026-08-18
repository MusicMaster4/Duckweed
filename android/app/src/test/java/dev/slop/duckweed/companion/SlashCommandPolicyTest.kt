package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class SlashCommandPolicyTest {
    private val commands = listOf(
        RemoteSlashCommand("/new", "Start a new chat"),
        RemoteSlashCommand("/model", "Change model"),
        RemoteSlashCommand("/compact", "Compact context"),
    )

    @Test
    fun slashShowsOnlyMatchingCommandsForTheSelectedAgent() {
        assertEquals(commands, SlashCommandPolicy.matches("/", commands))
        assertEquals(listOf(commands[1]), SlashCommandPolicy.matches("/mo", commands))
        assertEquals(emptyList<RemoteSlashCommand>(), SlashCommandPolicy.matches("hello", commands))
    }

    @Test
    fun argumentEntryClosesTheCommandPicker() {
        assertEquals(emptyList<RemoteSlashCommand>(), SlashCommandPolicy.matches("/model ", commands))
        assertEquals("/model ", SlashCommandPolicy.completion(commands[1]))
    }
}
