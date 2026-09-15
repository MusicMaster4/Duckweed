package dev.slop.duckweed.companion

import android.content.Intent
import android.content.ContentValues
import android.Manifest
import android.os.Build
import android.os.PowerManager
import android.app.NotificationManager
import android.content.Context
import android.content.ContextWrapper
import com.google.firebase.messaging.RemoteMessage
import android.widget.EditText
import android.widget.TextView
import android.view.View
import android.graphics.Bitmap
import android.graphics.Rect
import androidx.recyclerview.widget.RecyclerView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.TimeUnit

/** Runs against Android SQLite, Keystore and the actual Activity, not mocks. */
@RunWith(AndroidJUnit4::class)
class MobileExperienceTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val pairId = "00000000-0000-4000-8000-000000000001"
    private val terminalId = "mobile-regression-terminal"

    @Before
    fun reset() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        WorkManager.getInstance(context).cancelAllWork().result.get(5, TimeUnit.SECONDS)
        context.deleteDatabase("duckweed-messages.db")
        WorkspaceStore(context).remove(pairId)
        MobileNotificationVisibility.activityStopped()
        NotificationPreference.setEnabled(context, true)
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }

    private fun message(seq: Long, sentAt: Long, response: String = "Response $seq") = CompletionRecord(
        id = UUID.randomUUID().toString(), pairId = pairId, terminalId = terminalId,
        projectId = "project", agent = "Codex", project = "Mobile regression",
        kind = "completed", sentAt = sentAt, response = response, durationMs = null,
        completionSeq = seq, unreadOnDesktop = true,
    )

    private fun snapshot(seq: Long, readSeq: Long?, unread: Boolean, at: Long) = WorkspaceSnapshot(
        pairId, at, listOf(RemoteProject(
            "project", "Mobile regression", "H:/project", null,
            terminals = listOf(RemoteTerminal(
                terminalId, "Codex", "PowerShell", "Codex", "Test model", "idle",
                mode = "conversation", completionSeq = seq, readCompletionSeq = readSeq,
                unreadOnDesktop = unread,
            )),
        )),
    )

    @Test
    fun openingSettingsKeepsUnreadNotificationsAvailable() {
        NotificationTools.createChannel(context)
        val unread = message(10, System.currentTimeMillis()).copy(soundCue = 0)
        MessageStore(context).use {
            it.put(unread)
            NotificationTools.deliverPending(context, it, unread)
        }
        val manager = context.getSystemService(NotificationManager::class.java)
        awaitCondition { manager.activeNotifications.any { it.id == unread.id.hashCode() } }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            scenario.onActivity { activity ->
                activity.findViewById<View>(R.id.settings_button).performClick()
                val health = activity.findViewById<TextView>(R.id.notification_health)
                assertTrue(health.isShown)
                assertTrue(health.text.contains("Android notifications are allowed."))
            }
            awaitCondition {
                var settled = false
                scenario.onActivity {
                    val page = it.findViewById<View>(R.id.connections_page)
                    settled = page.isShown && page.alpha == 1f &&
                        it.findViewById<View>(R.id.responses_page).visibility == View.GONE
                }
                settled
            }
            scenario.onActivity { activity ->
                val health = activity.findViewById<TextView>(R.id.notification_health)
                health.requestRectangleOnScreen(Rect(0, 0, health.width, health.height), true)
            }
            instrumentation.waitForIdleSync()
            assertTrue(manager.activeNotifications.any { it.id == unread.id.hashCode() })
            manager.cancelAll()
            awaitCondition { manager.activeNotifications.isEmpty() }
            instrumentation.uiAutomation.takeScreenshot()?.let { screenshot ->
                File(context.getExternalFilesDir(null), "mobile-notification-settings.png").outputStream().use {
                    screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)
                }
                screenshot.recycle()
            }
        }
    }

    @Test
    fun firebaseCallbackPostsAnAudibleNotificationWithTheScreenOff() {
        val credentials = PairCredentials(pairId, "https://127.0.0.1:1", "A".repeat(43), "B".repeat(43), "test-device", "Test device")
        SecretStore.save(context, credentials)
        NotificationTools.createChannel(context)
        val id = UUID.randomUUID().toString()
        val plain = JSONObject().put("version", 1).put("id", id).put("sentAt", System.currentTimeMillis())
            .put("agent", "Codex").put("project", "Mobile regression").put("kind", "completed")
            .put("terminalId", terminalId).put("completionSeq", 8).put("unreadOnDesktop", true)
            .put("soundCue", 0).put("response", "Ready while the screen is off")
        val encrypted = Crypto.encrypt(credentials, id, "preview", plain.toString().toByteArray())
        val service = DuckweedMessagingService()
        ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply {
            isAccessible = true
            invoke(service, context)
        }
        // Retain stale foreground state to exercise the lifecycle race at lock.
        MobileNotificationVisibility.activityStarted()
        MobileNotificationVisibility.showConversation(pairId, terminalId)
        try {
            instrumentation.uiAutomation.executeShellCommand("input keyevent 223").close()
            awaitCondition { !context.getSystemService(PowerManager::class.java).isInteractive }
            service.onMessageReceived(RemoteMessage.Builder("screen-off-regression").setData(mapOf(
                "version" to "1", "pair_id" to pairId, "message_id" to id,
                "preview_nonce" to encrypted.nonce, "preview_ciphertext" to encrypted.ciphertext,
            )).build())
            val manager = context.getSystemService(NotificationManager::class.java)
            awaitCondition { manager.activeNotifications.any { it.id == id.hashCode() } }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val posted = manager.activeNotifications.single { it.id == id.hashCode() }
                val channel = manager.getNotificationChannel(posted.notification.channelId)
                assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.importance)
                assertNotNull(channel.sound)
            }
            MessageStore(context).use {
                assertNull(it.message(id)?.readAt)
                assertTrue(it.pendingReadSyncs().isEmpty())
            }
        } finally {
            MobileNotificationVisibility.activityStopped()
            instrumentation.uiAutomation.executeShellCommand("input keyevent 224").close()
            instrumentation.uiAutomation.executeShellCommand("wm dismiss-keyguard").close()
        }
    }

    @Test
    fun recoveryAlertsOnceAndDoesNotReplayAfterAlertsAreEnabled() {
        NotificationTools.createChannel(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        val recovered = message(8, System.currentTimeMillis()).copy(soundCue = 0)
        MessageStore(context).use { store ->
            store.put(recovered)
            NotificationTools.deliverPending(context, store, recovered)
            awaitCondition { manager.activeNotifications.size == 1 }
            assertFalse(store.isNotificationPending(recovered.id))
            manager.cancelAll()
            awaitCondition { manager.activeNotifications.isEmpty() }
            NotificationTools.deliverPending(context, store, recovered)
            assertTrue(manager.activeNotifications.isEmpty())

            val muted = message(9, recovered.sentAt + 1)
            NotificationPreference.setEnabled(context, false)
            store.put(muted)
            NotificationTools.deliverPending(context, store, muted)
            NotificationPreference.setEnabled(context, true)
            NotificationTools.deliverPending(context, store, muted)
            assertTrue(manager.activeNotifications.isEmpty())
        }
    }

    @Test
    fun notificationSoundsResolveByNameAndSurviveChannelRecreation() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        NotificationTools.createChannel(context)
        val manager = context.getSystemService(NotificationManager::class.java)
        val before = (0..5).map { manager.getNotificationChannel("agent-completions-v3-$it").sound }
        before.forEach { uri ->
            assertEquals("raw", uri.pathSegments.first())
            context.contentResolver.openInputStream(uri).use { stream ->
                assertNotNull(stream)
                assertTrue(stream!!.read() >= 0)
            }
        }
        NotificationTools.createChannel(context)
        assertEquals(before, (0..5).map { manager.getNotificationChannel("agent-completions-v3-$it").sound })
    }

    @Test
    fun heartbeatDoesNotRewriteEncryptedWorkspaceAndSurvivesOlderSnapshots() {
        val workspace = WorkspaceStore(context)
        workspace.put(snapshot(7, null, true, 1_000), receivedAt = 1_000)
        val preferences = context.getSharedPreferences("duckweed-workspaces", Context.MODE_PRIVATE)
        val before = preferences.getString(pairId, null)
        assertTrue(workspace.markPresence(pairId, 5_000))
        assertEquals(before, preferences.getString(pairId, null))
        assertFalse(workspace.markPresence(pairId, 4_000))
        workspace.put(snapshot(8, null, true, 2_000), receivedAt = 2_000)
        assertEquals(5_000L, workspace.all().single { it.pairId == pairId }.lastSeenAt)
        workspace.remove(pairId)
        workspace.put(snapshot(9, null, true, 3_000), receivedAt = 3_000)
        assertEquals(3_000L, workspace.all().single { it.pairId == pairId }.lastSeenAt)
    }

    @Test
    fun databaseUpgradePreservesExistingEncryptedHistoryAndReadState() {
        val legacy = message(6, 1_000, "Saved before the update")
        context.openOrCreateDatabase("duckweed-messages.db", 0, null).use { database ->
            database.execSQL("CREATE TABLE messages (id TEXT PRIMARY KEY, sent_at INTEGER NOT NULL, encrypted_payload TEXT NOT NULL, notified_at INTEGER, read_at INTEGER, pair_id TEXT, terminal_id TEXT, kind TEXT)")
            database.execSQL("CREATE TABLE conversation_reads (pair_id TEXT NOT NULL, terminal_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY(pair_id, terminal_id))")
            database.execSQL("CREATE TABLE pending_read_syncs (pair_id TEXT NOT NULL, terminal_id TEXT NOT NULL, completion_seq INTEGER, command_id TEXT NOT NULL, PRIMARY KEY(pair_id, terminal_id))")
            val payload = JSONObject().put("id", legacy.id).put("sentAt", legacy.sentAt)
                .put("agent", legacy.agent).put("project", legacy.project)
                .put("pairId", pairId).put("terminalId", terminalId)
                .put("response", legacy.response).put("kind", "completed")
            database.insertOrThrow("messages", null, ContentValues().apply {
                put("id", legacy.id); put("sent_at", legacy.sentAt)
                put("encrypted_payload", SecretStore.encryptLocal(payload.toString().toByteArray()))
                put("read_at", 2_000); put("pair_id", pairId); put("terminal_id", terminalId); put("kind", "completed")
            })
            database.version = 6
        }
        MessageStore(context).use { store ->
            assertEquals(7, store.readableDatabase.version)
            assertEquals(legacy.response, store.message(legacy.id)?.response)
            assertEquals(2_000L, store.message(legacy.id)?.readAt)
            assertFalse(store.isNotificationPending(legacy.id))
            val fresh = message(7, 3_000)
            store.put(fresh)
            assertTrue(store.isNotificationPending(fresh.id))
        }
    }

    @Test
    fun firebaseCallbackSuppressesReadPushButStillAlertsForANewCompletion() {
        val credentials = PairCredentials(pairId, "https://127.0.0.1:1", "A".repeat(43), "B".repeat(43), "test-device", "Test device")
        SecretStore.save(context, credentials)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancelAll()
        NotificationTools.createChannel(context)
        MessageStore(context).use { it.putSyncedConversation(snapshot(7, 7, false, 50_000)) }
        val service = DuckweedMessagingService()
        ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply {
            isAccessible = true
            invoke(service, context)
        }
        fun deliver(seq: Long, sentAt: Long): String {
            val id = UUID.randomUUID().toString()
            val plain = JSONObject().put("version", 1).put("id", id).put("sentAt", sentAt)
                .put("agent", "Codex").put("project", "Mobile regression").put("kind", "completed")
                .put("terminalId", terminalId).put("completionSeq", seq).put("unreadOnDesktop", true)
                .put("response", "Response $seq")
            val encrypted = Crypto.encrypt(credentials, id, "preview", plain.toString().toByteArray())
            service.onMessageReceived(RemoteMessage.Builder("local-regression").setData(mapOf(
                "version" to "1", "pair_id" to pairId, "message_id" to id,
                "preview_nonce" to encrypted.nonce, "preview_ciphertext" to encrypted.ciphertext,
            )).build())
            return id
        }
        val stale = deliver(7, 90_000)
        assertTrue(manager.activeNotifications.isEmpty())
        MessageStore(context).use { assertFalse(it.isNotificationPending(stale)) }
        deliver(8, 40_000)
        awaitCondition { manager.activeNotifications.isNotEmpty() }
        assertEquals(1, manager.activeNotifications.size)
        manager.cancelAll()
    }

    @Test
    fun delayedPushStaysReadAndDoesNotReplaceTheFullResponse() {
        MessageStore(context).use { store ->
            store.putSyncedConversation(snapshot(7, 7, false, 50_000))
            val full = message(7, 90_000, "Complete response with all details")
            store.put(full)
            store.put(full.copy(response = "Complete response..."), previewOnly = true)
            assertEquals(full.response, store.message(full.id)?.response)
            assertFalse(store.isNotificationPending(full.id))
            assertNotNull(store.message(full.id)?.readAt)
            assertTrue(store.pendingNotifications().isEmpty())
            assertFalse(NotificationTools.show(context, full))
            val newer = message(8, 40_000)
            store.put(newer)
            assertTrue(store.isNotificationPending(newer.id))
        }
    }

    @Test
    fun collapsedReadSnapshotClearsOnlyTheAcknowledgedCompletion() {
        MessageStore(context).use { store ->
            val older = message(7, 90_000)
            val newer = message(8, 40_000)
            store.put(older)
            store.put(newer)
            val cleared = store.putSyncedConversation(snapshot(8, 7, true, 100_000))
            assertTrue(older.id in cleared)
            assertFalse(newer.id in cleared)
            assertFalse(store.isNotificationPending(older.id))
            assertTrue(store.isNotificationPending(newer.id))
        }
    }

    @Test
    fun selectedPaneGracePeriodIsNotAnExplicitReadReceipt() {
        MessageStore(context).use { store ->
            store.putSyncedConversation(snapshot(7, null, false, 50_000))
            val delayed = message(7, 90_000)
            store.put(delayed)
            assertTrue(store.isNotificationPending(delayed.id))
            store.markConversationRead(pairId, terminalId, 7, 100_000)
            assertFalse(store.isNotificationPending(delayed.id))
        }
    }

    @Test
    fun deliveryProgressCannotRegressWhenNetworkCallbacksArriveLate() {
        MessageStore(context).use { store ->
            val outgoing = message(1, 1_000).copy(kind = "user", deliveryState = "sending")
            store.put(outgoing)
            store.updateOutgoingState(outgoing.id, "delivered")
            store.updateOutgoingState(outgoing.id, "sent")
            store.updateOutgoingState(outgoing.id, "received")
            store.updateOutgoingState(outgoing.id, "failed", "Late network failure")
            assertEquals("delivered", store.message(outgoing.id)?.deliveryState)
            assertNull(store.message(outgoing.id)?.deliveryError)
        }
    }

    @Test
    fun destroyedActivityIgnoresLateSyncCallbacks() {
        lateinit var activity: MainActivity
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            scenario.onActivity { activity = it }
        }
        instrumentation.runOnMainSync {
            assertTrue(activity.isDestroyed)
            listOf("refreshRemoteState", "recoverPendingRelayMessages", "showPendingNotifications").forEach { name ->
                MainActivity::class.java.getDeclaredMethod(name).apply { isAccessible = true }.invoke(activity)
            }
            MainActivity::class.java.getDeclaredMethod("requestRemoteRefresh", Boolean::class.javaPrimitiveType).apply {
                isAccessible = true
            }.invoke(activity, false)
        }
    }

    @Test
    fun sendingPaintsImmediatelyWhileTheNetworkQueueIsBlocked() {
        val now = System.currentTimeMillis()
        // Test-only loopback destination. No command can reach a real desktop.
        SecretStore.save(context, PairCredentials(pairId, "https://127.0.0.1:1", "A".repeat(43), "B".repeat(43), "test-device", "Test device"))
        WorkspaceStore(context).put(snapshot(7, null, true, now))
        val latest = message(7, now, "Open this conversation")
        MessageStore(context).use { store ->
            repeat(250) { index ->
                val historical = message(1, now - 300_000 + index, "History $index " + "content ".repeat(500))
                store.put(historical.copy(readAt = historical.sentAt))
                store.markNotified(historical.id)
            }
            store.put(latest)
            store.markNotified(latest.id)
        }
        val intent = Intent(context, MainActivity::class.java).putExtra("message_id", latest.id)
        ActivityScenario.launch<MainActivity>(intent).use { scenario ->
            awaitCondition {
                var visible = false
                scenario.onActivity {
                    val input = it.findViewById<EditText>(R.id.conversation_input)
                    visible = input.isShown && input.isEnabled &&
                        it.findViewById<RecyclerView>(R.id.conversation_list).adapter!!.itemCount >= 250
                }
                visible
            }
            val release = CountDownLatch(1)
            val blocked = CountDownLatch(1)
            val draftsBlocked = CountDownLatch(1)
            var before = 0
            try {
                scenario.onActivity { activity ->
                    val field = MainActivity::class.java.getDeclaredField("commandExecutor").apply { isAccessible = true }
                    (field.get(activity) as ExecutorService).execute { blocked.countDown(); release.await(15, TimeUnit.SECONDS) }
                }
                assertTrue(blocked.await(3, TimeUnit.SECONDS))
                DraftStore.io.execute { draftsBlocked.countDown(); release.await(15, TimeUnit.SECONDS) }
                assertTrue(draftsBlocked.await(3, TimeUnit.SECONDS))
                scenario.onActivity { activity ->
                    val input = activity.findViewById<EditText>(R.id.conversation_input)
                    val list = activity.findViewById<RecyclerView>(R.id.conversation_list)
                    input.setText("Immediate optimistic send")
                    before = list.adapter!!.itemCount
                    val started = System.nanoTime()
                    assertTrue(activity.findViewById<View>(R.id.conversation_send).performClick())
                    val elapsedMs = (System.nanoTime() - started) / 1_000_000
                    android.util.Log.i("DuckweedRegression", "Optimistic send callback: ${elapsedMs}ms")
                    assertEquals("", input.text.toString())
                    assertTrue("Send blocked the UI for ${elapsedMs}ms", elapsedMs < 500)
                }
                awaitCondition {
                    var painted = false
                    scenario.onActivity {
                        painted = it.findViewById<RecyclerView>(R.id.conversation_list).adapter!!.itemCount == before + 1
                    }
                    painted
                }
                MessageStore(context).use { store ->
                    assertFalse(store.conversation(pairId, terminalId).any { it.response == "Immediate optimistic send" })
                }
                instrumentation.waitForIdleSync()
                instrumentation.uiAutomation.takeScreenshot()?.let { screenshot ->
                    File(context.getExternalFilesDir(null), "mobile-send-regression.png").outputStream().use {
                        screenshot.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                    screenshot.recycle()
                }
            } finally {
                release.countDown()
            }
            awaitCondition {
                MessageStore(context).use { store ->
                    store.conversation(pairId, terminalId).any { it.response == "Immediate optimistic send" && it.deliveryState == "failed" }
                }
            }
        }
    }

    private fun awaitCondition(predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 15_000
        while (!predicate()) {
            check(System.currentTimeMillis() < deadline) { "Mobile UI did not reach the expected state" }
            Thread.sleep(100)
        }
    }
}
