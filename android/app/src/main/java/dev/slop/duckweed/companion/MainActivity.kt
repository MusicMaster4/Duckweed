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
import android.text.Editable
import android.text.TextWatcher
import android.text.format.DateUtils
import android.view.HapticFeedbackConstants
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.widget.Button
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.OnBackPressedCallback
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
import androidx.recyclerview.widget.SimpleItemAnimator
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import com.google.firebase.messaging.FirebaseMessaging
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import java.util.concurrent.Executors
import java.util.UUID

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
    private lateinit var conversationUnavailable: TextView
    private lateinit var conversationInput: EditText
    private lateinit var conversationSend: ImageButton
    private lateinit var conversationAttach: ImageButton
    private lateinit var conversationAttachmentPreview: View
    private lateinit var conversationAttachmentImage: ImageView
    private lateinit var conversationAttachmentName: TextView
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
    private val conversationAdapter = ConversationAdapter(::retryConversationMessage)
    private val executor = Executors.newSingleThreadExecutor()
    private val storageExecutor = Executors.newSingleThreadExecutor()
    private lateinit var draftStore: DraftStore
    private var receiverRegistered = false
    private var syncingNotificationsToggle = false
    private var updateAvailable: AndroidUpdateManifest? = null
    private var selectedPage = Page.ACTIVITY
    private var selectedProject: ProjectRow? = null
    private var selectedTarget: ConversationTarget? = null
    private var legacyResponse: CompletionRecord? = null
    private var conversationReturnsToProject = false
    private var conversationShouldStickToBottom = true
    private var selectedDraftAttachment: MobileImageAttachment? = null
    private val deliveryChecks = mutableSetOf<String>()
    private val draftPersistRunnable = Runnable { writeCurrentDraft() }
    private var refreshRequestedAt = 0L
    private var refreshSnapshotVersion = 0L
    private var cachedSnapshots: List<WorkspaceSnapshot> = emptyList()
    private var unreadConversationKeys: Set<Pair<String, String>> = emptySet()
    private var remoteStateLoading = false
    private var remoteStateReloadPending = false
    private val connectionTicker = object : Runnable {
        override fun run() {
            refreshConnectionHealth()
            refreshWorkspaces()
            refreshConversationAvailability()
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

    private val imagePicker = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        uri ?: return@registerForActivityResult
        conversationAttach.isEnabled = false
        findViewById<TextView>(R.id.conversation_status).text = "Preparing image..."
        executor.execute {
            runCatching { MobileImageTools.read(this, uri) }
                .onSuccess { attachment ->
                    runOnUiThread {
                        conversationAttach.isEnabled = true
                        selectedDraftAttachment = attachment
                        persistCurrentDraft()
                        renderDraftAttachment()
                        refreshConversation()
                        conversationInput.requestFocus()
                    }
                }
                .onFailure { error ->
                    runOnUiThread {
                        conversationAttach.isEnabled = true
                        Toast.makeText(
                            this,
                            error.message ?: "Could not attach this image.",
                            Toast.LENGTH_LONG,
                        ).show()
                        refreshConversation()
                    }
                }
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
        draftStore = DraftStore(this)
        storageExecutor.execute { MessageStore(this).recoverInterruptedSends() }

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
        conversationAttach = findViewById(R.id.conversation_attach)
        conversationAttachmentPreview = findViewById(R.id.conversation_attachment_preview)
        conversationAttachmentImage = findViewById(R.id.conversation_attachment_image)
        conversationAttachmentName = findViewById(R.id.conversation_attachment_name)
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
            tuneListMotion(this)
        }
        findViewById<RecyclerView>(R.id.project_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = projectAdapter
            tuneListMotion(this)
        }
        findViewById<RecyclerView>(R.id.terminal_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = terminalAdapter
            tuneListMotion(this)
        }
        findViewById<RecyclerView>(R.id.conversations_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = conversationsAdapter
            tuneListMotion(this)
        }
        conversationList.apply {
            layoutManager = LinearLayoutManager(this@MainActivity).apply { stackFromEnd = true }
            adapter = conversationAdapter
            tuneListMotion(this)
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
        conversationAttach.setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
            imagePicker.launch("image/*")
        }
        findViewById<View>(R.id.conversation_attachment_remove).setOnClickListener {
            it.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
            selectedDraftAttachment = null
            persistCurrentDraft()
            renderDraftAttachment()
        }
        conversationInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(value: Editable?) {
                scheduleDraftPersist()
                updateComposerActions()
            }
        })
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    conversationDetail.visibility == View.VISIBLE -> closeConversation()
                    projectDetail.visibility == View.VISIBLE -> closeProject()
                    selectedPage == Page.SETTINGS -> showPage(Page.ACTIVITY)
                    else -> {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                    }
                }
            }
        })

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
        persistCurrentDraft()
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
        persistCurrentDraft()
        outState.putString(STATE_PAGE, selectedPage.name)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        if (::connectionDot.isInitialized) connectionDot.removeCallbacks(connectionTicker)
        executor.shutdownNow()
        storageExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun configureNavigation() {
        fun bind(id: Int, page: Page) {
            findViewById<View>(id).setOnClickListener { view ->
                if (selectedPage != page) {
                    view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                    showPage(page)
                }
            }
        }
        bind(R.id.nav_responses, Page.ACTIVITY)
        bind(R.id.nav_projects, Page.PROJECTS)
        bind(R.id.nav_conversations, Page.CONVERSATIONS)
        bind(R.id.settings_button, Page.SETTINGS)
        showPage(Page.ACTIVITY)
    }

    private fun tuneListMotion(list: RecyclerView) {
        (list.itemAnimator as? SimpleItemAnimator)?.apply {
            supportsChangeAnimations = false
            addDuration = 130L
            removeDuration = 100L
            moveDuration = 150L
            changeDuration = 100L
        }
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
        persistCurrentDraft()
        val previousPage = selectedPage
        selectedProject = null
        selectedTarget = null
        selectedDraftAttachment = null
        legacyResponse = null
        projectDetail.visibility = View.GONE
        conversationDetail.visibility = View.GONE
        setDetailChrome(false)
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
        if (previousPage == page) {
            pages.forEach { (candidate, id) ->
                findViewById<View>(id).apply {
                    animate().cancel()
                    alpha = 1f
                    translationY = 0f
                    visibility = if (candidate == page) View.VISIBLE else View.GONE
                }
            }
        } else {
            val outgoing = pages[previousPage]?.let { findViewById<View>(it) }
            val incoming = findViewById<View>(pages.getValue(page))
            outgoing?.animate()?.cancel()
            incoming.animate().cancel()
            incoming.alpha = 0f
            incoming.translationY = 10f * resources.displayMetrics.density
            incoming.visibility = View.VISIBLE
            outgoing?.animate()
                ?.alpha(0f)
                ?.setDuration(90L)
                ?.withEndAction {
                    outgoing.visibility = View.GONE
                    outgoing.alpha = 1f
                }
                ?.start()
            incoming.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(150L)
                .setInterpolator(DecelerateInterpolator())
                .start()
        }
        selectedPage = page
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
                            refreshRemoteState()
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
        snapshots: List<WorkspaceSnapshot> = cachedSnapshots,
    ) {
        if (!::connectionHealth.isInitialized) return
        val credentials = SecretStore.loadAll(this)
        val now = System.currentTimeMillis()
        val latest = snapshots.maxOfOrNull { it.updatedAt }
        val freshPairings = snapshots
            .filter { MobileSyncPolicy.isDesktopOnline(it.updatedAt, now, CONNECTION_FRESH_MS) }
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
        if (remoteStateLoading) {
            remoteStateReloadPending = true
            return
        }
        remoteStateLoading = true
        storageExecutor.execute {
            val loaded = runCatching {
                val snapshots = WorkspaceStore(this).all()
                val openAgentTerminals = snapshots.flatMap { snapshot ->
                    snapshot.projects.flatMap { project ->
                        project.terminals
                            .filter { it.agent != null }
                            .map { Pair(snapshot.pairId, it.id) }
                    }
                }.toSet()
                val store = MessageStore(this)
                Triple(
                    snapshots,
                    store.latestForOpenAgents(openAgentTerminals, 50),
                    store.unreadConversationKeys(),
                )
            }
            runOnUiThread {
                remoteStateLoading = false
                if (!isFinishing && !isDestroyed) {
                    loaded.onSuccess { (snapshots, messages, unreadKeys) ->
                        applyRemoteState(snapshots, messages, unreadKeys)
                    }.onFailure {
                        connectionHealth.text = "Could not load encrypted mobile state."
                    }
                }
                if (remoteStateReloadPending && !isFinishing && !isDestroyed) {
                    remoteStateReloadPending = false
                    refreshRemoteState()
                }
            }
        }
    }

    private fun applyRemoteState(
        snapshots: List<WorkspaceSnapshot>,
        messages: List<CompletionRecord>,
        unreadKeys: Set<Pair<String, String>>,
    ) {
        cachedSnapshots = snapshots
        unreadConversationKeys = unreadKeys
        if (refreshRequestedAt > 0 && snapshots.any { it.updatedAt > refreshSnapshotVersion }) {
            finishRemoteRefresh()
        }
        legacyResponse?.let { current ->
            legacyResponse = messages.firstOrNull { it.id == current.id } ?: current
        }
        messageAdapter.submit(messages)
        emptyState.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE
        refreshWorkspaces(snapshots, unreadKeys)
        refreshConnectionHealth(snapshots)
        if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
        openIntentResponse()
    }

    private fun refreshWorkspaces(
        snapshots: List<WorkspaceSnapshot> = cachedSnapshots,
        unreadKeys: Set<Pair<String, String>> = unreadConversationKeys,
    ) {
        val now = System.currentTimeMillis()
        val onlinePairIds = snapshots
            .filter { MobileSyncPolicy.isDesktopOnline(it.updatedAt, now, CONNECTION_FRESH_MS) }
            .mapTo(mutableSetOf()) { it.pairId }
        val rows = snapshots.flatMap { snapshot ->
            snapshot.projects.map {
                ProjectRow(snapshot.pairId, it, snapshot.pairId in onlinePairIds)
            }
        }
        projectAdapter.submit(rows)
        projectsEmpty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
        val targets = rows.flatMap { row ->
            row.project.terminals.map { terminal ->
                ConversationTarget(
                    row.pairId,
                    row.project.id,
                    row.project.name,
                    terminal,
                    Pair(row.pairId, terminal.id) in unreadKeys,
                    row.desktopOnline,
                )
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
            terminalAdapter.submit(selectedProject, unreadKeys)
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
                        Pair(row.pairId, terminal.id) in unreadKeys,
                        row.desktopOnline,
                    )
                }
            }
        }
    }

    private fun openProject(row: ProjectRow) {
        persistCurrentDraft()
        selectedProject = row
        terminalAdapter.submit(row, unreadConversationKeys)
        findViewById<TextView>(R.id.project_detail_title).text = row.project.name
        findViewById<TextView>(R.id.project_detail_meta).text = buildList {
            add("${row.project.terminals.size} open terminals")
            row.project.branch?.let { add(it) }
        }.joinToString("  •  ")
        conversationDetail.visibility = View.GONE
        setDetailChrome(true)
        animateDetailIn(projectDetail)
    }

    private fun closeProject() {
        selectedProject = null
        animateDetailOut(projectDetail)
        setDetailChrome(false)
    }

    private fun openResponse(message: CompletionRecord) {
        persistCurrentDraft()
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
        setDetailChrome(true)
        refreshConversation()
        animateDetailIn(conversationDetail)
    }

    private fun findConversationTarget(message: CompletionRecord): ConversationTarget? {
        val pairId = message.pairId ?: return null
        val terminalId = message.terminalId ?: return null
        return cachedSnapshots
            .firstOrNull { it.pairId == pairId }
            ?.projects
            ?.asSequence()
            ?.mapNotNull { project ->
                project.terminals.firstOrNull { it.id == terminalId }?.let { terminal ->
                    ConversationTarget(
                        pairId,
                        project.id,
                        project.name,
                        terminal,
                        Pair(pairId, terminal.id) in unreadConversationKeys,
                        isDesktopOnline(pairId),
                    )
                }
            }
            ?.firstOrNull()
    }

    private fun openConversation(target: ConversationTarget, returnToProject: Boolean) {
        persistCurrentDraft()
        MessageStore(this).markConversationRead(target.pairId, target.terminal.id)
        messageAdapter.markConversationRead(target.pairId, target.terminal.id)
        unreadConversationKeys = unreadConversationKeys - Pair(target.pairId, target.terminal.id)
        terminalAdapter.markRead(target.pairId, target.terminal.id)
        conversationsAdapter.markRead(target.pairId, target.terminal.id)
        selectedTarget = target.copy(unread = false)
        legacyResponse = null
        conversationReturnsToProject = returnToProject
        conversationShouldStickToBottom = true
        val draft = draftStore.load(target.pairId, target.terminal.id)
        selectedDraftAttachment = draft.attachment
        conversationInput.setText(draft.text)
        conversationInput.setSelection(conversationInput.text.length)
        renderDraftAttachment()
        projectDetail.visibility = View.GONE
        setDetailChrome(true)
        refreshConversation()
        animateDetailIn(conversationDetail)
    }

    private fun closeConversation() {
        persistCurrentDraft()
        selectedTarget = null
        selectedDraftAttachment = null
        legacyResponse = null
        animateDetailOut(conversationDetail)
        if (conversationReturnsToProject && selectedProject != null) {
            animateDetailIn(projectDetail)
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
            conversationUnavailable.text =
                "Replying requires the current desktop version and an open terminal."
            conversationUnavailable.visibility = View.VISIBLE
            return
        }
        val target = selectedTarget ?: return
        val synced = target.terminal.conversation.map { message ->
            CompletionRecord(
                id = "workspace:${target.pairId}:${target.terminal.id}:${message.id}",
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
        val desktopOnline = isDesktopOnline(target.pairId)
        findViewById<TextView>(R.id.conversation_title).text =
            target.terminal.agent ?: target.terminal.title
        findViewById<TextView>(R.id.conversation_status).text = buildList {
            add(target.projectName)
            target.terminal.model?.let { add(it) }
            add(
                when {
                    !desktopOnline -> "Desktop offline"
                    thinking -> "Thinking"
                    target.terminal.status == "waiting" -> "Needs attention"
                    target.terminal.status == "exited" -> "Closed"
                    else -> "Ready"
                },
            )
        }.joinToString("  •  ")
        val shouldScrollToBottom = conversationShouldStickToBottom
        conversationAdapter.submit(messages)
        setAnimatedVisibility(conversationThinking, thinking && desktopOnline)
        renderApproval(target)
        refreshConversationAvailability()
        messages.filter { it.kind == "user" && it.deliveryState == "sent" }
            .takeLast(5)
            .forEach { trackDelivery(it.id, target.pairId) }
        if (shouldScrollToBottom && messages.isNotEmpty()) {
            conversationList.post {
                conversationList.scrollToPosition(messages.lastIndex)
            }
        }
    }

    private fun renderApproval(target: ConversationTarget) {
        val permission = target.terminal.permission
        if (permission == null) {
            setAnimatedVisibility(conversationApproval, false)
            approvalActions.removeAllViews()
            return
        }
        setAnimatedVisibility(conversationApproval, true)
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
                setOnClickListener { view ->
                    view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                    sendApproval(target, permission, option)
                }
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

    private fun isDesktopOnline(pairId: String, now: Long = System.currentTimeMillis()): Boolean =
        MobileSyncPolicy.isDesktopOnline(
            cachedSnapshots.firstOrNull { it.pairId == pairId }?.updatedAt,
            now,
            CONNECTION_FRESH_MS,
        )

    private fun refreshConversationAvailability() {
        if (!::conversationComposer.isInitialized) return
        val target = selectedTarget ?: return
        val paired = SecretStore.load(this, target.pairId) != null
        val open = target.terminal.status != "exited"
        val online = isDesktopOnline(target.pairId)
        val canCompose = paired && open
        conversationComposer.visibility = if (canCompose) View.VISIBLE else View.GONE
        conversationAttach.visibility =
            if (canCompose && target.terminal.agent != null) View.VISIBLE else View.GONE
        conversationUnavailable.text = when {
            !paired -> "Pair this desktop again before sending messages."
            !open -> "This terminal is closed and cannot receive messages."
            !online -> "This desktop instance is offline and cannot receive messages."
            else -> ""
        }
        conversationUnavailable.visibility = if (canCompose && online) View.GONE else View.VISIBLE
        for (index in 0 until approvalActions.childCount) {
            approvalActions.getChildAt(index).isEnabled = online
        }
        updateComposerActions()
    }

    private fun showDesktopOffline() {
        val message = "This desktop instance is offline and cannot receive messages."
        conversationUnavailable.text = message
        conversationUnavailable.visibility = View.VISIBLE
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        updateComposerActions()
    }

    private fun sendApproval(
        target: ConversationTarget,
        permission: RemotePermission,
        option: RemotePermissionOption,
    ) {
        if (!isDesktopOnline(target.pairId)) {
            showDesktopOffline()
            return
        }
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
        refreshSnapshotVersion = cachedSnapshots.maxOfOrNull { it.updatedAt } ?: 0L
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
        val attachments = listOfNotNull(selectedDraftAttachment)
        if (text.isEmpty() && attachments.isEmpty()) return
        if (attachments.isNotEmpty() && target.terminal.agent == null) {
            Toast.makeText(this, "Images require an active agent session.", Toast.LENGTH_LONG).show()
            return
        }
        if (!isDesktopOnline(target.pairId)) {
            showDesktopOffline()
            return
        }
        val credentials = SecretStore.load(this, target.pairId) ?: return
        val commandId = UUID.randomUUID().toString()
        val sentAt = System.currentTimeMillis()
        conversationSend.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        MessageStore(this).putOutgoing(
            target,
            commandId,
            sentAt,
            text,
            attachments,
            deliveryState = "sending",
        )
        draftStore.clear(target.pairId, target.terminal.id)
        selectedDraftAttachment = null
        conversationInput.text.clear()
        renderDraftAttachment()
        conversationShouldStickToBottom = true
        refreshConversation()
        executor.execute {
            runCatching {
                RelayClient.sendCommand(
                    credentials,
                    target.projectId,
                    target.terminal.id,
                    text,
                    attachments,
                    commandId,
                    sentAt,
                )
            }.onSuccess {
                MessageStore(this).updateOutgoingState(commandId, "sent")
                runOnUiThread {
                    refreshConversation()
                    trackDelivery(commandId, target.pairId)
                }
            }.onFailure { error ->
                MessageStore(this).updateOutgoingState(
                    commandId,
                    "failed",
                    error.message ?: "Could not send this message.",
                )
                runOnUiThread {
                    refreshConversation()
                }
            }
        }
    }

    private fun retryConversationMessage(message: CompletionRecord) {
        if (message.kind != "user" || message.deliveryState != "failed") return
        val pairId = message.pairId ?: return
        val projectId = message.projectId ?: return
        val terminalId = message.terminalId ?: return
        if (!isDesktopOnline(pairId)) {
            showDesktopOffline()
            return
        }
        val credentials = SecretStore.load(this, pairId) ?: return
        val text = message.response.orEmpty()
        if (text.isBlank() && message.attachments.none { it.dataUrl != null }) {
            Toast.makeText(this, "This image is no longer available to retry.", Toast.LENGTH_LONG).show()
            return
        }
        conversationList.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        MessageStore(this).updateOutgoingState(message.id, "sending")
        refreshConversation()
        executor.execute {
            runCatching {
                RelayClient.sendCommand(
                    credentials,
                    projectId,
                    terminalId,
                    text,
                    message.attachments,
                    message.id,
                    System.currentTimeMillis(),
                )
            }.onSuccess {
                MessageStore(this).updateOutgoingState(message.id, "sent")
                runOnUiThread {
                    refreshConversation()
                    trackDelivery(message.id, pairId)
                }
            }.onFailure { error ->
                MessageStore(this).updateOutgoingState(
                    message.id,
                    "failed",
                    error.message ?: "Could not send this message.",
                )
                runOnUiThread { refreshConversation() }
            }
        }
    }

    private fun trackDelivery(messageId: String, pairId: String) {
        if (!deliveryChecks.add(messageId)) return
        scheduleDeliveryCheck(messageId, pairId, 0)
    }

    private fun scheduleDeliveryCheck(messageId: String, pairId: String, attempt: Int) {
        conversationList.postDelayed({
            if (isFinishing || isDestroyed) {
                deliveryChecks.remove(messageId)
                return@postDelayed
            }
            executor.execute {
                val credentials = SecretStore.load(this, pairId)
                val delivered = credentials?.let {
                    runCatching { !RelayClient.isCommandPending(it, messageId) }.getOrNull()
                }
                runOnUiThread {
                    when {
                        delivered == true -> {
                            MessageStore(this).updateOutgoingState(messageId, "delivered")
                            deliveryChecks.remove(messageId)
                            if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
                        }
                        attempt >= 20 -> deliveryChecks.remove(messageId)
                        else -> scheduleDeliveryCheck(messageId, pairId, attempt + 1)
                    }
                }
            }
        }, if (attempt == 0) 1_200L else 3_000L)
    }

    private fun persistCurrentDraft() {
        if (!::draftStore.isInitialized || !::conversationInput.isInitialized) return
        conversationInput.removeCallbacks(draftPersistRunnable)
        writeCurrentDraft()
    }

    private fun scheduleDraftPersist() {
        if (!::conversationInput.isInitialized) return
        conversationInput.removeCallbacks(draftPersistRunnable)
        conversationInput.postDelayed(draftPersistRunnable, 350L)
    }

    private fun writeCurrentDraft() {
        if (!::draftStore.isInitialized || !::conversationInput.isInitialized) return
        val target = selectedTarget ?: return
        draftStore.save(
            target.pairId,
            target.terminal.id,
            ConversationDraft(conversationInput.text.toString(), selectedDraftAttachment),
        )
    }

    private fun renderDraftAttachment() {
        if (!::conversationAttachmentPreview.isInitialized) return
        val attachment = selectedDraftAttachment
        if (attachment == null) {
            setAnimatedVisibility(conversationAttachmentPreview, false)
            conversationAttachmentImage.setImageDrawable(null)
        } else {
            conversationAttachmentName.text = attachment.name
            conversationAttachmentImage.setImageBitmap(MobileImageTools.decodePreview(attachment))
            setAnimatedVisibility(conversationAttachmentPreview, true)
        }
        updateComposerActions()
    }

    private fun updateComposerActions() {
        if (!::conversationSend.isInitialized || !::conversationInput.isInitialized) return
        val target = selectedTarget
        conversationSend.isEnabled =
            target != null &&
            target.terminal.status != "exited" &&
            isDesktopOnline(target.pairId) &&
            (conversationInput.text.isNotBlank() || selectedDraftAttachment != null)
        conversationSend.alpha = if (conversationSend.isEnabled) 1f else 0.38f
    }

    private fun openIntentResponse() {
        val messageId = intent.getStringExtra("message_id") ?: return
        val message = MessageStore(this).response(messageId) ?: return
        intent.removeExtra("message_id")
        showPage(Page.ACTIVITY)
        openResponse(message)
    }

    private fun animateDetailIn(view: View) {
        if (view.visibility == View.VISIBLE && view.alpha == 1f) return
        view.animate().cancel()
        view.visibility = View.VISIBLE
        view.alpha = 0f
        view.translationX = 22f * resources.displayMetrics.density
        view.animate()
            .alpha(1f)
            .translationX(0f)
            .setDuration(170L)
            .setInterpolator(DecelerateInterpolator())
            .start()
    }

    private fun animateDetailOut(view: View) {
        if (view.visibility != View.VISIBLE) return
        view.animate().cancel()
        view.animate()
            .alpha(0f)
            .translationX(14f * resources.displayMetrics.density)
            .setDuration(110L)
            .withEndAction {
                view.visibility = View.GONE
                view.alpha = 1f
                view.translationX = 0f
            }
            .start()
    }

    private fun setAnimatedVisibility(view: View, visible: Boolean) {
        if (visible && view.visibility == View.VISIBLE) return
        if (!visible && view.visibility != View.VISIBLE) return
        view.animate().cancel()
        if (visible) {
            view.visibility = View.VISIBLE
            view.alpha = 0f
            view.translationY = 6f * resources.displayMetrics.density
            view.animate()
                .alpha(1f)
                .translationY(0f)
                .setDuration(130L)
                .setInterpolator(DecelerateInterpolator())
                .start()
        } else {
            view.animate()
                .alpha(0f)
                .translationY(4f * resources.displayMetrics.density)
                .setDuration(90L)
                .withEndAction {
                    view.visibility = View.GONE
                    view.alpha = 1f
                    view.translationY = 0f
                }
                .start()
        }
    }

    private fun setDetailChrome(detail: Boolean) {
        listOf(
            findViewById<View>(R.id.top_header),
            findViewById<View>(R.id.bottom_nav),
        ).forEach { view ->
            view.animate().cancel()
            if (detail) {
                if (view.visibility != View.VISIBLE) return@forEach
                view.animate()
                    .alpha(0f)
                    .setDuration(80L)
                    .withEndAction {
                        view.visibility = View.GONE
                        view.alpha = 1f
                    }
                    .start()
            } else if (view.visibility != View.VISIBLE) {
                view.alpha = 0f
                view.visibility = View.VISIBLE
                view.animate().alpha(1f).setDuration(120L).start()
            }
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
