package dev.slop.duckweed.companion

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.ColorStateList
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.firebase.messaging.FirebaseMessaging
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {
    private enum class Page { ACTIVITY, PROJECTS, CONVERSATIONS, SETTINGS }

    private lateinit var pairingStatus: TextView
    private lateinit var scanButton: Button
    private lateinit var disconnectButton: Button
    private lateinit var emptyState: View
    private lateinit var notificationsToggle: SwitchCompat
    private lateinit var updateStatus: TextView
    private lateinit var updateButton: Button
    private lateinit var updateProgress: ProgressBar
    private lateinit var projectsEmpty: View
    private lateinit var conversationsEmpty: View
    private lateinit var connectionDot: View
    private lateinit var headerConnectionStatus: TextView
    private lateinit var connectionHealth: TextView
    private lateinit var connectionLastSync: TextView
    private lateinit var retryConnectionButton: Button
    private lateinit var projectDetail: View
    private lateinit var conversationDetail: View
    private lateinit var conversationThinking: View
    private lateinit var conversationComposer: View
    private lateinit var conversationUnavailable: View
    private lateinit var conversationInput: EditText
    private lateinit var conversationSend: TextView
    private lateinit var conversationList: RecyclerView
    private lateinit var conversationApproval: View
    private lateinit var approvalTitle: TextView
    private lateinit var approvalDetail: TextView
    private lateinit var approvalCommand: TextView
    private lateinit var approvalActions: LinearLayout
    private lateinit var responsesRefresh: SwipeRefreshLayout
    private lateinit var projectsRefresh: SwipeRefreshLayout
    private lateinit var appUpdater: AppUpdater
    private val messageAdapter = MessageAdapter { openResponse(it) }
    private val projectAdapter = ProjectAdapter { openProject(it) }
    private val terminalAdapter = TerminalAdapter { openConversation(it, true) }
    private val conversationsAdapter = TerminalAdapter { openConversation(it, false) }
    private val conversationAdapter = ConversationAdapter()
    private val executor = Executors.newSingleThreadExecutor()
    private var receiverRegistered = false
    private var syncingNotificationsToggle = false
    private var updateAvailable: AndroidUpdateManifest? = null
    private var selectedPage = Page.ACTIVITY
    private var selectedProject: ProjectRow? = null
    private var selectedTarget: ConversationTarget? = null
    private var legacyResponse: CompletionRecord? = null
    private var conversationReturnsToProject = false
    private var conversationShouldStickToBottom = true
    private var refreshRequestedAt = 0L
    private var refreshSnapshotVersion = 0L
    private val connectionTicker = object : Runnable {
        override fun run() {
            refreshConnectionHealth()
            connectionDot.postDelayed(this, 30_000)
        }
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        NotificationPreference.setEnabled(this, granted)
        syncNotificationToggle()
        if (granted) {
            showPendingNotifications()
        } else {
            MessageStore(this).dismissPendingNotifications()
        }
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
        WindowCompat.setDecorFitsSystemWindows(window, false)
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
        conversationsEmpty = findViewById(R.id.conversations_empty)
        connectionDot = findViewById(R.id.connection_dot)
        headerConnectionStatus = findViewById(R.id.header_connection_status)
        connectionHealth = findViewById(R.id.connection_health)
        connectionLastSync = findViewById(R.id.connection_last_sync)
        retryConnectionButton = findViewById(R.id.retry_connection_button)
        projectDetail = findViewById(R.id.project_detail)
        conversationDetail = findViewById(R.id.conversation_detail)
        conversationThinking = findViewById(R.id.conversation_thinking)
        conversationComposer = findViewById(R.id.conversation_composer)
        conversationUnavailable = findViewById(R.id.conversation_unavailable)
        conversationInput = findViewById(R.id.conversation_input)
        conversationSend = findViewById(R.id.conversation_send)
        conversationList = findViewById(R.id.conversation_list)
        conversationApproval = findViewById(R.id.conversation_approval)
        approvalTitle = findViewById(R.id.approval_title)
        approvalDetail = findViewById(R.id.approval_detail)
        approvalCommand = findViewById(R.id.approval_command)
        approvalActions = findViewById(R.id.approval_actions)
        responsesRefresh = findViewById(R.id.responses_page)
        projectsRefresh = findViewById(R.id.projects_page)

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
        findViewById<RecyclerView>(R.id.conversations_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = conversationsAdapter
        }
        conversationList.apply {
            layoutManager = LinearLayoutManager(this@MainActivity).apply { stackFromEnd = true }
            adapter = conversationAdapter
            addOnScrollListener(object : RecyclerView.OnScrollListener() {
                override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) {
                    conversationShouldStickToBottom = !recyclerView.canScrollVertically(1)
                }
            })
        }
        responsesRefresh.setOnChildScrollUpCallback { _, _ ->
            findViewById<RecyclerView>(R.id.message_list).canScrollVertically(-1)
        }
        projectsRefresh.setOnChildScrollUpCallback { _, _ ->
            findViewById<RecyclerView>(R.id.project_list).canScrollVertically(-1)
        }
        responsesRefresh.setOnRefreshListener { requestRemoteRefresh() }
        projectsRefresh.setOnRefreshListener { requestRemoteRefresh() }
        findViewById<View>(R.id.project_back).setOnClickListener { closeProject() }
        findViewById<View>(R.id.conversation_back).setOnClickListener { closeConversation() }
        conversationSend.setOnClickListener { sendConversationMessage() }

        combineSettingsSections()
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
        retryConnectionButton.setOnClickListener { requestRemoteRefresh(showSpinner = false) }
        requestNotificationPermissionIfEnabled()
        refreshPairingStatus()
        refreshPushRegistration()
        refreshRemoteState()
        connectionDot.post(connectionTicker)

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
        requestRemoteRefresh(showSpinner = false)
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
        if (::connectionDot.isInitialized) connectionDot.removeCallbacks(connectionTicker)
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun configureNavigation() {
        findViewById<View>(R.id.nav_responses).setOnClickListener { showPage(Page.ACTIVITY) }
        findViewById<View>(R.id.nav_projects).setOnClickListener { showPage(Page.PROJECTS) }
        findViewById<View>(R.id.nav_conversations).setOnClickListener { showPage(Page.CONVERSATIONS) }
        findViewById<View>(R.id.settings_button).setOnClickListener { showPage(Page.SETTINGS) }
        showPage(Page.ACTIVITY)
    }

    private fun combineSettingsSections() {
        val updateContent = findViewById<View>(R.id.update_content)
        (updateContent.parent as? ViewGroup)?.removeView(updateContent)
        findViewById<LinearLayout>(R.id.settings_content).addView(updateContent)
    }

    private fun configureSystemBarInsets() {
        val root = findViewById<View>(R.id.app_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val systemArea = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val keyboardArea = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.updatePadding(
                left = systemArea.left,
                top = systemArea.top,
                right = systemArea.right,
                bottom = maxOf(systemArea.bottom, keyboardArea.bottom),
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
            Page.ACTIVITY to R.id.responses_page,
            Page.PROJECTS to R.id.projects_page,
            Page.CONVERSATIONS to R.id.conversations_page,
            Page.SETTINGS to R.id.connections_page,
        )
        val navigation = mapOf(
            Page.ACTIVITY to R.id.nav_responses,
            Page.PROJECTS to R.id.nav_projects,
            Page.CONVERSATIONS to R.id.nav_conversations,
        )
        pages.forEach { (candidate, id) ->
            findViewById<View>(id).visibility = if (candidate == page) View.VISIBLE else View.GONE
        }
        navigation.forEach { (candidate, id) -> findViewById<View>(id).isSelected = candidate == page }
        findViewById<View>(R.id.settings_button).isSelected = page == Page.SETTINGS
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
                val store = MessageStore(this)
                store.dismissPendingNotifications()
                NotificationTools.cancel(this, store.latest())
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
        if (!NotificationPreference.isEnabled(this)) {
            MessageStore(this).dismissPendingNotifications()
            return
        }
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
        refreshConnectionHealth()
    }

    private fun refreshConnectionHealth(
        snapshots: List<WorkspaceSnapshot> = WorkspaceStore(this).all(),
    ) {
        if (!::connectionHealth.isInitialized) return
        val credentials = SecretStore.loadAll(this)
        val now = System.currentTimeMillis()
        val latest = snapshots.maxOfOrNull { it.updatedAt }
        val freshPairings = snapshots
            .filter { now - it.updatedAt <= CONNECTION_FRESH_MS }
            .map { it.pairId }
            .toSet()
        val color: Int
        when {
            credentials.isEmpty() -> {
                headerConnectionStatus.text = "Not paired"
                connectionHealth.text = "No desktop connected"
                connectionLastSync.text = "Pair a desktop to start encrypted sync."
                color = R.color.duckweed_text_faint
            }
            freshPairings.isNotEmpty() -> {
                headerConnectionStatus.text = "Online"
                connectionHealth.text = if (credentials.size == 1) {
                    "Desktop online"
                } else {
                    "${freshPairings.size} of ${credentials.size} desktops online"
                }
                connectionLastSync.text = latest?.let {
                    "Last synced ${DateUtils.getRelativeTimeSpanString(it, now, DateUtils.SECOND_IN_MILLIS)}"
                }.orEmpty()
                color = R.color.duckweed_accent
            }
            latest != null -> {
                headerConnectionStatus.text = "Offline"
                connectionHealth.text = "Desktop may be offline"
                connectionLastSync.text =
                    "Last synced ${DateUtils.getRelativeTimeSpanString(latest, now, DateUtils.SECOND_IN_MILLIS)}"
                color = R.color.duckweed_error
            }
            else -> {
                headerConnectionStatus.text = "Waiting"
                connectionHealth.text = "Waiting for the first desktop sync"
                connectionLastSync.text = "Keep Duckweed open on desktop, then retry."
                color = R.color.duckweed_attention
            }
        }
        connectionDot.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(this, color))
        retryConnectionButton.visibility = if (credentials.isEmpty()) View.GONE else View.VISIBLE
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
        val snapshots = WorkspaceStore(this).all()
        if (refreshRequestedAt > 0 && snapshots.any { it.updatedAt > refreshSnapshotVersion }) {
            finishRemoteRefresh()
        }
        val openAgentTerminals = snapshots.flatMap { snapshot ->
            snapshot.projects.flatMap { project ->
                project.terminals
                    .filter { it.agent != null }
                    .map { Pair(snapshot.pairId, it.id) }
            }
        }.toSet()
        val messages = MessageStore(this).latestForOpenAgents(openAgentTerminals, 50)
        legacyResponse?.let { current ->
            legacyResponse = messages.firstOrNull { it.id == current.id } ?: current
        }
        messageAdapter.submit(messages)
        emptyState.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE
        refreshWorkspaces(snapshots)
        refreshConnectionHealth(snapshots)
        if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
        openIntentResponse()
    }

    private fun refreshWorkspaces(snapshots: List<WorkspaceSnapshot> = WorkspaceStore(this).all()) {
        val rows = snapshots.flatMap { snapshot ->
            snapshot.projects.map { ProjectRow(snapshot.pairId, it) }
        }
        projectAdapter.submit(rows)
        projectsEmpty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        val targets = rows.flatMap { row ->
            row.project.terminals.map { terminal ->
                ConversationTarget(row.pairId, row.project.id, row.project.name, terminal)
            }
        }.sortedWith(
            compareBy<ConversationTarget> {
                when (it.terminal.status) {
                    "waiting" -> 0
                    "working" -> 1
                    "idle" -> 2
                    else -> 3
                }
            }.thenBy { it.projectName.lowercase() },
        )
        conversationsAdapter.submitTargets(targets)
        conversationsEmpty.visibility = if (targets.isEmpty()) View.VISIBLE else View.GONE

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
        MessageStore(this).markRead(message.id)
        messageAdapter.markRead(message.id)
        val target = findConversationTarget(message)
        if (target != null) {
            openConversation(target, false)
            return
        }
        selectedTarget = null
        legacyResponse = message
        conversationReturnsToProject = false
        conversationShouldStickToBottom = true
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
        MessageStore(this).markConversationRead(target.pairId, target.terminal.id)
        messageAdapter.markConversationRead(target.pairId, target.terminal.id)
        selectedTarget = target
        legacyResponse = null
        conversationReturnsToProject = returnToProject
        conversationShouldStickToBottom = true
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
            conversationApproval.visibility = View.GONE
            conversationComposer.visibility = View.GONE
            conversationUnavailable.visibility = View.VISIBLE
            return
        }
        val target = selectedTarget ?: return
        val synced = target.terminal.conversation.map { message ->
            CompletionRecord(
                id = "workspace:${target.pairId}:${message.id}",
                pairId = target.pairId,
                sentAt = message.sentAt,
                agent = target.terminal.agent ?: "Agent",
                project = target.projectName,
                projectId = target.projectId,
                terminalId = target.terminal.id,
                terminalTitle = target.terminal.title,
                kind = if (message.role == "user") "user" else "completed",
                response = message.text,
                durationMs = null,
                soundCue = null,
                workspace = null,
            )
        }
        val stored = MessageStore(this).conversation(target.pairId, target.terminal.id)
        val messages = mergeConversation(synced, stored)
        val last = messages.lastOrNull()
        val thinking = target.terminal.status == "working" ||
            (last?.kind == "user" && target.terminal.status != "waiting")
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
        val shouldScrollToBottom = conversationShouldStickToBottom
        conversationAdapter.submit(messages)
        conversationThinking.visibility = if (thinking) View.VISIBLE else View.GONE
        renderApproval(target)
        val canReply = SecretStore.load(this, target.pairId) != null && target.terminal.status != "exited"
        conversationComposer.visibility = if (canReply) View.VISIBLE else View.GONE
        conversationUnavailable.visibility = if (canReply) View.GONE else View.VISIBLE
        if (shouldScrollToBottom && messages.isNotEmpty()) {
            conversationList.post {
                conversationList.scrollToPosition(messages.lastIndex)
            }
        }
    }

    private fun renderApproval(target: ConversationTarget) {
        val permission = target.terminal.permission
        if (permission == null) {
            conversationApproval.visibility = View.GONE
            approvalActions.removeAllViews()
            return
        }
        conversationApproval.visibility = View.VISIBLE
        approvalTitle.text = permission.title
        approvalDetail.text = permission.detail
        approvalDetail.visibility = if (permission.detail.isNullOrBlank()) View.GONE else View.VISIBLE
        approvalCommand.text = permission.command
        approvalCommand.visibility = if (permission.command.isNullOrBlank()) View.GONE else View.VISIBLE
        approvalActions.removeAllViews()
        permission.options.forEach { option ->
            val affirmative = option.kind == "allow" || option.kind == "allow-always"
            val button = Button(this).apply {
                text = option.label
                setAllCaps(false)
                textSize = 13f
                setBackgroundResource(
                    if (affirmative) R.drawable.button_primary else R.drawable.button_secondary,
                )
                setTextColor(
                    ContextCompat.getColor(
                        this@MainActivity,
                        if (affirmative) R.color.duckweed_accent_ink else R.color.duckweed_text_dim,
                    ),
                )
                setOnClickListener { sendApproval(target, permission, option) }
            }
            approvalActions.addView(
                button,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    resources.getDimensionPixelSize(R.dimen.mobile_action_height),
                ).apply { topMargin = resources.getDimensionPixelSize(R.dimen.mobile_action_gap) },
            )
        }
    }

    private fun sendApproval(
        target: ConversationTarget,
        permission: RemotePermission,
        option: RemotePermissionOption,
    ) {
        val credentials = SecretStore.load(this, target.pairId) ?: return
        for (index in 0 until approvalActions.childCount) {
            approvalActions.getChildAt(index).isEnabled = false
        }
        findViewById<TextView>(R.id.conversation_status).text = "Sending approval securely..."
        executor.execute {
            runCatching {
                RelayClient.sendApproval(
                    credentials,
                    target.projectId,
                    target.terminal.id,
                    permission.id,
                    option.id,
                )
            }.onSuccess {
                runOnUiThread {
                    findViewById<TextView>(R.id.conversation_status).text =
                        "Decision sent. Waiting for desktop..."
                    requestRemoteRefresh(showSpinner = false)
                }
            }.onFailure { error ->
                runOnUiThread {
                    findViewById<TextView>(R.id.conversation_status).text =
                        error.message ?: "Could not send this decision."
                    renderApproval(target)
                }
            }
        }
    }

    private fun mergeConversation(
        synced: List<CompletionRecord>,
        stored: List<CompletionRecord>,
    ): List<CompletionRecord> {
        val merged = mutableListOf<CompletionRecord>()
        (synced + stored).sortedBy { it.sentAt }.forEach { candidate ->
            val duplicate = merged.indexOfLast { existing ->
                existing.kind == candidate.kind &&
                    existing.response == candidate.response &&
                    kotlin.math.abs(existing.sentAt - candidate.sentAt) <= 2 * 60_000
            }
            if (duplicate < 0) {
                merged += candidate
            } else if (!candidate.id.startsWith("workspace:")) {
                merged[duplicate] = candidate
            }
        }
        return merged
    }

    private fun requestRemoteRefresh(showSpinner: Boolean = true) {
        val credentials = SecretStore.loadAll(this)
        if (credentials.isEmpty()) {
            finishRemoteRefresh()
            refreshConnectionHealth()
            return
        }
        if (showSpinner) {
            if (selectedPage == Page.PROJECTS) projectsRefresh.isRefreshing = true
            if (selectedPage == Page.ACTIVITY) responsesRefresh.isRefreshing = true
        }
        retryConnectionButton.isEnabled = false
        connectionHealth.text = "Checking desktop connection..."
        refreshRequestedAt = System.currentTimeMillis()
        refreshSnapshotVersion = WorkspaceStore(this).all().maxOfOrNull { it.updatedAt } ?: 0L
        executor.execute {
            credentials.forEach { pairing ->
                runCatching { RelayClient.requestWorkspaceRefresh(pairing) }
            }
            responsesRefresh.postDelayed({
                refreshRemoteState()
                finishRemoteRefresh()
            }, 10_000)
        }
    }

    private fun finishRemoteRefresh() {
        refreshRequestedAt = 0
        refreshSnapshotVersion = 0
        if (::responsesRefresh.isInitialized) responsesRefresh.isRefreshing = false
        if (::projectsRefresh.isInitialized) projectsRefresh.isRefreshing = false
        if (::retryConnectionButton.isInitialized) retryConnectionButton.isEnabled = true
        refreshConnectionHealth()
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
                    conversationShouldStickToBottom = true
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
        val message = MessageStore(this).response(messageId) ?: return
        intent.removeExtra("message_id")
        showPage(Page.ACTIVITY)
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
            selectedPage == Page.SETTINGS -> showPage(Page.ACTIVITY)
            else -> super.onBackPressed()
        }
    }

    private fun showPairingError(message: String) {
        scanButton.isEnabled = true
        pairingStatus.text = message
    }

    companion object {
        private const val STATE_PAGE = "selected-page"
        private const val CONNECTION_FRESH_MS = 75_000L
    }
}
