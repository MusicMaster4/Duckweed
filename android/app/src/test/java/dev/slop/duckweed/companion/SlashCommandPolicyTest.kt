package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class SlashCommandPolicyTest {
    @Test
    fun guidedArgumentsUseDesktopOptionsAndNeverSendOnSelection() {
        val model = RemoteSlashCommand("/model", "Choose a model", listOf(
            RemoteCommandOption("provider/fast", "Fast model", "Quick responses", true),
            RemoteCommandOption("provider/deep", "Deep model", "Complex tasks"),
        ))
        assertEquals(2, SlashCommandPolicy.suggestions("/model ", listOf(model)).size)
        val choice = SlashCommandPolicy.suggestions("/model deep", listOf(model)).single()
        assertEquals("/model provider/deep ", choice.value)
        assertEquals("Deep model", choice.title)
        assertEquals(emptyList<SlashSuggestion>(), SlashCommandPolicy.suggestions(choice.value, listOf(model)))
        assertEquals(true, SlashCommandPolicy.suggestions("/model fast", listOf(model)).single().current)
    }

    @Test
    fun searchUsesDescriptionsAndJsonPreservesChoices() {
        assertEquals(listOf(commands[1]), SlashCommandPolicy.matches("/change", commands))
        val command = RemoteSlashCommand("/effort", "Reasoning", listOf(RemoteCommandOption("high", "High", "", true)))
        assertEquals(command, SlashCommandJson.read(SlashCommandJson.write(command)))
        assertEquals(commands[0], SlashCommandJson.read(org.json.JSONObject("""{"name":"/new","description":"Start a new chat"}""")))
    }
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
