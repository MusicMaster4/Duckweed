package dev.slop.duckweed.companion

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.firebase.messaging.FirebaseMessaging
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private enum class Page { RESPONSES, PROJECTS, CONNECTIONS, UPDATES }

    private lateinit var pairingStatus: TextView
    private lateinit var scanButton: Button
    private lateinit var disconnectButton: Button
    private lateinit var emptyState: View
    private lateinit var notificationsToggle: SwitchCompat
    private lateinit var updateStatus: TextView
    private lateinit var updateButton: Button
    private lateinit var updateProgress: ProgressBar
    private lateinit var projectsEmpty: View
    private lateinit var projectDetail: View
    private lateinit var conversationDetail: View
    private lateinit var conversationThinking: View
    private lateinit var conversationComposer: View
    private lateinit var conversationUnavailable: View
    private lateinit var conversationInput: EditText
    private lateinit var conversationSend: TextView
    private lateinit var conversationList: RecyclerView
    private lateinit var appUpdater: AppUpdater
    private val messageAdapter = MessageAdapter { openResponse(it) }
    private val projectAdapter = ProjectAdapter { openProject(it) }
    private val terminalAdapter = TerminalAdapter { openConversation(it, true) }
    private val conversationAdapter = ConversationAdapter()
    private val executor = Executors.newSingleThreadExecutor()
    private var receiverRegistered = false
    private var syncingNotificationsToggle = false
    private var updateAvailable: AndroidUpdateManifest? = null
    private var selectedPage = Page.RESPONSES
    private var selectedProject: ProjectRow? = null
    private var selectedTarget: ConversationTarget? = null
    private var legacyResponse: CompletionRecord? = null
    private var conversationReturnsToProject = false

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        NotificationPreference.setEnabled(this, granted)
        syncNotificationToggle()
        if (granted) showPendingNotifications()
    }

    private val installPermission = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) {
        if (appUpdater.canInstallPackages()) {
            runCatching { appUpdater.installVerified() }
                .onFailure { showUpdateError(it.message ?: "Could not open the Android installer.") }
        } else {
            showUpdateError("Allow installs from Duckweed to finish this update.")
        }
    }

    private val messagesChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) = refreshRemoteState()
    }

    private val downloadFinished = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            if (!appUpdater.isPendingDownload(id)) return
            finishDownloadedUpdate(id)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        configureSystemBarInsets()
        NotificationTools.createChannel(this)
        appUpdater = AppUpdater(this)

        pairingStatus = findViewById(R.id.pairing_status)
        scanButton = findViewById(R.id.scan_button)
        disconnectButton = findViewById(R.id.disconnect_button)
        emptyState = findViewById(R.id.empty_state)
        notificationsToggle = findViewById(R.id.notifications_toggle)
        updateStatus = findViewById(R.id.update_status)
        updateButton = findViewById(R.id.update_button)
        updateProgress = findViewById(R.id.update_progress)
        projectsEmpty = findViewById(R.id.projects_empty)
        projectDetail = findViewById(R.id.project_detail)
        conversationDetail = findViewById(R.id.conversation_detail)
        conversationThinking = findViewById(R.id.conversation_thinking)
        conversationComposer = findViewById(R.id.conversation_composer)
        conversationUnavailable = findViewById(R.id.conversation_unavailable)
        conversationInput = findViewById(R.id.conversation_input)
        conversationSend = findViewById(R.id.conversation_send)
        conversationList = findViewById(R.id.conversation_list)

        findViewById<RecyclerView>(R.id.message_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = messageAdapter
        }
        findViewById<RecyclerView>(R.id.project_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = projectAdapter
        }
        findViewById<RecyclerView>(R.id.terminal_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = terminalAdapter
        }
        conversationList.apply {
            layoutManager = LinearLayoutManager(this@MainActivity).apply { stackFromEnd = true }
            adapter = conversationAdapter
        }
        findViewById<View>(R.id.project_back).setOnClickListener { closeProject() }
        findViewById<View>(R.id.conversation_back).setOnClickListener { closeConversation() }
        conversationSend.setOnClickListener { sendConversationMessage() }

        configureNavigation()
        configureNotificationToggle()
        savedInstanceState?.getString(STATE_PAGE)
            ?.let { runCatching { Page.valueOf(it) }.getOrNull() }
            ?.let(::showPage)
        configureUpdater()
        resumePendingUpdate()
        scanButton.setOnClickListener { scanPairingCode() }
        disconnectButton.setOnClickListener { confirmDisconnect() }
        updateButton.setOnClickListener {
            updateAvailable?.let(::downloadUpdate) ?: checkForUpdates()
        }
        requestNotificationPermissionIfEnabled()
        refreshPairingStatus()
        refreshPushRegistration()
        refreshRemoteState()

        openIntentResponse()
    }

    override fun onStart() {
        super.onStart()
        if (!receiverRegistered) {
            ContextCompat.registerReceiver(
                this,
                messagesChanged,
                IntentFilter(NotificationTools.ACTION_MESSAGES_CHANGED),
                ContextCompat.RECEIVER_NOT_EXPORTED,
            )
            ContextCompat.registerReceiver(
                this,
                downloadFinished,
                IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                ContextCompat.RECEIVER_EXPORTED,
            )
            receiverRegistered = true
        }
    }

    override fun onStop() {
        if (receiverRegistered) {
            unregisterReceiver(messagesChanged)
            unregisterReceiver(downloadFinished)
            receiverRegistered = false
        }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        NotificationTools.cancelAll(this)
        syncNotificationToggle()
        refreshRemoteState()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openIntentResponse()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_PAGE, selectedPage.name)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun configureNavigation() {
        findViewById<View>(R.id.nav_responses).setOnClickListener { showPage(Page.RESPONSES) }
        findViewById<View>(R.id.nav_projects).setOnClickListener { showPage(Page.PROJECTS) }
        findViewById<View>(R.id.nav_connections).setOnClickListener { showPage(Page.CONNECTIONS) }
        findViewById<View>(R.id.nav_updates).setOnClickListener { showPage(Page.UPDATES) }
        showPage(Page.RESPONSES)
    }

    private fun configureSystemBarInsets() {
        val root = findViewById<View>(R.id.app_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val safeArea = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            view.updatePadding(
                left = safeArea.left,
                top = safeArea.top,
                right = safeArea.right,
                bottom = safeArea.bottom,
            )
            insets
        }
        ViewCompat.requestApplyInsets(root)
    }

    private fun showPage(page: Page) {
        selectedProject = null
        selectedTarget = null
        legacyResponse = null
        projectDetail.visibility = View.GONE
        conversationDetail.visibility = View.GONE
        setDetailChrome(false)
        selectedPage = page
        val pages = mapOf(
            Page.RESPONSES to R.id.responses_page,
            Page.PROJECTS to R.id.projects_page,
            Page.CONNECTIONS to R.id.connections_page,
            Page.UPDATES to R.id.updates_page,
        )
        val navigation = mapOf(
            Page.RESPONSES to R.id.nav_responses,
            Page.PROJECTS to R.id.nav_projects,
            Page.CONNECTIONS to R.id.nav_connections,
            Page.UPDATES to R.id.nav_updates,
        )
        pages.forEach { (candidate, id) ->
            findViewById<View>(id).visibility = if (candidate == page) View.VISIBLE else View.GONE
        }
        navigation.forEach { (candidate, id) -> findViewById<View>(id).isSelected = candidate == page }
    }

    private fun configureUpdater() {
        val channelLabel = if (BuildConfig.UPDATE_CHANNEL == "testing") "BETA" else "STABLE"
        findViewById<TextView>(R.id.current_version).text = "Version ${BuildConfig.VERSION_NAME}"
        findViewById<TextView>(R.id.update_channel).text = channelLabel
    }

    private fun resumePendingUpdate() {
        val id = appUpdater.pendingDownloadId() ?: return
        when (appUpdater.downloadState(id)) {
            AppUpdater.DownloadState.COMPLETE -> finishDownloadedUpdate(id)
            AppUpdater.DownloadState.RUNNING ->
                setUpdateBusy(true, "Downloading the selected update. Android will notify you when it is ready...")
            AppUpdater.DownloadState.FAILED,
            AppUpdater.DownloadState.MISSING,
            -> {
                appUpdater.clearPending()
                showUpdateError("The previous update download did not finish. Please try again.")
            }
        }
    }

    private fun configureNotificationToggle() {
        notificationsToggle.setOnCheckedChangeListener { _, enabled ->
            if (syncingNotificationsToggle) return@setOnCheckedChangeListener
            if (enabled == notificationsAreActive()) return@setOnCheckedChangeListener
            if (!enabled) {
                NotificationPreference.setEnabled(this, false)
                NotificationTools.cancel(this, MessageStore(this).latest())
                return@setOnCheckedChangeListener
            }
            if (needsNotificationPermission()) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                NotificationPreference.setEnabled(this, true)
                showPendingNotifications()
            }
        }
        syncNotificationToggle()
    }

    private fun requestNotificationPermissionIfEnabled() {
        if (!NotificationPreference.isEnabled(this)) return
        if (needsNotificationPermission()) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            showPendingNotifications()
        }
    }

    private fun needsNotificationPermission(): Boolean =
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            true
        } else {
            false
        }

    private fun notificationsAreActive(): Boolean =
        NotificationPreference.isEnabled(this) && !needsNotificationPermission()

    private fun syncNotificationToggle() {
        if (!::notificationsToggle.isInitialized) return
        val active = notificationsAreActive()
        if (notificationsToggle.isChecked == active) return
        syncingNotificationsToggle = true
        notificationsToggle.isChecked = active
        syncingNotificationsToggle = false
    }

    private fun showPendingNotifications() {
        executor.execute {
            val store = MessageStore(this)
            store.pendingNotifications().asReversed().forEach { message ->
                if (NotificationTools.show(this, message)) store.markNotified(message.id)
            }
        }
    }

    private fun checkForUpdates() {
        setUpdateBusy(true, "Checking the ${channelLabel()} channel on GitHub...")
        executor.execute {
            runCatching { UpdateClient.fetch(BuildConfig.UPDATE_CHANNEL) }
                .onSuccess { manifest ->
                    runOnUiThread {
                        if (manifest.isNewerThan(BuildConfig.VERSION_CODE)) {
                            updateAvailable = manifest
                            updateStatus.text = "Version ${manifest.versionName} is ready for this phone."
                            updateButton.text = "Download and install"
                        } else {
                            updateAvailable = null
                            updateStatus.text = "You are up to date on the ${channelLabel()} channel."
                            updateButton.text = "Check again"
                        }
                        setUpdateBusy(false)
                    }
                }
                .onFailure { error ->
                    runOnUiThread {
                        showUpdateError(
                            if (error.message?.contains("404") == true) {
                                "No mobile update feed has been published for this channel yet."
                            } else {
                                "Could not check for updates. ${error.message ?: "Try again later."}"
                            },
                        )
                    }
                }
        }
    }

    private fun downloadUpdate(manifest: AndroidUpdateManifest) {
        runCatching { appUpdater.enqueue(manifest) }
            .onSuccess {
                updateAvailable = null
                setUpdateBusy(true, "Downloading ${manifest.versionName}. Android will notify you when it is ready...")
            }
            .onFailure { showUpdateError(it.message ?: "Could not start the update download.") }
    }

    private fun finishDownloadedUpdate(id: Long) {
        setUpdateBusy(true, "Verifying the downloaded APK...")
        executor.execute {
            runCatching { appUpdater.verifyDownload(id) }
                .onSuccess { manifest ->
                    runOnUiThread {
                        setUpdateBusy(false)
                        updateStatus.text = "Version ${manifest.versionName} is verified and ready to install."
                        if (appUpdater.canInstallPackages()) {
                            runCatching { appUpdater.installVerified() }
                                .onFailure { showUpdateError(it.message ?: "Could not open the Android installer.") }
                        } else {
                            updateStatus.text = "Allow installs from Duckweed, then Android will open the verified update."
                            installPermission.launch(appUpdater.requestInstallPermission())
                        }
                    }
                }
                .onFailure { error ->
                    runOnUiThread { showUpdateError(error.message ?: "The update could not be verified.") }
                }
        }
    }

    private fun setUpdateBusy(busy: Boolean, message: String? = null) {
        updateProgress.visibility = if (busy) View.VISIBLE else View.GONE
        updateButton.isEnabled = !busy
        if (message != null) updateStatus.text = message
    }

    private fun showUpdateError(message: String) {
        setUpdateBusy(false, message)
        updateButton.text = "Try again"
        updateAvailable = null
    }

    private fun channelLabel(): String = if (BuildConfig.UPDATE_CHANNEL == "testing") "beta" else "stable"

    private fun scanPairingCode() {
        scanButton.isEnabled = false
        pairingStatus.text = "Opening the secure QR scanner..."
        val options = GmsBarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .enableAutoZoom()
            .build()
        GmsBarcodeScanning.getClient(this, options)
            .startScan()
            .addOnSuccessListener { barcode ->
                val raw = barcode.rawValue
                if (raw.isNullOrBlank()) {
                    showPairingError("The QR code did not contain pairing data.")
                    return@addOnSuccessListener
                }
                val code = runCatching { RelayClient.parsePairingCode(raw) }
                    .getOrElse {
                        showPairingError(it.message ?: "This is not a Duckweed pairing code.")
                        return@addOnSuccessListener
                    }
                pairingStatus.text = "Registering this phone with Duckweed..."
                FirebaseMessaging.getInstance().token
                    .addOnSuccessListener { token -> pair(code, token) }
                    .addOnFailureListener { showPairingError("Could not register for push notifications: ${it.message}") }
            }
            .addOnCanceledListener {
                scanButton.isEnabled = true
                refreshPairingStatus()
            }
            .addOnFailureListener { showPairingError("Could not scan the code: ${it.message}") }
    }

    private fun pair(code: RelayClient.PairingCode, fcmToken: String) {
        executor.execute {
            runCatching { RelayClient.register(code, fcmToken) }
                .onSuccess { credentials ->
                    SecretStore.save(this, credentials)
                    runOnUiThread {
                        scanButton.isEnabled = true
                        refreshPairingStatus("Paired successfully. Send a test from Duckweed settings.")
                    }
                }
                .onFailure { error ->
                    runOnUiThread { showPairingError(error.message ?: "Pairing failed.") }
                }
        }
    }

    private fun confirmDisconnect() {
        val credentials = SecretStore.loadAll(this)
        if (credentials.isEmpty()) return
        val multiple = credentials.size > 1
        AlertDialog.Builder(this)
            .setTitle(if (multiple) "Disconnect from all desktops?" else "Disconnect this phone?")
            .setMessage(
                if (multiple) {
                    "All paired Duckweed desktops will stop sending agent completions to this device. Local response history stays on the phone."
                } else {
                    "Duckweed will stop sending agent completions to this device. Local response history stays on the phone."
                },
            )
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Disconnect") { _, _ ->
                pairingStatus.text = "Disconnecting..."
                executor.execute {
                    val failures = mutableListOf<String>()
                    credentials.forEach { pairing ->
                        runCatching { RelayClient.disconnect(pairing) }
                            .onSuccess {
                                SecretStore.remove(this, pairing.pairId)
                                WorkspaceStore(this).remove(pairing.pairId)
                            }
                            .onFailure { failures += it.message ?: pairing.pairId }
                    }
                    runOnUiThread {
                        if (failures.isEmpty()) {
                            refreshPairingStatus("Phone disconnected.")
                        } else {
                            showPairingError("Could not disconnect from every desktop. Please try again.")
                        }
                    }
                }
            }
            .show()
    }

    private fun refreshPairingStatus(message: String? = null) {
        val credentials = SecretStore.loadAll(this)
        disconnectButton.visibility = if (credentials.isEmpty()) View.GONE else View.VISIBLE
        scanButton.text = if (credentials.isEmpty()) "Scan pairing code" else "Pair another desktop"
        scanButton.isEnabled = true
        pairingStatus.text = message ?: if (credentials.isEmpty()) {
            "Not paired yet. On desktop, open Settings, then Agents and Mobile notifications, and scan its QR code."
        } else if (credentials.size == 1) {
            "Connected as ${credentials.single().deviceName}. Full encrypted responses stay inside this app."
        } else {
            "Connected to ${credentials.size} desktops as ${credentials.last().deviceName}. Full encrypted responses stay inside this app."
        }
    }

    /** Keep existing pairings routable if Firebase rotates its token during an app update. */
    private fun refreshPushRegistration() {
        val credentials = SecretStore.loadAll(this)
        if (credentials.isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            executor.execute {
                credentials.forEach { pairing ->
                    runCatching { RelayClient.refreshFcmToken(pairing, token) }
                }
            }
        }
    }

    private fun refreshRemoteState() {
        val messages = MessageStore(this).latest()
        legacyResponse?.let { current ->
            legacyResponse = messages.firstOrNull { it.id == current.id } ?: current
        }
        messageAdapter.submit(messages)
        emptyState.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE
        refreshWorkspaces()
        if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
        openIntentResponse()
    }

    private fun refreshWorkspaces() {
        val rows = WorkspaceStore(this).all().flatMap { snapshot ->
            snapshot.projects.map { ProjectRow(snapshot.pairId, it) }
        }
        projectAdapter.submit(rows)
        projectsEmpty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE

        selectedProject?.let { current ->
            selectedProject = rows.firstOrNull {
                it.pairId == current.pairId && it.project.id == current.project.id
            } ?: current
            terminalAdapter.submit(selectedProject)
        }
        selectedTarget?.let { current ->
            rows.firstOrNull {
                it.pairId == current.pairId && it.project.id == current.projectId
            }?.let { row ->
                row.project.terminals.firstOrNull { it.id == current.terminal.id }?.let { terminal ->
                    selectedTarget = ConversationTarget(
                        row.pairId,
                        row.project.id,
                        row.project.name,
                        terminal,
                    )
                }
            }
        }
    }

    private fun openProject(row: ProjectRow) {
        selectedProject = row
        terminalAdapter.submit(row)
        findViewById<TextView>(R.id.project_detail_title).text = row.project.name
        findViewById<TextView>(R.id.project_detail_meta).text = buildList {
            add("${row.project.terminals.size} open terminals")
            row.project.branch?.let { add(it) }
        }.joinToString("  •  ")
        projectDetail.visibility = View.VISIBLE
        conversationDetail.visibility = View.GONE
        setDetailChrome(true)
    }

    private fun closeProject() {
        selectedProject = null
        projectDetail.visibility = View.GONE
        setDetailChrome(false)
    }

    private fun openResponse(message: CompletionRecord) {
        val target = findConversationTarget(message)
        if (target != null) {
            openConversation(target, false)
            return
        }
        selectedTarget = null
        legacyResponse = message
        conversationReturnsToProject = false
        projectDetail.visibility = View.GONE
        conversationDetail.visibility = View.VISIBLE
        setDetailChrome(true)
        refreshConversation()
    }

    private fun findConversationTarget(message: CompletionRecord): ConversationTarget? {
        val pairId = message.pairId ?: return null
        val terminalId = message.terminalId ?: return null
        return WorkspaceStore(this).all()
            .firstOrNull { it.pairId == pairId }
            ?.projects
            ?.asSequence()
            ?.mapNotNull { project ->
                project.terminals.firstOrNull { it.id == terminalId }?.let { terminal ->
                    ConversationTarget(pairId, project.id, project.name, terminal)
                }
            }
            ?.firstOrNull()
    }

    private fun openConversation(target: ConversationTarget, returnToProject: Boolean) {
        selectedTarget = target
        legacyResponse = null
        conversationReturnsToProject = returnToProject
        projectDetail.visibility = View.GONE
        conversationDetail.visibility = View.VISIBLE
        setDetailChrome(true)
        refreshConversation()
    }

    private fun closeConversation() {
        selectedTarget = null
        legacyResponse = null
        conversationDetail.visibility = View.GONE
        if (conversationReturnsToProject && selectedProject != null) {
            projectDetail.visibility = View.VISIBLE
        } else {
            setDetailChrome(false)
        }
    }

    private fun refreshConversation() {
        val legacy = legacyResponse
        if (legacy != null) {
            findViewById<TextView>(R.id.conversation_title).text = legacy.agent
            findViewById<TextView>(R.id.conversation_status).text = legacy.project
            conversationAdapter.submit(listOf(legacy))
            conversationThinking.visibility = View.GONE
            conversationComposer.visibility = View.GONE
            conversationUnavailable.visibility = View.VISIBLE
            return
        }
        val target = selectedTarget ?: return
        val messages = MessageStore(this).conversation(target.terminal.id)
        val last = messages.lastOrNull()
        val thinking = target.terminal.isWorking || last?.kind == "user"
        findViewById<TextView>(R.id.conversation_title).text =
            target.terminal.agent ?: target.terminal.title
        findViewById<TextView>(R.id.conversation_status).text = buildList {
            add(target.projectName)
            target.terminal.model?.let { add(it) }
            add(
                when {
                    thinking -> "Thinking"
                    target.terminal.status == "waiting" -> "Needs attention"
                    target.terminal.status == "exited" -> "Closed"
                    else -> "Ready"
                },
            )
        }.joinToString("  •  ")
        conversationAdapter.submit(messages)
        conversationThinking.visibility = if (thinking) View.VISIBLE else View.GONE
        val canReply = SecretStore.load(this, target.pairId) != null && target.terminal.status != "exited"
        conversationComposer.visibility = if (canReply) View.VISIBLE else View.GONE
        conversationUnavailable.visibility = if (canReply) View.GONE else View.VISIBLE
        if (messages.isNotEmpty()) conversationList.scrollToPosition(messages.lastIndex)
    }

    private fun sendConversationMessage() {
        val target = selectedTarget ?: return
        val text = conversationInput.text.toString().trim().take(32_000)
        if (text.isEmpty()) return
        val credentials = SecretStore.load(this, target.pairId) ?: return
        conversationSend.isEnabled = false
        findViewById<TextView>(R.id.conversation_status).text = "Sending securely..."
        executor.execute {
            runCatching {
                val sent = RelayClient.sendCommand(
                    credentials,
                    target.projectId,
                    target.terminal.id,
                    text,
                )
                MessageStore(this).putOutgoing(target, sent.id, sent.sentAt, text)
            }.onSuccess {
                runOnUiThread {
                    conversationSend.isEnabled = true
                    conversationInput.text.clear()
                    refreshConversation()
                }
            }.onFailure { error ->
                runOnUiThread {
                    conversationSend.isEnabled = true
                    findViewById<TextView>(R.id.conversation_status).text =
                        error.message ?: "Could not send this message."
                }
            }
        }
    }

    private fun openIntentResponse() {
        val messageId = intent.getStringExtra("message_id") ?: return
        val message = MessageStore(this).latest().firstOrNull { it.id == messageId } ?: return
        intent.removeExtra("message_id")
        showPage(Page.RESPONSES)
        openResponse(message)
    }

    private fun setDetailChrome(detail: Boolean) {
        findViewById<View>(R.id.top_header).visibility = if (detail) View.GONE else View.VISIBLE
        findViewById<View>(R.id.bottom_nav).visibility = if (detail) View.GONE else View.VISIBLE
    }

    override fun onBackPressed() {
        when {
            conversationDetail.visibility == View.VISIBLE -> closeConversation()
            projectDetail.visibility == View.VISIBLE -> closeProject()
            else -> super.onBackPressed()
        }
    }

    private fun showPairingError(message: String) {
        scanButton.isEnabled = true
        pairingStatus.text = message
    }

    companion object {
        private const val STATE_PAGE = "selected-page"
    }
}
