package dev.slop.duckweed.companion

import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class MobileRedesignTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val pairId = "00000000-0000-4000-8000-000000000011"
    private val terminalId = "redesign-terminal"
    private var now = 0L

    @Before fun seed() {
        now = System.currentTimeMillis()
        if (android.os.Build.VERSION.SDK_INT >= 33) instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        SecretStore.loadAll(context).forEach { WorkspaceStore(context).remove(it.pairId) }
        context.deleteDatabase("duckweed-messages.db")
        SecretStore.save(context, PairCredentials(pairId, "https://127.0.0.1:1", "A".repeat(43), "B".repeat(43), "redesign", "Test desktop"))
        DraftStore(context).save(pairId, terminalId, ConversationDraft("", null))
        WorkspaceStore(context).put(snapshot("codex"))
    }

    @After fun removeFixture() {
        WorkspaceStore(context).remove(pairId)
        SecretStore.remove(context, pairId)
        DraftStore(context).save(pairId, terminalId, ConversationDraft("", null))
    }

    private fun snapshot(provider: String, text: String = "Reviewing the synchronization paths.", at: Long = now): WorkspaceSnapshot {
        val items = JSONArray()
            .put(JSONObject().put("id", "user").put("at", now - 2000).put("kind", "user").put("text", "Improve mobile sync and agent controls."))
            .put(JSONObject().put("id", "plan").put("at", now - 1500).put("kind", "plan").put("steps", JSONArray()
                .put(JSONObject().put("text", "Inspect the relay").put("status", "done"))
                .put(JSONObject().put("text", "Connect the mobile controls").put("status", "running"))))
            .put(JSONObject().put("id", "reasoning").put("at", now - 1000).put("kind", "thinking").put("text", text).put("streaming", true))
            .put(JSONObject().put("id", "tool").put("at", now - 500).put("kind", "tool").put("name", "read").put("tool", "read")
                .put("callId", "read-call").put("title", "Read relay/index.ts").put("output", "Workspace delivery inspected").put("status", "done").put("changes", JSONArray()))
            .put(JSONObject().put("id", "answer").put("at", now).put("kind", "assistant").put("text", if (text == "Reviewing the synchronization paths.") "The conversation now follows the desktop agent." else text).put("streaming", false))
        val experience = JSONObject().put("termId", terminalId).put("agent", provider).put("program", provider).put("label", provider.replaceFirstChar { it.uppercase() })
            .put("mark", "CX").put("accent", "#9aa5b1").put("status", "working").put("started", true)
            .put("sessionId", "fixture-$provider").put("conversationEpoch", "user").put("cwd", "C:/duckweed")
            .put("model", "Fast").put("effort", "high").put("workStartedAt", now - 2000).put("items", items).toString()
        return WorkspaceSnapshot(pairId, at, listOf(RemoteProject("project", "Mobile redesign", "C:/duckweed", "testing", "#45cec4",
            listOf(RemoteTerminal(terminalId, "Codex", "PowerShell", provider, "Fast", "working", mode = "conversation", experience = experience,
                commands = listOf(RemoteSlashCommand("/model", "Model", listOf(RemoteCommandOption("fast", "Fast", "", true))),
                    RemoteSlashCommand("/effort", "Effort", listOf(RemoteCommandOption("high", "High", "", true)))),
                conversation = listOf(RemoteConversationMessage("answer", now, "assistant", "The conversation now follows the desktop agent.")))))))
    }

    @Test fun conversationsOpenFirstAndKeyboardClosesWhenLeaving() {
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            await { var ready = false; scenario.onActivity { ready = it.findViewById<RecyclerView>(R.id.conversations_list).adapter?.itemCount == 1 }; ready }
            scenario.onActivity {
                assertTrue(it.findViewById<View>(R.id.nav_conversations).isSelected)
                assertTrue(it.findViewById<View>(R.id.conversations_page).isShown)
                it.findViewById<RecyclerView>(R.id.conversations_list).findViewHolderForAdapterPosition(0)!!.itemView.performClick()
            }
            await { var ready = false; scenario.onActivity { ready = it.findViewById<EditText>(R.id.conversation_input).isEnabled }; ready }
            scenario.onActivity {
                val input = it.findViewById<EditText>(R.id.conversation_input)
                input.setText("Keep this draft")
                input.requestFocus()
                it.getSystemService(InputMethodManager::class.java).showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
            }
            await { var visible = false; scenario.onActivity { visible = ViewCompat.getRootWindowInsets(it.findViewById(R.id.app_root))?.isVisible(WindowInsetsCompat.Type.ime()) == true }; visible }
            scenario.onActivity { it.findViewById<View>(R.id.conversation_back).performClick() }
            await { var hidden = false; scenario.onActivity { hidden = ViewCompat.getRootWindowInsets(it.findViewById(R.id.app_root))?.isVisible(WindowInsetsCompat.Type.ime()) == false }; hidden }
            scenario.onActivity { assertTrue(it.findViewById<View>(R.id.conversations_page).isShown) }
        }
    }

    @Test fun allProvidersUseTheBundledDesktopRendererAndStreamUpdates() {
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            await { var ready = false; scenario.onActivity { ready = it.findViewById<RecyclerView>(R.id.conversations_list).adapter?.itemCount == 1 }; ready }
            scenario.onActivity { it.findViewById<RecyclerView>(R.id.conversations_list).findViewHolderForAdapterPosition(0)!!.itemView.performClick() }
            for ((index, provider) in listOf("codex", "claude", "grok", "cursor", "opencode").withIndex()) {
                if (index > 0) {
                    WorkspaceStore(context).put(snapshot(provider, at = now + index * 1000))
                    NotificationTools.announceChanged(context)
                }
                try {
                    await { js(scenario, "document.body.innerText.includes('The conversation now follows the desktop agent.') && document.querySelector('[data-agent=$provider]') !== null") == "true" }
                } catch (error: AssertionError) {
                    fail("Renderer $provider: ${js(scenario, "JSON.stringify({text:document.body.innerText,url:location.href,update:typeof window.duckweedUpdate,html:document.body.innerHTML.slice(0,300)})")}")
                }
                scenario.onActivity {
                    assertEquals(View.VISIBLE, it.findViewById<View>(R.id.conversation_experience).visibility)
                    assertEquals(View.GONE, it.findViewById<View>(R.id.conversation_list).visibility)
                    assertEquals("Fast", it.findViewById<TextView>(R.id.conversation_model).text.toString())
                    assertEquals("High", it.findViewById<TextView>(R.id.conversation_effort).text.toString())
                    assertTrue(it.findViewById<View>(R.id.conversation_stop).isShown)
                }
                assertFalse(js(scenario, "document.body.innerText.includes('needs to recover')").toBoolean())
                screenshot("mobile-redesign-$provider.png")
            }
            WorkspaceStore(context).put(snapshot("opencode", "Checking the updated stream.", now + 6000))
            NotificationTools.announceChanged(context)
            await { js(scenario, "document.body.innerText.includes('Checking the updated stream.')") == "true" }
            // Transcript content cannot open a network resource or navigate the renderer.
            assertEquals("true", js(scenario, "window.location.hostname === 'appassets.androidplatform.net'"))
        }
    }

    private fun js(scenario: ActivityScenario<MainActivity>, script: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        scenario.onActivity { it.findViewById<AgentExperienceView>(R.id.conversation_experience).evaluateJavascript(script) { value -> result = value; latch.countDown() } }
        assertTrue(latch.await(3, TimeUnit.SECONDS))
        return result
    }
    private fun await(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 12_000
        while (System.currentTimeMillis() < deadline) { if (condition()) return; Thread.sleep(100) }
        fail("Mobile UI did not settle")
    }
    private fun screenshot(name: String) {
        instrumentation.waitForIdleSync()
        val bitmap = instrumentation.uiAutomation.takeScreenshot()
        File(context.getExternalFilesDir(null), name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
