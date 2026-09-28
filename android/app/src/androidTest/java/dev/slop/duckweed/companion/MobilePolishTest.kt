package dev.slop.duckweed.companion

import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class MobilePolishTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val pairId = "00000000-0000-4000-8000-000000000001"
    private val terminalId = "polish-terminal"
    private var now = 0L
    private val commands = listOf(
        RemoteSlashCommand("/new", "Start a new conversation"),
        RemoteSlashCommand("/model", "Choose a model", listOf(
            RemoteCommandOption("provider/fast", "Fast", "Quick everyday work", true),
            RemoteCommandOption("provider/deep", "Deep", "Complex coding tasks"),
        )),
        RemoteSlashCommand("/effort", "Change reasoning effort", listOf(
            RemoteCommandOption("low", "Low", "Faster responses"),
            RemoteCommandOption("high", "High", "More detailed reasoning", true),
        )),
    )
    private fun snapshot(at: Long = now, closed: Boolean = false) = WorkspaceSnapshot(pairId, at, listOf(
        RemoteProject("mobile", "Mobile experience", "H:/duckweed", "testing", "#45cec4", if (closed) emptyList() else listOf(
            RemoteTerminal(terminalId, "Codex", "PowerShell", "Codex", "Fast", "idle", mode = "conversation", commands = commands,
                conversation = listOf(RemoteConversationMessage("answer", now - 1000, "assistant", "The mobile sync update is ready to review."))),
        )),
        RemoteProject("api", "API improvements", "H:/api", "main", "#c98bf0", listOf(
            RemoteTerminal("api-terminal", "Claude", "PowerShell", "Claude", "Sonnet", "waiting", mode = "conversation"),
        )),
        RemoteProject("release", "Release checklist", "H:/duckweed", "release", terminals = listOf(
            RemoteTerminal("release-terminal", "Terminal", "PowerShell", null, null, "idle"),
        )),
    ))

    @Before fun seed() {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        }
        now = System.currentTimeMillis()
        context.deleteDatabase("duckweed-messages.db")
        WorkspaceStore(context).remove(pairId)
        DraftStore(context).save(pairId, terminalId, ConversationDraft("", null))
        SecretStore.save(context, PairCredentials(pairId, "https://127.0.0.1:1", "A".repeat(43), "B".repeat(43), "test-device", "Test device"))
        WorkspaceStore(context).put(snapshot())
    }

    @Test fun searchableListsAndFiltersKeepDesktopTitles() {
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            scenario.onActivity { it.findViewById<View>(R.id.nav_projects).performClick() }
            await { var ready = false; scenario.onActivity { ready = it.findViewById<RecyclerView>(R.id.project_list).adapter?.itemCount == 3 }; ready }
            instrumentation.waitForIdleSync()
            screenshot("mobile-tabs-polished.png")
            // A query cleared before its background diff finishes must not reappear.
            scenario.onActivity {
                it.findViewById<EditText>(R.id.project_search).setText("api")
                it.findViewById<EditText>(R.id.project_search).text.clear()
            }
            await { var ready = false; scenario.onActivity { ready = it.findViewById<RecyclerView>(R.id.project_list).adapter?.itemCount == 3 }; ready }
            scenario.onActivity { it.findViewById<EditText>(R.id.project_search).setText("mobile codex") }
            await { var ready = false; scenario.onActivity { ready = it.findViewById<RecyclerView>(R.id.project_list).adapter?.itemCount == 1 }; ready }
            scenario.onActivity { activity ->
                val list = activity.findViewById<RecyclerView>(R.id.project_list)
                assertEquals("Mobile experience", list.findViewHolderForAdapterPosition(0)!!.itemView.findViewById<TextView>(R.id.project_name).text.toString())
                activity.findViewById<EditText>(R.id.project_search).setText("does not exist")
                assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.projects_empty).visibility)
                activity.findViewById<View>(R.id.projects_empty_action).performClick()
                assertEquals("", activity.findViewById<EditText>(R.id.project_search).text.toString())
                activity.findViewById<View>(R.id.nav_conversations).performClick()
            }
            await { var ready = false; scenario.onActivity { ready = it.findViewById<View>(R.id.conversations_page).let { page -> page.isShown && page.alpha == 1f } }; ready }
            screenshot("mobile-conversations-polished.png")
            scenario.onActivity { it.findViewById<LinearLayout>(R.id.conversation_filters).getChildAt(1).performClick() }
            await { var ready = false; scenario.onActivity { ready = it.findViewById<RecyclerView>(R.id.conversations_list).adapter?.itemCount == 1 }; ready }
        }
    }

    @Test fun slashChoicesPersistAndStreamingDoesNotRebuildThePicker() {
        val message = CompletionRecord(id = "polish-message", pairId = pairId, sentAt = now, agent = "Codex",
            project = "Mobile experience", kind = "completed", response = "Ready", durationMs = null,
            projectId = "mobile", terminalId = terminalId)
        MessageStore(context).use { it.put(message); it.markNotified(message.id) }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("message_id", message.id)).use { scenario ->
            await { var ready = false; scenario.onActivity { ready = it.findViewById<EditText>(R.id.conversation_input).let { view -> view.isShown && view.isEnabled } }; ready }
            scenario.onActivity { activity ->
                assertEquals("Mobile experience", activity.findViewById<TextView>(R.id.conversation_title).text.toString())
                activity.findViewById<View>(R.id.conversation_command_button).performClick()
                val input = activity.findViewById<EditText>(R.id.conversation_input)
                input.setText("/model ")
                val rows = activity.findViewById<LinearLayout>(R.id.conversation_commands)
                assertEquals(2, rows.childCount)
                val first = rows.getChildAt(0)
                MainActivity::class.java.getDeclaredMethod("refreshConversation", Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(activity, false)
                assertSame(first, rows.getChildAt(0))
                rows.getChildAt(1).performClick()
                assertEquals("/model provider/deep ", input.text.toString())
                assertEquals(View.GONE, activity.findViewById<View>(R.id.conversation_commands_scroll).visibility)
                input.setText("/effort ")
            }
            instrumentation.waitForIdleSync()
            screenshot("mobile-command-choices.png")
            WorkspaceStore(context).put(snapshot(now + 1000, closed = true))
            NotificationTools.announceChanged(context)
            await { var closed = false; scenario.onActivity { closed = it.findViewById<TextView>(R.id.conversation_unavailable).text.contains("closed") }; closed }
            scenario.onActivity { assertFalse(it.findViewById<View>(R.id.conversation_send).isEnabled) }
        }
    }

    private fun screenshot(name: String) {
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(context.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }
    private fun await(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 15_000
        while (!predicate()) { check(System.currentTimeMillis() < deadline) { "UI did not settle" }; Thread.sleep(80) }
    }
}
