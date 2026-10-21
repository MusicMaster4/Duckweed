package dev.slop.duckweed.companion

import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.widget.EditText
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class PromptTemplatesDeviceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val pairId = "00000000-0000-4000-8000-000000000021"
    private val content = "Review this implementation.\n\nCheck correctness, cover edge cases, and suggest concrete fixes.\nPreserve Unicode: \uD83E\uDD86 \u00e7 \u65e5\u672c\u8a9e."
    private val template = RemotePromptTemplate("review", "Review implementation", content, 1, 2)

    @Before fun seed() {
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            instrumentation.uiAutomation.grantRuntimePermission(context.packageName, android.Manifest.permission.POST_NOTIFICATIONS)
        }
        SecretStore.loadAll(context).forEach { WorkspaceStore(context).remove(it.pairId) }
        SecretStore.clear(context)
        context.deleteDatabase("duckweed-messages.db")
        SecretStore.save(context, PairCredentials(pairId, "https://127.0.0.1:1", "A".repeat(43), "B".repeat(43), "test-phone", "Test desktop"))
        PromptTemplateStore(context).put(pairId, PromptTemplatesPart(10, "v1", 0, 1, listOf(template,
            RemotePromptTemplate("release", "Release checklist", "Run tests and review the release notes.", 1, 2))))
    }
    @After fun clean() {
        WorkspaceStore(context).remove(pairId)
        SecretStore.remove(context, pairId)
    }

    @Test fun offlineLibrarySearchCopyAndLiveReplacement() {
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            await { var loaded = false; scenario.onActivity { loaded = it.findViewById<RecyclerView>(R.id.prompt_list).adapter?.itemCount == 2 }; loaded }
            scenario.onActivity { it.findViewById<View>(R.id.nav_prompts).performClick() }
            instrumentation.waitForIdleSync()
            await {
                var visible = false
                scenario.onActivity {
                    visible = it.findViewById<View>(R.id.prompts_page).isShown &&
                        it.findViewById<View>(R.id.prompts_page).alpha == 1f &&
                        it.findViewById<View>(R.id.conversations_page).visibility == View.GONE && it.hasWindowFocus()
                }
                visible
            }
            instrumentation.waitForIdleSync()
            Thread.sleep(350) // Let the compositor present the completed page transition.
            val bitmap = instrumentation.uiAutomation.takeScreenshot()
            File(context.getExternalFilesDir(null), "mobile-prompt-templates.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
            scenario.onActivity { it.findViewById<EditText>(R.id.prompt_search).setText("Unicode") }
            await { var count = 0; scenario.onActivity { count = it.findViewById<RecyclerView>(R.id.prompt_list).adapter!!.itemCount }; count == 1 }
            scenario.onActivity {
                val card = it.findViewById<RecyclerView>(R.id.prompt_list).findViewHolderForAdapterPosition(0)!!.itemView
                assertEquals(template.title, card.findViewById<TextView>(R.id.prompt_title).text.toString())
                card.findViewById<View>(R.id.prompt_copy).performClick()
            }
            await {
                var copied = false
                scenario.onActivity {
                    copied = it.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.text?.toString() == content
                }
                copied
            }
            // The UI consumes encrypted persisted replacements while remaining on Prompts.
            PromptTemplateStore(context).put(pairId, PromptTemplatesPart(20, "v2", 0, 1, emptyList()))
            NotificationTools.announceChanged(context)
            await { var empty = false; scenario.onActivity { empty = it.findViewById<RecyclerView>(R.id.prompt_list).adapter!!.itemCount == 0 }; empty }
        }
        assertTrue(PromptTemplateStore(context).all(setOf(pairId)).isEmpty())
    }

    @Test fun pendingEncryptedPartsSurviveRestartAndDisconnectClearsLibrary() {
        val store = PromptTemplateStore(context)
        store.put(pairId, PromptTemplatesPart(30, "v3", 1, 2, listOf(template.copy(id = "b"))))
        assertEquals(2, PromptTemplateStore(context).all(setOf(pairId)).size)
        PromptTemplateStore(context).put(pairId, PromptTemplatesPart(30, "v3", 0, 2, listOf(template.copy(id = "a"))))
        assertEquals(listOf("a", "b"), PromptTemplateStore(context).all(setOf(pairId)).map { it.template.id })
        WorkspaceStore(context).remove(pairId)
        assertTrue(PromptTemplateStore(context).all(setOf(pairId)).isEmpty())
    }

    private fun await(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 10_000
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(100)
        }
        fail("Prompt templates UI did not settle")
    }
}
