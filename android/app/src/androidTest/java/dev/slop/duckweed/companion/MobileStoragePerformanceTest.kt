package dev.slop.duckweed.companion

import android.content.ContentValues
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Checks repeated sync writes and encrypted reads against real Android storage. */
@RunWith(AndroidJUnit4::class)
class MobileStoragePerformanceTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val pairId = "storage-regression"
    private val terminalId = "terminal"
    private val workspaceStore get() = WorkspaceStore(context)

    @Before
    fun reset() {
        context.deleteDatabase("duckweed-messages.db")
        workspaceStore.remove(pairId)
        workspaceStore.remove("other-storage-regression")
    }

    private fun snapshot() = WorkspaceSnapshot(
        pairId, 500L, listOf(RemoteProject(
            "project", "Storage regression", "H:/project", null,
            terminals = listOf(RemoteTerminal(
                terminalId, "Codex", "PowerShell", "Codex", null, "idle",
                mode = "conversation", completionSeq = 7L, unreadOnDesktop = true,
                conversation = listOf(
                    RemoteConversationMessage("user", 100L, "user", "Prompt"),
                    RemoteConversationMessage("older", 200L, "assistant", "Older response"),
                    RemoteConversationMessage("latest", 300L, "assistant", "Latest response"),
                    RemoteConversationMessage("stream", 400L, "assistant", "Still streaming", streaming = true),
                ),
            )),
        )),
    )

    @Test
    fun repeatedSnapshotsDoNotRewriteHistoryAndStillRepairLegacyRouting() {
        val value = snapshot()
        val latestId = "workspace:$pairId:$terminalId:latest"
        MessageStore(context).use { store ->
            assertEquals(emptyList<String>(), store.putSyncedConversation(value))
            assertEquals(3, store.conversation(pairId, terminalId).size)
            assertNull(store.message(latestId)?.readAt)
            assertEquals(200L, store.message("workspace:$pairId:$terminalId:older")?.readAt)
            val database = store.writableDatabase
            val encrypted = database.rawQuery("SELECT encrypted_payload FROM messages WHERE id = ?", arrayOf(latestId))
                .use { it.moveToFirst(); it.getString(0) }
            database.execSQL("CREATE TABLE routing_writes (count INTEGER NOT NULL)")
            database.execSQL("INSERT INTO routing_writes VALUES (0)")
            database.execSQL("CREATE TRIGGER count_routing_writes AFTER UPDATE OF pair_id, terminal_id, kind ON messages BEGIN UPDATE routing_writes SET count = count + 1; END")
            repeat(4) { store.putSyncedConversation(value) }
            val writes = database.rawQuery("SELECT count FROM routing_writes", null)
                .use { it.moveToFirst(); it.getInt(0) }
            assertEquals("Unchanged snapshot history should require no routing writes", 0, writes)
            val repeated = database.rawQuery("SELECT encrypted_payload FROM messages WHERE id = ?", arrayOf(latestId))
                .use { it.moveToFirst(); it.getString(0) }
            assertEquals(encrypted, repeated)

            store.markRead(latestId, 600L)
            database.update("messages", ContentValues().apply {
                putNull("pair_id"); putNull("terminal_id"); putNull("kind")
            }, "id = ?", arrayOf(latestId))
            database.execSQL("UPDATE routing_writes SET count = 0")
            store.putSyncedConversation(value)
            val repaired = store.message(latestId)!!
            assertEquals(600L, repaired.readAt)
            assertEquals(pairId, store.conversation(pairId, terminalId).last().pairId)
            assertEquals(1, database.rawQuery("SELECT count FROM routing_writes", null)
                .use { it.moveToFirst(); it.getInt(0) })

            val desktopRead = value.copy(projects = value.projects.map { project ->
                project.copy(terminals = project.terminals.map { it.copy(unreadOnDesktop = false, readCompletionSeq = 7L) })
            })
            store.putSyncedConversation(desktopRead)
            assertTrue(store.unreadConversationKeys().isEmpty())
        }
    }

    @Test
    fun approvalRefreshSelectsOnlyActiveAttentionMessagesIncludingLegacyRows() {
        MessageStore(context).use { store ->
            fun put(id: String, kind: String) = store.put(CompletionRecord(
                id, 100L, "Codex", "Storage regression", kind, "Response", null,
                pairId = pairId, terminalId = terminalId,
            ))
            put("active-attention", "attention")
            put("inactive-attention", "attention")
            put("active-completion", "completed")
            put("legacy-attention", "attention")
            store.writableDatabase.update("messages", ContentValues().apply { putNull("kind") }, "id = ?", arrayOf("legacy-attention"))
            val active = setOf("active-attention".hashCode(), "active-completion".hashCode(), "legacy-attention".hashCode())
            assertEquals(setOf("active-attention", "legacy-attention"), store.activeAttentionMessages(active).map { it.id }.toSet())
            assertTrue(store.activeAttentionMessages(emptySet()).isEmpty())
        }
    }

    @Test
    fun singleWorkspaceLookupPreservesHeartbeatAndDoesNotReadOtherPairings() {
        val value = snapshot()
        workspaceStore.put(value, 700L)
        workspaceStore.put(value.copy(pairId = "other-storage-regression", updatedAt = 900L), 900L)
        workspaceStore.markPresence(pairId, 1_000L)
        assertEquals(workspaceStore.all().first { it.pairId == pairId }, workspaceStore.get(pairId))
        assertEquals(1_000L, workspaceStore.get(pairId)?.lastSeenAt)
        assertNull(workspaceStore.get("missing-storage-regression"))
        workspaceStore.remove(pairId)
        assertNull(workspaceStore.get(pairId))
    }
}
