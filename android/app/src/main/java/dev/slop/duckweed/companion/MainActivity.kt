package dev.slop.duckweed.companion

import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.view.inputmethod.InputMethodManager
import android.Manifest
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.ColorStateList
import android.content.pm.PackageManager
import android.graphics.drawable.ClipDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.TextWatcher
import android.text.format.DateUtils
import android.text.method.ScrollingMovementMethod
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.widget.Button
import android.widget.CheckBox
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationCompat
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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.Locale
import java.util.UUID

class MainActivity : AppCompatActivity() {
    private enum class Page { ACTIVITY, PROJECTS, CONVERSATIONS, SETTINGS }

    private lateinit var appRoot: View
    private lateinit var pairingStatus: TextView
    private lateinit var scanButton: Button
    private lateinit var disconnectButton: Button
    private lateinit var emptyState: View
    private lateinit var notificationsToggle: SwitchCompat
    private lateinit var appLockToggle: SwitchCompat
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
    private lateinit var usageLimitsContent: LinearLayout
    private lateinit var usageLimitsEmpty: TextView
    private lateinit var pendingNotice: TextView
    private lateinit var projectDetail: View
    private lateinit var conversationDetail: View
    private lateinit var conversationCommandsScroll: View
    private lateinit var conversationCommands: LinearLayout
    private lateinit var conversationComposer: View
    private lateinit var conversationUnavailable: TextView
    private lateinit var conversationInput: EditText
    private lateinit var conversationSend: ImageButton
    private lateinit var conversationAttach: ImageButton
    private lateinit var conversationAttachmentPreview: View
    private lateinit var conversationAttachmentImage: ImageView
    private lateinit var conversationAttachmentName: TextView
    private lateinit var conversationExperience: AgentExperienceView
    private var experienceUnavailable = false
    private var historyRequestedFor: Triple<String, String, String>? = null
    private lateinit var conversationsRefresh: SwipeRefreshLayout
    private lateinit var conversationList: RecyclerView
    private lateinit var conversationLatest: View
    private lateinit var conversationTerminal: TextView
    private lateinit var conversationPlan: View
    private lateinit var conversationPlanHead: View
    private lateinit var conversationPlanLabel: TextView
    private lateinit var conversationPlanCurrent: TextView
    private lateinit var conversationPlanCount: TextView
    private lateinit var conversationPlanProgress: ProgressBar
    private lateinit var conversationPlanExpand: ImageView
    private lateinit var conversationPlanSteps: LinearLayout
    private lateinit var conversationApproval: MaxHeightScrollView
    private lateinit var approvalTitle: TextView
    private lateinit var approvalDetail: TextView
    private lateinit var approvalCommand: TextView
    private lateinit var approvalActions: LinearLayout
    private lateinit var responsesRefresh: SwipeRefreshLayout
    private lateinit var projectsRefresh: SwipeRefreshLayout
    private lateinit var appUpdater: AppUpdater
    private val messageAdapter = MessageAdapter { openResponse(it) }
    private val projectAdapter = ProjectAdapter { openProject(it) }
    private val terminalAdapter = TerminalAdapter(
        { openConversation(it, true) },
        ::requestCloseTerminal,
        ::showPendingNotice,
    )
    private val conversationsAdapter = TerminalAdapter(
        onOpen = { openConversation(it, false) },
        onPending = ::showPendingNotice,
    )
    private val conversationAdapter = ConversationAdapter(
        ::retryConversationMessage,
        ::showPendingNotice,
    )
    private val executor = Executors.newSingleThreadExecutor()
    private val commandExecutor = Executors.newSingleThreadExecutor()
    private val syncExecutor = Executors.newFixedThreadPool(2)
    private val storageExecutor = Executors.newSingleThreadExecutor()
    private var conversationHistoryKey: Pair<String, String>? = null
    private var conversationHistory: List<CompletionRecord> = emptyList()
    private var conversationHistoryLoading = false
    private var conversationHistoryReloadPending = false
    private val outgoingMessages = mutableMapOf<String, CompletionRecord>()
    private lateinit var draftStore: DraftStore
    private var draftLoading = false
    private var draftGeneration = 0L
    private lateinit var pendingActionStore: PendingMobileActionStore
    private var pendingMobileActions: List<PendingMobileAction> = emptyList()
    private var receiverRegistered = false
    private var syncingNotificationsToggle = false
    private var syncingAppLockToggle = false
    private var appUnlocked = false
    private var appLockPromptVisible = false
    private var updateAvailable: AndroidUpdateManifest? = null
    private var selectedPage = Page.CONVERSATIONS
    private val pageHistory = ArrayDeque<Page>()
    private var selectedProject: ProjectRow? = null
    private var selectedTarget: ConversationTarget? = null
    private var legacyResponse: CompletionRecord? = null
    private var conversationReturnsToProject = false
    private var conversationShouldStickToBottom = true
    private var terminalShouldStickToBottom = true
    private var displayedPlan: RemoteAgentActivity? = null
    private var displayedPlanKey: String? = null
    private var planExpanded = false
    private var renderedPermissionKey: String? = null
    private val questionSelections = mutableMapOf<String, MutableSet<String>>()
    private val questionNotes = mutableMapOf<String, EditText>()
    private val questionControls = mutableListOf<View>()
    private var questionSendButton: Button? = null
    private var questionSubmitting = false
    private var selectedDraftAttachment: MobileImageAttachment? = null
    private val deliveryChecks = mutableSetOf<String>()
    private val draftPersistRunnable = Runnable { writeCurrentDraft() }
    private var refreshRequestedAt = 0L
    private var requestedFocus: Pair<String, String>? = null
    private var refreshBaselines: Map<String, Long> = emptyMap()
    private var refreshPending: Set<String> = emptySet()
    private var refreshHadFailure = false
    private var refreshShowsFeedback = false
    private var refreshGeneration = 0L
    private var networkCallbackRegistered = false
    private var foreground = false
    private var projectQuery = ""
    private var conversationQuery = ""
    private var conversationFilter = ConversationFilter.ALL
    private var renderedSuggestions: List<SlashSuggestion>? = null
    private var renderedCommandEmpty: String? = null
    private val refreshTimeout = Runnable {
        if (refreshRequestedAt > 0) finishRemoteRefresh(timedOut = true)
    }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { runOnUiThread {
            if (foreground && !isDestroyed) {
                recoverPendingRelayMessages()
                requestRemoteRefresh(showSpinner = false)
            }
        } }
        override fun onLost(network: Network) { runOnUiThread {
            if (foreground && !isDestroyed) {
                refreshConnectionHealth()
                refreshWorkspaces()
                refreshConversationAvailability()
            }
        } }
    }
    private var cachedSnapshots: List<WorkspaceSnapshot> = emptyList()
    private var unreadConversationKeys: Set<Pair<String, String>> = emptySet()
    private var remoteStateLoading = false
    private var remoteStateReady = false
    private var refreshOnLoad = false
    private var remoteStateReloadPending = false
    private val relayRecoveryRunning = AtomicBoolean(false)
    private val connectionTicker = object : Runnable {
        override fun run() {
            recoverPendingRelayMessages()
            refreshConnectionHealth()
            refreshWorkspaces()
            refreshUsageLimits()
            refreshConversationAvailability()
            connectionDot.postDelayed(this, if (conversationDetail.visibility == View.VISIBLE) 1_000 else 3_000)
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
            MessageStore(this).use { it.dismissPendingNotifications() }
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
        appRoot = findViewById(R.id.app_root)
        if (isAppLockEnabled()) appRoot.visibility = View.INVISIBLE
        configureSystemBarInsets()
        NotificationTools.createChannel(this)
        appUpdater = AppUpdater(this)
        draftStore = DraftStore(this)
        pendingActionStore = PendingMobileActionStore(this)
        pendingMobileActions = pendingActionStore.all()
        storageExecutor.execute { MessageStore(this).use { it.recoverInterruptedSends() } }
        ReadSyncScheduler.enqueue(this)

        pairingStatus = findViewById(R.id.pairing_status)
        scanButton = findViewById(R.id.scan_button)
        disconnectButton = findViewById(R.id.disconnect_button)
        emptyState = findViewById(R.id.empty_state)
        notificationsToggle = findViewById(R.id.notifications_toggle)
        appLockToggle = findViewById(R.id.app_lock_toggle)
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
        usageLimitsContent = findViewById(R.id.usage_limits_content)
        usageLimitsEmpty = findViewById(R.id.usage_limits_empty)
        pendingNotice = findViewById(R.id.pending_notice)
        pendingNotice.accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        projectDetail = findViewById(R.id.project_detail)
        conversationDetail = findViewById(R.id.conversation_detail)
        conversationCommandsScroll = findViewById(R.id.conversation_commands_scroll)
        conversationCommands = findViewById(R.id.conversation_commands)
        (conversationCommandsScroll as MaxHeightScrollView).maxHeightPx = dp(220)
        conversationComposer = findViewById(R.id.conversation_composer)
        conversationUnavailable = findViewById(R.id.conversation_unavailable)
        conversationInput = findViewById(R.id.conversation_input)
        conversationSend = findViewById(R.id.conversation_send)
        conversationAttach = findViewById(R.id.conversation_attach)
        conversationAttachmentPreview = findViewById(R.id.conversation_attachment_preview)
        conversationAttachmentImage = findViewById(R.id.conversation_attachment_image)
        conversationAttachmentName = findViewById(R.id.conversation_attachment_name)
        conversationExperience = findViewById(R.id.conversation_experience)
        conversationExperience.onUnavailable = {
            experienceUnavailable = true
            conversationExperience.visibility = View.GONE
            refreshConversation(reloadHistory = false)
        }
        findViewById<View>(R.id.conversation_model).setOnClickListener { showAgentChoice("model") }
        findViewById<View>(R.id.conversation_effort).setOnClickListener { showAgentChoice("effort") }
        findViewById<View>(R.id.conversation_stop).setOnClickListener { sendAgentControl("interrupt") }
        findViewById<View>(R.id.conversation_more).setOnClickListener { showConversationActions() }
        conversationList = findViewById(R.id.conversation_list)
        conversationLatest = findViewById(R.id.conversation_latest)
        conversationTerminal = findViewById(R.id.conversation_terminal)
        conversationPlan = findViewById(R.id.conversation_plan)
        conversationPlanHead = findViewById(R.id.conversation_plan_head)
        conversationPlanLabel = findViewById(R.id.conversation_plan_label)
        conversationPlanCurrent = findViewById(R.id.conversation_plan_current)
        conversationPlanCount = findViewById(R.id.conversation_plan_count)
        conversationPlanProgress = findViewById(R.id.conversation_plan_progress)
        conversationPlanExpand = findViewById(R.id.conversation_plan_expand)
        conversationPlanSteps = findViewById(R.id.conversation_plan_steps)
        conversationApproval = findViewById(R.id.conversation_approval)
        conversationApproval.maxHeightPx = (resources.displayMetrics.heightPixels * 0.56f).toInt()
        approvalTitle = findViewById(R.id.approval_title)
        approvalDetail = findViewById(R.id.approval_detail)
        approvalCommand = findViewById(R.id.approval_command)
        approvalActions = findViewById(R.id.approval_actions)
        responsesRefresh = findViewById(R.id.responses_page)
        projectsRefresh = findViewById(R.id.projects_page)
        conversationsRefresh = findViewById(R.id.conversations_page)
        conversationsRefresh.setOnChildScrollUpCallback { _, _ -> findViewById<RecyclerView>(R.id.conversations_list).canScrollVertically(-1) }
        conversationsRefresh.setOnRefreshListener { requestRemoteRefresh() }

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
                    conversationLatest.visibility =
                        if (conversationShouldStickToBottom) View.GONE else View.VISIBLE
                }
            })
        }
        conversationTerminal.apply {
            movementMethod = ScrollingMovementMethod.getInstance()
            setHorizontallyScrolling(true)
            setOnScrollChangeListener { _, _, scrollY, _, _ ->
                val contentHeight = layout?.height ?: 0
                val viewportHeight = height - compoundPaddingTop - compoundPaddingBottom
                val bottom = maxOf(0, contentHeight - viewportHeight)
                terminalShouldStickToBottom =
                    scrollY >= bottom - (24 * resources.displayMetrics.density).toInt()
            }
        }
        responsesRefresh.setOnChildScrollUpCallback { _, _ ->
            findViewById<RecyclerView>(R.id.message_list).canScrollVertically(-1)
        }
        projectsRefresh.setOnChildScrollUpCallback { _, _ ->
            findViewById<RecyclerView>(R.id.project_list).canScrollVertically(-1)
        }
        responsesRefresh.setOnRefreshListener { requestRemoteRefresh() }
        projectsRefresh.setOnRefreshListener { requestRemoteRefresh() }
        findViewById<View>(R.id.project_back).setOnClickListener { navigateBack() }
        findViewById<View>(R.id.project_new_terminal).setOnClickListener { showCreateTerminalDialog() }
        findViewById<View>(R.id.conversation_back).setOnClickListener { navigateBack() }
        conversationPlanHead.setOnClickListener { view ->
            displayedPlan ?: return@setOnClickListener
            view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
            planExpanded = !planExpanded
            renderPlanDetails()
        }
        conversationSend.setOnClickListener { sendConversationMessage() }
        findViewById<View>(R.id.conversation_latest).setOnClickListener {
            conversationShouldStickToBottom = true
            if (conversationAdapter.itemCount > 0) conversationList.scrollToPosition(conversationAdapter.itemCount - 1)
            it.visibility = View.GONE
        }
        findViewById<View>(R.id.conversation_command_button).setOnClickListener {
            if (draftLoading) return@setOnClickListener
            if (conversationInput.text.isNotBlank() && !conversationInput.text.startsWith("/")) {
                showCommandBrowser()
            } else {
                conversationInput.setText("/")
                conversationInput.setSelection(1)
                conversationInput.requestFocus()
                getSystemService(InputMethodManager::class.java).showSoftInput(conversationInput, InputMethodManager.SHOW_IMPLICIT)
            }
        }
        configureWorkspaceTools()
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
                updateSlashCommandSuggestions()
            }
        })
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!navigateBack()) {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })

        combineSettingsSections()
        findViewById<View>(R.id.notification_settings_button).setOnClickListener {
            NotificationHealth.openNotificationSettings(this)
        }
        findViewById<View>(R.id.battery_settings_button).setOnClickListener {
            NotificationHealth.openBatterySettings(this)
        }
        configureNavigation()
        configureNotificationToggle()
        configureAppLockToggle()
        savedInstanceState?.getString(STATE_PAGE)
            ?.let { runCatching { Page.valueOf(it) }.getOrNull() }
            ?.let(::showPage)
        savedInstanceState?.getStringArrayList(STATE_PAGE_HISTORY)
            ?.mapNotNull { runCatching { Page.valueOf(it) }.getOrNull() }
            ?.forEach(pageHistory::addLast)
        configureUpdater()
        resumePendingUpdate()
        scanButton.setOnClickListener { scanPairingCode() }
        disconnectButton.setOnClickListener { confirmDisconnect() }
        updateButton.setOnClickListener {
            updateAvailable?.let(::downloadUpdate) ?: checkForUpdates()
        }
        retryConnectionButton.setOnClickListener { requestRemoteRefresh() }
        requestNotificationPermissionIfEnabled()
        refreshPairingStatus()
        refreshPushRegistration()
        refreshRemoteState()
    }

    override fun onStart() {
        super.onStart()
        foreground = true
        if (!networkCallbackRegistered) {
            runCatching {
                getSystemService(ConnectivityManager::class.java).registerNetworkCallback(
                    NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), networkCallback)
                networkCallbackRegistered = true
            }
        }
        syncNotificationVisibility()
        connectionDot.removeCallbacks(connectionTicker)
        connectionDot.post(connectionTicker)
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
        if (::conversationExperience.isInitialized && !experienceUnavailable) conversationExperience.pauseConversation()
        foreground = false
        if (networkCallbackRegistered) {
            runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
            networkCallbackRegistered = false
        }
        refreshShowsFeedback = false
        finishRemoteRefresh()
        persistCurrentDraft()
        connectionDot.removeCallbacks(connectionTicker)
        MobileNotificationVisibility.activityStopped()
        if (isAppLockEnabled() && !appLockPromptVisible && !isChangingConfigurations) {
            appUnlocked = false
            appRoot.visibility = View.INVISIBLE
        }
        if (receiverRegistered) {
            unregisterReceiver(messagesChanged)
            unregisterReceiver(downloadFinished)
            receiverRegistered = false
        }
        super.onStop()
    }

    override fun onResume() {
        super.onResume()
        refreshNotificationHealth()
        requestAppUnlockIfNeeded()
        syncNotificationToggle()
        refreshRemoteState()
        recoverPendingRelayMessages()
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
        outState.putStringArrayList(
            STATE_PAGE_HISTORY,
            ArrayList(pageHistory.map(Page::name)),
        )
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        if (::conversationExperience.isInitialized && !experienceUnavailable) conversationExperience.destroy()
        if (::conversationList.isInitialized) conversationList.clearOnScrollListeners()
        if (::connectionDot.isInitialized) connectionDot.removeCallbacks(connectionTicker)
        executor.shutdownNow()
        // Let already accepted submissions finish when the Activity is recreated.
        commandExecutor.shutdown()
        syncExecutor.shutdownNow()
        storageExecutor.shutdownNow()
        super.onDestroy()
    }

    private fun configureNavigation() {
        fun bind(id: Int, page: Page) {
            findViewById<View>(id).setOnClickListener { view ->
                if (selectedPage != page) {
                    view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                    navigateToPage(page)
                }
            }
        }
        bind(R.id.nav_responses, Page.ACTIVITY)
        bind(R.id.nav_projects, Page.PROJECTS)
        bind(R.id.nav_conversations, Page.CONVERSATIONS)
        bind(R.id.settings_button, Page.SETTINGS)
        showPage(Page.CONVERSATIONS)
    }

    private fun navigateToPage(page: Page) {
        if (selectedPage == page) return
        pageHistory.addLast(selectedPage)
        showPage(page)
    }

    private fun navigateBack(): Boolean {
        when {
            conversationDetail.visibility == View.VISIBLE -> closeConversation()
            projectDetail.visibility == View.VISIBLE -> closeProject()
            else -> {
                while (pageHistory.isNotEmpty()) {
                    val previousPage = pageHistory.removeLast()
                    if (previousPage != selectedPage) {
                        showPage(previousPage)
                        return true
                    }
                }
                return false
            }
        }
        return true
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
            applyWindowInsets(view, insets)
            insets
        }
        ViewCompat.setWindowInsetsAnimationCallback(
            root,
            object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onProgress(
                    insets: WindowInsetsCompat,
                    runningAnimations: MutableList<WindowInsetsAnimationCompat>,
                ): WindowInsetsCompat {
                    applyWindowInsets(root, insets)
                    return insets
                }
            },
        )
        ViewCompat.requestApplyInsets(root)
    }

    private fun applyWindowInsets(view: View, insets: WindowInsetsCompat) {
        val systemArea = insets.getInsets(
            WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        val keyboardArea = insets.getInsets(WindowInsetsCompat.Type.ime())
        val bottom = maxOf(systemArea.bottom, keyboardArea.bottom)
        if (
            view.paddingLeft != systemArea.left ||
            view.paddingTop != systemArea.top ||
            view.paddingRight != systemArea.right ||
            view.paddingBottom != bottom
        ) {
            view.updatePadding(
                left = systemArea.left,
                top = systemArea.top,
                right = systemArea.right,
                bottom = bottom,
            )
        }
    }

    private fun showPage(page: Page) {
        persistCurrentDraft()
        dismissKeyboard()
        if (page == Page.SETTINGS) refreshNotificationHealth()
        val previousPage = selectedPage
        selectedProject = null
        selectedTarget = null
        selectedDraftAttachment = null
        legacyResponse = null
        MobileNotificationVisibility.hideConversation()
        if (!experienceUnavailable) conversationExperience.pauseConversation()
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

    private fun configureWorkspaceTools() {
        fun bindSearch(id: Int, update: (String) -> Unit) {
            findViewById<EditText>(id).apply {
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                    override fun afterTextChanged(s: Editable?) { update(s.toString()); refreshWorkspaces() }
                })
                setOnEditorActionListener { _, _, _ ->
                    getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
                    clearFocus(); true
                }
            }
        }
        bindSearch(R.id.project_search) { projectQuery = it }
        bindSearch(R.id.conversation_search) { conversationQuery = it }
        val filters = findViewById<LinearLayout>(R.id.conversation_filters)
        for ((filter, label) in listOf(ConversationFilter.ALL to "All", ConversationFilter.NEEDS_YOU to "Needs you", ConversationFilter.UNREAD to "Unread")) {
            filters.addView(Button(this).apply {
                text = label; textSize = 12f; isAllCaps = false
                minWidth = 0; minimumWidth = 0
                background = ContextCompat.getDrawable(this@MainActivity, R.drawable.nav_item)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_dim))
                isSelected = conversationFilter == filter
                setPadding(dp(16), 0, dp(16), 0)
                setOnClickListener {
                    conversationFilter = filter
                    for (i in 0 until filters.childCount) filters.getChildAt(i).isSelected = filters.getChildAt(i) === this
                    performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
                    refreshWorkspaces()
                }
            }, LinearLayout.LayoutParams(-2, dp(48)).apply { marginEnd = dp(4) })
        }
        headerConnectionStatus.apply {
            minHeight = dp(48); gravity = Gravity.CENTER_VERTICAL
            isFocusable = true
            contentDescription = "Connection status. Tap to sync with desktop."
            setOnClickListener { requestRemoteRefresh() }
        }
        for (refresh in listOf(responsesRefresh, projectsRefresh)) {
            refresh.setColorSchemeColors(ContextCompat.getColor(this, R.color.duckweed_accent))
            refresh.setProgressBackgroundColorSchemeColor(ContextCompat.getColor(this, R.color.duckweed_surface_high))
        }
    }

    private fun updateEmptyStates(noTabs: Boolean, noConversations: Boolean) {
        val paired = SecretStore.loadAll(this).isNotEmpty()
        fun update(container: View, actionId: Int, title: String, detail: String, action: String, run: () -> Unit) {
            val texts = (container as? ViewGroup)?.let { group ->
                (0 until group.childCount).map { group.getChildAt(it) }.filterIsInstance<TextView>().filterNot { it is Button }
            }.orEmpty()
            texts.getOrNull(0)?.text = title
            texts.getOrNull(1)?.text = detail
            findViewById<Button>(actionId).apply { text = action; setOnClickListener { run() } }
        }
        val projectsFiltered = !noTabs && projectQuery.isNotBlank()
        update(projectsEmpty, R.id.projects_empty_action,
            if (projectsFiltered) "No matching tabs" else "Your desktop tabs belong here",
            if (projectsFiltered) "Try a tab name, folder, or agent." else "Connect your desktop to continue working from your phone.",
            if (projectsFiltered) "Clear search" else if (paired) "Sync tabs" else "Connect desktop") {
            if (projectsFiltered) findViewById<EditText>(R.id.project_search).text.clear()
            else if (paired) requestRemoteRefresh() else navigateToPage(Page.SETTINGS)
        }
        val conversationsFiltered = !noConversations && (conversationQuery.isNotBlank() || conversationFilter != ConversationFilter.ALL)
        update(conversationsEmpty, R.id.conversations_empty_action,
            if (conversationsFiltered) "Nothing matches this view" else "Continue a conversation",
            if (conversationsFiltered) "Try another search or show all conversations." else "Open an agent or terminal on desktop, then sync it here.",
            if (conversationsFiltered) "Show all conversations" else if (paired) "Sync conversations" else "Connect desktop") {
            if (conversationsFiltered) {
                conversationFilter = ConversationFilter.ALL
                findViewById<EditText>(R.id.conversation_search).text.clear()
                val filters = findViewById<LinearLayout>(R.id.conversation_filters)
                for (i in 0 until filters.childCount) filters.getChildAt(i).isSelected = i == 0
                refreshWorkspaces()
            } else if (paired) requestRemoteRefresh() else navigateToPage(Page.SETTINGS)
        }
        findViewById<Button>(R.id.activity_empty_action).apply {
            text = if (paired) "Open conversations" else "Connect desktop"
            setOnClickListener { navigateToPage(if (paired) Page.CONVERSATIONS else Page.SETTINGS) }
        }
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
                MessageStore(this).use { store ->
                    store.dismissPendingNotifications()
                    NotificationTools.cancel(this, store.latest())
                }
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

    private fun configureAppLockToggle() {
        syncAppLockToggle()
        appLockToggle.setOnCheckedChangeListener { _, enabled ->
            if (syncingAppLockToggle || enabled == isAppLockEnabled()) return@setOnCheckedChangeListener
            if (!enabled) {
                setAppLockEnabled(false)
                appUnlocked = true
                appRoot.visibility = View.VISIBLE
                return@setOnCheckedChangeListener
            }

            when (BiometricManager.from(this).canAuthenticate(APP_LOCK_AUTHENTICATORS)) {
                BiometricManager.BIOMETRIC_SUCCESS -> showAppLockPrompt(
                    enabling = true,
                    onSuccess = {
                        setAppLockEnabled(true)
                        appUnlocked = true
                        syncAppLockToggle()
                        Toast.makeText(this, "App lock enabled.", Toast.LENGTH_SHORT).show()
                    },
                )
                BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> {
                    syncAppLockToggle()
                    Toast.makeText(
                        this,
                        "Set up biometrics or a device screen lock first.",
                        Toast.LENGTH_LONG,
                    ).show()
                }
                else -> {
                    syncAppLockToggle()
                    Toast.makeText(
                        this,
                        "App lock is not available on this device.",
                        Toast.LENGTH_LONG,
                    ).show()
                }
            }
        }
    }

    private fun requestAppUnlockIfNeeded() {
        if (!::appRoot.isInitialized || !isAppLockEnabled() || appUnlocked || appLockPromptVisible) {
            return
        }
        appRoot.visibility = View.INVISIBLE
        showAppLockPrompt(
            enabling = false,
            onSuccess = {
                appUnlocked = true
                appRoot.visibility = View.VISIBLE
                syncNotificationVisibility()
                openIntentResponse()
            },
        )
    }

    private fun showAppLockPrompt(enabling: Boolean, onSuccess: () -> Unit) {
        appLockPromptVisible = true
        val prompt = BiometricPrompt(
            this,
            ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    super.onAuthenticationSucceeded(result)
                    appLockPromptVisible = false
                    onSuccess()
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    super.onAuthenticationError(errorCode, errString)
                    appLockPromptVisible = false
                    if (enabling) {
                        syncAppLockToggle()
                    } else {
                        Toast.makeText(this@MainActivity, errString, Toast.LENGTH_SHORT).show()
                        finishAndRemoveTask()
                    }
                }
            },
        )
        val promptInfo = BiometricPrompt.PromptInfo.Builder()
            .setTitle(getString(R.string.app_lock_prompt_title))
            .setSubtitle(getString(R.string.app_lock_prompt_subtitle))
            .setAllowedAuthenticators(APP_LOCK_AUTHENTICATORS)
            .build()
        prompt.authenticate(promptInfo)
    }

    private fun isAppLockEnabled(): Boolean =
        getSharedPreferences(APP_LOCK_PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(APP_LOCK_ENABLED, false)

    private fun setAppLockEnabled(enabled: Boolean) {
        getSharedPreferences(APP_LOCK_PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(APP_LOCK_ENABLED, enabled)
            .apply()
    }

    private fun syncAppLockToggle() {
        if (!::appLockToggle.isInitialized) return
        syncingAppLockToggle = true
        appLockToggle.isChecked = isAppLockEnabled()
        syncingAppLockToggle = false
    }

    private fun requestNotificationPermissionIfEnabled() {
        if (!NotificationPreference.isEnabled(this)) {
            MessageStore(this).use { it.dismissPendingNotifications() }
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
        refreshNotificationHealth()
        if (!::notificationsToggle.isInitialized) return
        val active = notificationsAreActive()
        if (notificationsToggle.isChecked == active) return
        syncingNotificationsToggle = true
        notificationsToggle.isChecked = active
        syncingNotificationsToggle = false
    }

    private fun syncNotificationVisibility() {
        if (isAppLockEnabled() && !appUnlocked) {
            MobileNotificationVisibility.activityStopped()
            return
        }
        MobileNotificationVisibility.activityStarted()
        if (conversationDetail.visibility == View.VISIBLE) {
            MobileNotificationVisibility.showConversation(
                selectedTarget?.pairId ?: legacyResponse?.pairId,
                selectedTarget?.terminal?.id ?: legacyResponse?.terminalId,
            )
        } else {
            MobileNotificationVisibility.hideConversation()
        }
    }

    private fun refreshNotificationHealth() {
        findViewById<TextView>(R.id.notification_health)?.text = NotificationHealth.describe(this)
    }

    private fun showPendingNotifications() {
        if (isFinishing || isDestroyed) return
        executor.execute {
            MessageStore(this).use { store ->
                store.pendingNotifications().asReversed().forEach { message ->
                    NotificationTools.deliverPending(this, store, message)
                }
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
                                MessageStore(this).use { it.discardReadSyncs(pairing.pairId) }
                                PendingMobileActionStore(this).removePair(pairing.pairId)
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
        val latest = snapshots.maxOfOrNull { it.lastSeenAt }
        val freshPairings = snapshots
            .filter { MobileSyncPolicy.isDesktopOnline(it.lastSeenAt, now, CONNECTION_FRESH_MS) }
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
            !hasNetwork() -> {
                headerConnectionStatus.text = "No network"
                connectionHealth.text = "Phone is offline"
                connectionLastSync.text = "Reconnect to Wi-Fi or mobile data. Your drafts are saved."
                color = R.color.duckweed_attention
            }
            refreshRequestedAt > 0 -> {
                headerConnectionStatus.text = "Syncing"
                connectionHealth.text = "Syncing with desktop..."
                connectionLastSync.text = "Your saved conversations remain available."
                color = R.color.duckweed_text_dim
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
            if (isFinishing || isDestroyed) return@addOnSuccessListener
            executor.execute {
                credentials.forEach { pairing ->
                    runCatching { RelayClient.refreshFcmToken(pairing, token) }
                }
            }
        }
    }

    private fun refreshRemoteState() {
        if (isFinishing || isDestroyed) return
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
                MessageStore(this).use { store ->
                    Triple(
                        snapshots,
                        store.latestForOpenAgents(openAgentTerminals, 50),
                        store.unreadConversationKeys(),
                    )
                }
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

    /**
     * FCM only wakes the app. The encrypted relay remains the source of truth,
     * so foreground recovery lists and downloads any payload whose wake-up was
     * delayed or dropped by Android battery management.
     */
    private fun recoverPendingRelayMessages() {
        if (isFinishing || isDestroyed) return
        if (!relayRecoveryRunning.compareAndSet(false, true)) return
        val credentials = SecretStore.loadAll(this)
        if (credentials.isEmpty()) {
            relayRecoveryRunning.set(false)
            return
        }
        // Pairings run independently so one unreachable desktop cannot stall another.
        val remaining = java.util.concurrent.atomic.AtomicInteger(credentials.size)
        credentials.forEach { pairing -> syncExecutor.execute {
            try {
                runCatching { RelayClient.pendingMessages(pairing) }
                    .getOrDefault(emptyList())
                    .forEach { pending ->
                        runCatching {
                            MessageFetchWorker.fetchAndStore(applicationContext, pairing, pending.id, pending.payload, pending.sentAt)
                        }.onFailure { error ->
                            if (error !is RelayHttpException || error.status != 404) {
                                MessageFetchScheduler.enqueue(applicationContext, pairing.pairId, pending.id)
                            }
                        }
                    }
            } finally {
                if (remaining.decrementAndGet() == 0) relayRecoveryRunning.set(false)
            }
        } }
    }

    private fun applyRemoteState(
        snapshots: List<WorkspaceSnapshot>,
        messages: List<CompletionRecord>,
        unreadKeys: Set<Pair<String, String>>,
    ) {
        remoteStateReady = true
        reconcilePendingActions(snapshots)
        cachedSnapshots = snapshots
        unreadConversationKeys = unreadKeys
        if (refreshRequestedAt > 0) {
            refreshPending = refreshPending - MobileSyncPolicy.refreshedPairIds(refreshBaselines, snapshots)
            if (refreshPending.isEmpty()) finishRemoteRefresh()
        }
        legacyResponse?.let { current ->
            legacyResponse = messages.firstOrNull { it.id == current.id } ?: current
        }
        messageAdapter.submit(messages)
        emptyState.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE
        refreshWorkspaces(snapshots, unreadKeys)
        refreshConnectionHealth(snapshots)
        refreshUsageLimits(snapshots)
        if (selectedPage == Page.SETTINGS) refreshNotificationHealth()
        if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
        openIntentResponse()
        if (refreshOnLoad) {
            refreshOnLoad = false
            requestRemoteRefresh(showSpinner = refreshShowsFeedback)
        }
    }

    private fun reconcilePendingActions(
        snapshots: List<WorkspaceSnapshot>,
        now: Long = System.currentTimeMillis(),
    ): Boolean {
        val reconciliation = PendingMobileActionPolicy.reconcile(
            pendingMobileActions,
            snapshots,
            now,
        )
        if (reconciliation.pending == pendingMobileActions) return false
        pendingMobileActions = reconciliation.pending
        pendingActionStore.replace(pendingMobileActions)
        return true
    }

    private fun refreshWorkspaces(
        snapshots: List<WorkspaceSnapshot> = cachedSnapshots,
        unreadKeys: Set<Pair<String, String>> = unreadConversationKeys,
    ) {
        val now = System.currentTimeMillis()
        val onlinePairIds = snapshots
            .filter { hasNetwork() && MobileSyncPolicy.isDesktopOnline(it.lastSeenAt, now, CONNECTION_FRESH_MS) }
            .mapTo(mutableSetOf()) { it.pairId }
        val rows = snapshots.flatMap { snapshot ->
            snapshot.projects.map { project ->
                ProjectRow(
                    snapshot.pairId,
                    projectWithPendingActions(snapshot.pairId, project),
                    snapshot.pairId in onlinePairIds,
                )
            }
        }
        val visibleRows = rows.filter { WorkspaceFilter.project(it, projectQuery) }
        projectAdapter.submit(visibleRows)
        projectsEmpty.visibility = if (visibleRows.isEmpty()) View.VISIBLE else View.GONE
        val targets = rows.flatMap { row ->
            row.project.terminals.map { terminal ->
                ConversationTarget(
                    row.pairId,
                    row.project.id,
                    row.project.name,
                    row.project.color,
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
        val visibleTargets = targets.filter { WorkspaceFilter.conversation(it, conversationQuery, conversationFilter) }
        conversationsAdapter.submitTargets(visibleTargets)
        conversationsEmpty.visibility = if (visibleTargets.isEmpty()) View.VISIBLE else View.GONE
        updateEmptyStates(rows.isEmpty(), targets.isEmpty())

        selectedProject?.let { current ->
            selectedProject = rows.firstOrNull {
                it.pairId == current.pairId && it.project.id == current.project.id
            } ?: current.copy(project = current.project.copy(terminals = emptyList()))
            selectedProject?.let { row ->
                findViewById<TextView>(R.id.project_detail_title).text = row.project.name
                findViewById<TextView>(R.id.project_detail_meta).text =
                    "${row.project.terminals.size} open terminals" + (row.project.branch?.let { " \u00b7 $it" } ?: "")
            }
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
                        row.project.color,
                        terminal,
                        Pair(row.pairId, terminal.id) in unreadKeys,
                        row.desktopOnline,
                    )
                } ?: run { selectedTarget = current.copy(terminal = current.terminal.copy(status = "exited", permission = null)) }
            } ?: run { selectedTarget = current.copy(terminal = current.terminal.copy(status = "exited", permission = null)) }
        }
    }

    private fun openProject(row: ProjectRow) {
        persistCurrentDraft()
        MobileNotificationVisibility.hideConversation()
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
        dismissKeyboard()
        selectedProject = null
        animateDetailOut(projectDetail)
        setDetailChrome(false)
    }

    private fun openResponse(message: CompletionRecord) {
        persistCurrentDraft()
        val target = findConversationTarget(message)
        if (target != null) {
            openConversation(target, false, message.completionSeq ?: target.terminal.completionSeq)
            return
        }
        val pairId = message.pairId
        val terminalId = message.terminalId
        if (pairId != null && terminalId != null) {
            val cleared = MessageStore(this).use {
                it.markConversationRead(pairId, terminalId, message.completionSeq)
            }
            NotificationTools.cancelIds(this, cleared)
            ReadSyncScheduler.enqueue(this)
            messageAdapter.markConversationRead(pairId, terminalId)
        } else {
            MessageStore(this).use { it.markRead(message.id) }
            messageAdapter.markRead(message.id)
        }
        selectedTarget = null
        legacyResponse = message
        MobileNotificationVisibility.showConversation(message.pairId, message.terminalId)
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
                        project.color,
                        terminal,
                        Pair(pairId, terminal.id) in unreadConversationKeys,
                        isDesktopOnline(pairId),
                    )
                }
            }
            ?.firstOrNull()
    }

    private fun openConversation(
        target: ConversationTarget,
        returnToProject: Boolean,
        readCompletionSeq: Long? = target.terminal.completionSeq,
    ) {
        persistCurrentDraft()
        val readAt = System.currentTimeMillis()
        storageExecutor.execute {
            val cleared = MessageStore(this).use {
                it.markConversationRead(target.pairId, target.terminal.id, readCompletionSeq, at = readAt)
            }
            NotificationTools.cancelIds(this, cleared)
            ReadSyncScheduler.enqueue(this)
        }
        messageAdapter.markConversationRead(target.pairId, target.terminal.id)
        unreadConversationKeys = unreadConversationKeys - Pair(target.pairId, target.terminal.id)
        terminalAdapter.markRead(target.pairId, target.terminal.id)
        conversationsAdapter.markRead(target.pairId, target.terminal.id)
        dismissKeyboard()
        if (!experienceUnavailable) conversationExperience.onResume()
        selectedTarget = target.copy(unread = false)
        legacyResponse = null
        MobileNotificationVisibility.showConversation(target.pairId, target.terminal.id)
        conversationReturnsToProject = returnToProject
        conversationShouldStickToBottom = true
        findViewById<View>(R.id.conversation_latest).visibility = View.GONE
        renderedSuggestions = null
        terminalShouldStickToBottom = true
        conversationTerminal.scrollTo(0, 0)
        val generation = ++draftGeneration
        draftLoading = true
        selectedDraftAttachment = null
        conversationInput.text.clear()
        conversationInput.isEnabled = false
        conversationAttach.isEnabled = false
        DraftStore.io.execute {
            val draft = draftStore.load(target.pairId, target.terminal.id)
            runOnUiThread {
                if (isFinishing || isDestroyed || generation != draftGeneration ||
                    selectedTarget?.let { it.pairId == target.pairId && it.terminal.id == target.terminal.id } != true
                ) return@runOnUiThread
                draftLoading = false
                selectedDraftAttachment = draft.attachment.takeIf { target.terminal.mode == "conversation" }
                conversationInput.setText(draft.text)
                conversationInput.setSelection(conversationInput.text.length)
                conversationInput.isEnabled = true
                conversationAttach.isEnabled = true
                renderDraftAttachment()
                refreshConversationAvailability()
            }
        }
        renderDraftAttachment()
        projectDetail.visibility = View.GONE
        setDetailChrome(true)
        refreshConversation()
        animateDetailIn(conversationDetail)
        requestRemoteRefresh(showSpinner = false)
        recoverPendingRelayMessages()
    }

    private fun dismissKeyboard() {
        conversationInput.clearFocus()
        currentFocus?.clearFocus()
        ViewCompat.getWindowInsetsController(appRoot)?.hide(WindowInsetsCompat.Type.ime())
        getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(appRoot.windowToken, 0)
    }

    private fun closeConversation() {
        dismissKeyboard()
        persistCurrentDraft()
        draftGeneration++
        draftLoading = false
        historyRequestedFor = null
        if (!experienceUnavailable) conversationExperience.pauseConversation()
        MobileNotificationVisibility.hideConversation()
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

    private fun loadConversationHistory(target: ConversationTarget) {
        if (isFinishing || isDestroyed) return
        if (conversationHistoryLoading) {
            conversationHistoryReloadPending = true
            return
        }
        conversationHistoryLoading = true
        val key = Pair(target.pairId, target.terminal.id)
        storageExecutor.execute {
            val result = runCatching { MessageStore(this).use { it.conversation(key.first, key.second) } }
            runOnUiThread {
                conversationHistoryLoading = false
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (selectedTarget?.let { Pair(it.pairId, it.terminal.id) } == key) {
                    result.onSuccess { messages ->
                        conversationHistoryKey = key
                        conversationHistory = messages
                        messages.forEach { message ->
                            val optimistic = outgoingMessages[message.id]?.deliveryState
                            if (optimistic != null && message.deliveryState != null &&
                                MobileSyncPolicy.nextDeliveryState(optimistic, message.deliveryState) == message.deliveryState) {
                                outgoingMessages.remove(message.id)
                            }
                        }
                        refreshConversation(reloadHistory = false)
                    }
                }
                if (conversationHistoryReloadPending) {
                    conversationHistoryReloadPending = false
                    if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
                }
            }
        }
    }

    private fun refreshConversation(reloadHistory: Boolean = true) {
        if (isFinishing || isDestroyed) return
        val legacy = legacyResponse
        if (legacy != null) {
            findViewById<TextView>(R.id.conversation_title).text = legacy.agent
            findViewById<TextView>(R.id.conversation_status).text = legacy.project
            conversationAdapter.submit(listOf(ConversationTimelineItem.Message(legacy)))
            conversationExperience.visibility = View.GONE
            findViewById<View>(R.id.conversation_controls).visibility = View.GONE
            conversationList.visibility = View.VISIBLE
            conversationTerminal.visibility = View.GONE
            conversationCommandsScroll.visibility = View.GONE
            conversationPlan.visibility = View.GONE
            conversationApproval.visibility = View.GONE
            conversationComposer.visibility = View.GONE
            conversationUnavailable.text =
                "Replying requires the current desktop version and an open terminal."
            conversationUnavailable.visibility = View.VISIBLE
            return
        }
        val target = selectedTarget ?: return
        if (reloadHistory) loadConversationHistory(target)
        val terminalMode = target.terminal.mode == "terminal"
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
                streaming = message.streaming,
            )
        }
        val cached = if (conversationHistoryKey == Pair(target.pairId, target.terminal.id)) {
            conversationHistory
        } else emptyList()
        val stored = (cached + outgoingMessages.values.filter {
            it.pairId == target.pairId && it.terminalId == target.terminal.id
        }).associateBy { it.id }.values.sortedBy { it.sentAt }
        val messages = if (terminalMode) {
            emptyList()
        } else {
            ConversationMergePolicy.merge(synced, stored)
        }
        if (!terminalMode) {
            val storedById = stored.associateBy { it.id }
            messages.asSequence()
                .filter { it.kind == "user" && it.deliveryState == "delivered" }
                .mapNotNull { storedById[it.id] }
                .filter { it.deliveryState == "sent" || it.deliveryState == "received" }
                .toList().takeIf { it.isNotEmpty() }?.let { delivered ->
                    storageExecutor.execute {
                        MessageStore(this).use { store ->
                            delivered.forEach { store.updateOutgoingState(it.id, "delivered") }
                        }
                    }
                }
        }
        val isAgent = target.terminal.agent != null
        val thinking = isAgent && target.terminal.status == "working"
        val desktopOnline = isDesktopOnline(target.pairId)
        findViewById<TextView>(R.id.conversation_title).text = target.projectName
        findViewById<TextView>(R.id.conversation_status).text = buildList {
            add(target.terminal.agent ?: target.terminal.title)
            target.terminal.model?.let { add(it) }
            if (terminalMode && target.terminal.terminalColumns != null && target.terminal.terminalRows != null) {
                add("${target.terminal.terminalColumns}×${target.terminal.terminalRows}")
            }
            add(
                when {
                    !desktopOnline -> "Desktop offline"
                    pendingDecision(target) != null -> "Updating desktop"
                    target.terminal.status == "starting" -> "Opening agent"
                    thinking -> "Thinking"
                    target.terminal.status == "working" -> "Running"
                    target.terminal.status == "waiting" -> "Needs attention"
                    target.terminal.status == "exited" -> "Closed"
                    else -> "Ready"
                },
            )
        }.joinToString("  •  ")
        val shouldScrollToBottom = conversationShouldStickToBottom
        val timeline = ConversationTimelinePolicy.build(
            messages = messages,
            activity = target.terminal.activity,
            agentWorking = thinking && desktopOnline,
            thinkingId = target.terminal.id,
        )
        conversationAdapter.submit(timeline) {
            if (selectedTarget?.let { it.pairId == target.pairId && it.terminal.id == target.terminal.id } == true &&
                shouldScrollToBottom && conversationShouldStickToBottom && timeline.isNotEmpty()
            ) {
                conversationList.scrollToPosition(timeline.lastIndex)
            }
        }
        val richExperience = !terminalMode && target.terminal.experience != null && !experienceUnavailable
        conversationList.visibility = if (terminalMode || richExperience) View.GONE else View.VISIBLE
        conversationExperience.visibility = if (richExperience) View.VISIBLE else View.GONE
        if (richExperience) {
            val experience = JSONObject(target.terminal.experience!!)
            val key = "${target.pairId}:${target.terminal.id}:${experience.optString("sessionId")}:${experience.optString("conversationEpoch") }"
            conversationExperience.onResume()
            conversationExperience.render(key, target.terminal.experience!!, desktopOnline, JSONArray().apply {
                stored.filter { it.kind == "user" && it.deliveryState in listOf("sending", "sent", "received", "failed") }.forEach { message ->
                    put(JSONObject().put("id", message.id).put("at", message.sentAt).put("text", message.response.orEmpty()).put("state", message.deliveryState))
                }
            })
            conversationLatest.visibility = View.GONE
        }
        findViewById<TextView>(R.id.conversation_schedule_notice).apply {
            val schedule = target.terminal.scheduled?.let { JSONObject(it) }
            visibility = if (schedule == null) View.GONE else View.VISIBLE
            text = schedule?.let {
                if (it.has("at")) "Scheduled for ${java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT).format(java.util.Date(it.optLong("at")))}"
                else "Scheduled after ${it.optString("targetLabel") }"
            }.orEmpty()
            setOnClickListener { showConversationActions() }
        }
        if (historyRequestedFor == Triple(target.pairId, target.terminal.id, target.terminal.historyRequestId) &&
            (target.terminal.history != null || target.terminal.historyError != null)) {
            historyRequestedFor = null
            showAgentHistory(target)
        }
        if (terminalMode) findViewById<View>(R.id.conversation_latest).visibility = View.GONE
        conversationTerminal.visibility = if (terminalMode) View.VISIBLE else View.GONE
        if (terminalMode) renderTerminalOutput(target.terminal.terminalOutput)
        renderPlan(target, terminalMode || richExperience)
        renderApproval(target)
        refreshConversationAvailability()
        updateSlashCommandSuggestions()
        messages.filter { it.kind == "user" && it.deliveryState == "sent" }
            .takeLast(5)
            .forEach {
                trackDelivery(
                    it.id,
                    target.pairId,
                    awaitWorkspaceConfirmation = !terminalMode,
                )
            }
    }

    private fun projectWithPendingActions(pairId: String, project: RemoteProject): RemoteProject {
        val actions = pendingMobileActions.filter {
            it.pairId == pairId && it.projectId == project.id
        }
        if (actions.isEmpty()) return project
        val closingByTerminal = actions
            .filter { it.kind == PendingMobileAction.CLOSE_TERMINAL }
            .associateBy { it.terminalId }
        val createActions = actions
            .filter { it.kind == PendingMobileAction.CREATE_TERMINAL }
            .sortedBy { it.createdAt }
        val claimedTerminalIds = mutableSetOf<String>()
        val creatingByTerminal = mutableMapOf<String, PendingMobileAction>()
        createActions.forEach { action ->
            project.terminals.firstOrNull {
                it.id !in action.baselineTerminalIds && it.id !in claimedTerminalIds
            }?.let { terminal ->
                claimedTerminalIds += terminal.id
                creatingByTerminal[terminal.id] = action
            }
        }
        val terminals = project.terminals.map { terminal ->
            terminal.copy(
                pendingAction = closingByTerminal[terminal.id] ?: creatingByTerminal[terminal.id],
            )
        }.toMutableList()
        val matchedCreateActionIds = creatingByTerminal.values.mapTo(mutableSetOf()) { it.id }
        createActions
            .filterNot { it.id in matchedCreateActionIds }
            .forEach { action ->
                terminals += RemoteTerminal(
                    id = "pending:${action.id}",
                    title = action.label ?: "New terminal",
                    shell = "Waiting for desktop",
                    agent = null,
                    model = null,
                    status = "starting",
                    pendingAction = action,
                )
            }
        return project.copy(terminals = terminals)
    }

    private fun refreshUsageLimits(snapshots: List<WorkspaceSnapshot> = cachedSnapshots) {
        if (!::usageLimitsContent.isInitialized || !::usageLimitsEmpty.isInitialized) return
        val quotas = snapshots.firstOrNull { it.usageLimits.isNotEmpty() }?.usageLimits.orEmpty()
        usageLimitsContent.removeAllViews()
        usageLimitsEmpty.visibility = if (quotas.isEmpty()) View.VISIBLE else View.GONE
        if (quotas.isEmpty()) return

        val now = System.currentTimeMillis()
        quotas.forEachIndexed { quotaIndex, quota ->
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(16), dp(16), dp(16), dp(16))
                setBackgroundResource(R.drawable.message_card)
            }
            val header = LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                orientation = LinearLayout.HORIZONTAL
            }
            header.addView(usageSwatch(UsageLimitCopy.agentSwatch(quota.agent), 9, 2), LinearLayout.LayoutParams(dp(9), dp(9)).apply {
                marginEnd = dp(8)
            })
            header.addView(TextView(this).apply {
                text = quota.label
                textSize = 15f
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text))
                typeface = android.graphics.Typeface.DEFAULT_BOLD
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
            quota.plan?.let { plan ->
                header.addView(TextView(this).apply {
                    text = plan.replaceFirstChar { letter ->
                        if (letter.isLowerCase()) letter.titlecase(Locale.US) else letter.toString()
                    }
                    textSize = 10f
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_accent))
                    setBackgroundResource(R.drawable.chip_accent)
                    setPadding(dp(10), dp(5), dp(10), dp(5))
                })
            }
            card.addView(header)

            quota.limits.forEach { limit ->
                val remaining = UsageLimitCopy.remainingPercent(limit.percent)
                val remainingLabel = UsageLimitCopy.remainingLabel(limit.percent)
                val resetHint = UsageLimitCopy.resetHint(limit.resetsAt, now)
                val forecast = UsageLimitCopy.describeForecast(limit, now)
                val meterColor = when (UsageLimitCopy.meterLevel(limit.percent)) {
                    UsageLimitCopy.MeterLevel.Critical -> R.color.duckweed_usage_critical
                    UsageLimitCopy.MeterLevel.Warning -> R.color.duckweed_usage_warning
                    UsageLimitCopy.MeterLevel.Ok -> R.color.duckweed_usage_ok
                }
                val block = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                }
                val labelRow = LinearLayout(this).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    orientation = LinearLayout.HORIZONTAL
                }
                labelRow.addView(TextView(this).apply {
                    text = limit.label
                    textSize = 13f
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_dim))
                }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
                val valueCluster = LinearLayout(this).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    orientation = LinearLayout.HORIZONTAL
                }
                valueCluster.addView(TextView(this).apply {
                    text = remainingLabel
                    textSize = 13f
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text))
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                })
                resetHint?.let { hint ->
                    valueCluster.addView(TextView(this).apply {
                        text = hint
                        textSize = 11f
                        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_faint))
                    }, LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply {
                        marginStart = dp(6)
                    })
                }
                labelRow.addView(valueCluster)
                block.addView(labelRow)
                block.addView(ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
                    max = 100
                    progress = remaining
                    progressDrawable = usageMeterDrawable(
                        ContextCompat.getColor(this@MainActivity, meterColor),
                    )
                    contentDescription = listOfNotNull(
                        "${limit.label} remaining $remainingLabel",
                        resetHint,
                        forecast.text,
                    ).joinToString(", ")
                }, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    dp(7),
                ).apply {
                    topMargin = dp(8)
                })
                val forecastRow = LinearLayout(this).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    orientation = LinearLayout.HORIZONTAL
                }
                val forecastColor = when (forecast.tone) {
                    UsageLimitCopy.Tone.Critical -> R.color.duckweed_usage_forecast_critical
                    UsageLimitCopy.Tone.Warning -> R.color.duckweed_text_dim
                    UsageLimitCopy.Tone.Ok -> R.color.duckweed_text_dim
                    UsageLimitCopy.Tone.Muted -> R.color.duckweed_text_faint
                }
                val forecastDot = when (forecast.tone) {
                    UsageLimitCopy.Tone.Critical -> R.color.duckweed_usage_forecast_critical
                    UsageLimitCopy.Tone.Warning -> R.color.duckweed_usage_forecast_warning
                    UsageLimitCopy.Tone.Ok -> R.color.duckweed_usage_ok
                    UsageLimitCopy.Tone.Muted -> R.color.duckweed_text_faint
                }
                forecastRow.addView(
                    usageSwatch(ContextCompat.getColor(this, forecastDot), 5, 3),
                    LinearLayout.LayoutParams(dp(5), dp(5)).apply { marginEnd = dp(6) },
                )
                forecastRow.addView(TextView(this).apply {
                    text = forecast.text
                    textSize = 12f
                    setTextColor(ContextCompat.getColor(this@MainActivity, forecastColor))
                })
                forecast.detail?.let { detail ->
                    forecastRow.addView(TextView(this).apply {
                        text = detail
                        textSize = 11f
                        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_faint))
                    }, LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply {
                        marginStart = dp(6)
                    })
                }
                block.addView(forecastRow, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    topMargin = dp(7)
                })
                card.addView(block, LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ).apply {
                    topMargin = dp(16)
                })
            }
            usageLimitsContent.addView(card, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                if (quotaIndex > 0) topMargin = dp(10)
            })
        }
    }

    private fun renderPlan(target: ConversationTarget, terminalMode: Boolean) {
        val plan = target.terminal.activity
            .asSequence()
            .filter { it.kind == "plan" && it.steps.isNotEmpty() }
            .maxByOrNull { it.at }
            .takeUnless { terminalMode }
        displayedPlan = plan
        if (plan == null) {
            displayedPlanKey = null
            planExpanded = false
            conversationPlan.visibility = View.GONE
            conversationPlanSteps.removeAllViews()
            return
        }

        val key = "${target.pairId}:${target.terminal.id}:${plan.id}"
        if (displayedPlanKey != key) {
            displayedPlanKey = key
            planExpanded = false
        }
        val completed = plan.steps.count { it.status == "done" }
        val current = plan.steps.firstOrNull { it.status == "running" }
            ?: plan.steps.firstOrNull { it.status == "pending" }
        conversationPlan.visibility = View.VISIBLE
        conversationPlanLabel.text = if (plan.planType == "workflow") "Workflow" else "Tasks"
        conversationPlanCurrent.text = current?.text ?: "Tasks completed"
        conversationPlanCount.text = "$completed/${plan.steps.size}"
        conversationPlanProgress.progress = if (plan.steps.isEmpty()) {
            0
        } else {
            (completed * 100) / plan.steps.size
        }
        renderPlanDetails()
    }

    private fun renderPlanDetails() {
        val plan = displayedPlan ?: return
        conversationPlanExpand.rotation = if (planExpanded) 90f else 0f
        conversationPlanSteps.visibility = if (planExpanded) View.VISIBLE else View.GONE
        conversationPlanHead.contentDescription = buildString {
            append(conversationPlanLabel.text)
            append(" progress. ")
            append(conversationPlanCount.text)
            append(". Current step: ")
            append(conversationPlanCurrent.text)
            append(if (planExpanded) ". Expanded" else ". Collapsed. Double tap to expand")
        }
        conversationPlanSteps.removeAllViews()
        if (!planExpanded) return
        plan.steps.forEachIndexed { index, step ->
            val row = LinearLayout(this).apply {
                gravity = android.view.Gravity.CENTER_VERTICAL
                orientation = LinearLayout.HORIZONTAL
                setPadding(0, dp(4), 0, dp(4))
            }
            val marker = TextView(this).apply {
                gravity = android.view.Gravity.CENTER
                text = when (step.status) {
                    "done" -> "✓"
                    "running" -> "›"
                    else -> "${index + 1}"
                }
                textSize = 11f
                setTextColor(
                    ContextCompat.getColor(
                        this@MainActivity,
                        when (step.status) {
                            "running" -> R.color.duckweed_accent
                            "done" -> R.color.duckweed_text_dim
                            else -> R.color.duckweed_text_faint
                        },
                    ),
                )
            }
            row.addView(marker, LinearLayout.LayoutParams(dp(24), dp(24)))
            row.addView(TextView(this).apply {
                text = step.text
                textSize = 12f
                setLineSpacing(0f, 1.08f)
                setTextColor(
                    ContextCompat.getColor(
                        this@MainActivity,
                        if (step.status == "running") R.color.duckweed_text else R.color.duckweed_text_dim,
                    ),
                )
            }, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(6)
            })
            conversationPlanSteps.addView(
                row,
                LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
    }

    private fun renderTerminalOutput(output: String?) {
        val rendered = output?.takeIf { it.isNotBlank() } ?: "Waiting for terminal output..."
        if (conversationTerminal.text.toString() == rendered) return
        val followOutput = terminalShouldStickToBottom
        val horizontal = conversationTerminal.scrollX
        conversationTerminal.text = rendered
        conversationTerminal.post {
            if (!followOutput) return@post
            val contentHeight = conversationTerminal.layout?.height ?: 0
            val viewportHeight = conversationTerminal.height -
                conversationTerminal.compoundPaddingTop - conversationTerminal.compoundPaddingBottom
            conversationTerminal.scrollTo(horizontal, maxOf(0, contentHeight - viewportHeight))
            terminalShouldStickToBottom = true
        }
    }

    private fun renderApproval(target: ConversationTarget) {
        val permission = target.terminal.permission
        if (permission == null) {
            renderedPermissionKey = null
            questionSelections.clear()
            questionNotes.clear()
            questionControls.clear()
            questionSendButton = null
            questionSubmitting = false
            conversationApproval.alpha = 1f
            conversationApproval.setOnTouchListener(null)
            setAnimatedVisibility(conversationApproval, false)
            approvalActions.removeAllViews()
            return
        }
        val permissionKey = "${target.pairId}:${target.terminal.id}:${permission.id}"
        setAnimatedVisibility(conversationApproval, true)
        if (permission.kind == "question" && renderedPermissionKey == permissionKey) {
            setQuestionControlsEnabled(
                isDesktopOnline(target.pairId) && pendingDecision(target) == null,
            )
            updateQuestionSubmitState(permission, target)
            applyPendingDecisionState(target)
            return
        }
        renderedPermissionKey = permissionKey
        questionSelections.clear()
        questionNotes.clear()
        questionControls.clear()
        questionSendButton = null
        questionSubmitting = false
        approvalTitle.text = if (permission.kind == "question") {
            if (permission.questions.size == 1) "A question for you" else "Questions for you"
        } else {
            permission.title
        }
        approvalDetail.text = permission.detail
        approvalDetail.visibility = if (permission.detail.isNullOrBlank()) View.GONE else View.VISIBLE
        approvalCommand.text = permission.command
        approvalCommand.visibility = if (
            permission.kind == "question" || permission.command.isNullOrBlank()
        ) View.GONE else View.VISIBLE
        approvalActions.removeAllViews()
        if (permission.kind == "question") {
            renderQuestions(target, permission)
            applyPendingDecisionState(target)
            return
        }
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
        applyPendingDecisionState(target)
    }

    private fun pendingDecision(target: ConversationTarget): PendingMobileAction? =
        pendingMobileActions.firstOrNull {
            it.kind == PendingMobileAction.DECISION &&
                it.pairId == target.pairId &&
                it.terminalId == target.terminal.id &&
                it.permissionId == target.terminal.permission?.id
        }

    private fun applyPendingDecisionState(target: ConversationTarget) {
        val pending = pendingDecision(target) != null
        conversationApproval.alpha = if (pending) PENDING_ALPHA else 1f
        conversationApproval.contentDescription = if (pending) {
            "Decision sent. Waiting for the desktop to update."
        } else {
            null
        }
        conversationApproval.setOnTouchListener(
            if (pending) {
                View.OnTouchListener { _, event ->
                    if (event.action == MotionEvent.ACTION_UP) showPendingNotice()
                    true
                }
            } else {
                null
            },
        )
        if (pending) {
            for (index in 0 until approvalActions.childCount) {
                approvalActions.getChildAt(index).isEnabled = false
            }
            setQuestionControlsEnabled(false)
        }
    }

    private fun renderQuestions(target: ConversationTarget, permission: RemotePermission) {
        permission.questions.forEachIndexed { questionIndex, question ->
            val block = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                if (questionIndex > 0) setPadding(0, dp(14), 0, 0)
            }
            if (question.header.isNotBlank()) {
                block.addView(TextView(this).apply {
                    text = question.header.uppercase()
                    textSize = 10f
                    letterSpacing = 0.08f
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_accent))
                })
            }
            block.addView(TextView(this).apply {
                text = question.question
                textSize = 14f
                setLineSpacing(dp(2).toFloat(), 1f)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text))
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = if (question.header.isBlank()) 0 else dp(5) })

            val choices = if (question.multiSelect) LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
            } else RadioGroup(this).apply {
                orientation = RadioGroup.VERTICAL
            }
            question.options.forEach { option ->
                val choice = if (question.multiSelect) CheckBox(this) else RadioButton(this)
                choice.apply {
                    text = if (option.description.isBlank()) {
                        option.label
                    } else {
                        "${option.label}\n${option.description}"
                    }
                    textSize = 12f
                    minHeight = dp(48)
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_dim))
                    buttonTintList = ColorStateList.valueOf(
                        ContextCompat.getColor(this@MainActivity, R.color.duckweed_accent),
                    )
                    setPadding(dp(4), 0, dp(4), 0)
                    setOnCheckedChangeListener { _, checked ->
                        val selected = questionSelections.getOrPut(question.id) { mutableSetOf() }
                        if (checked) {
                            if (!question.multiSelect) selected.clear()
                            selected.add(option.id)
                        } else {
                            selected.remove(option.id)
                        }
                        updateQuestionSubmitState(permission, target)
                    }
                }
                questionControls += choice
                choices.addView(
                    choice,
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ),
                )
                if (!option.preview.isNullOrBlank()) {
                    val preview = TextView(this).apply {
                        text = option.preview
                        textSize = 10f
                        maxLines = 10
                        typeface = android.graphics.Typeface.MONOSPACE
                        setTextIsSelectable(true)
                        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_dim))
                        setBackgroundResource(R.drawable.diff_surface)
                        setPadding(dp(9), dp(8), dp(9), dp(8))
                        visibility = View.GONE
                    }
                    val toggle = TextView(this).apply {
                        text = "Show preview"
                        textSize = 11f
                        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_accent))
                        setPadding(dp(36), dp(5), dp(4), dp(5))
                        isClickable = true
                        isFocusable = true
                        setOnClickListener {
                            val opening = preview.visibility != View.VISIBLE
                            preview.visibility = if (opening) View.VISIBLE else View.GONE
                            text = if (opening) "Hide preview" else "Show preview"
                        }
                    }
                    questionControls += toggle
                    choices.addView(toggle)
                    choices.addView(preview, LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { marginStart = dp(32); marginEnd = dp(4) })
                }
            }
            block.addView(choices, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(7) })

            block.addView(TextView(this).apply {
                text = "Add a note or write your own answer"
                textSize = 11f
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_faint))
            }, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(8) })
            val note = EditText(this).apply {
                hint = "Optional note or your own answer"
                minHeight = dp(48)
                maxLines = 4
                filters = arrayOf(InputFilter.LengthFilter(4_000))
                textSize = 12f
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text))
                setHintTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_faint))
                setBackgroundResource(R.drawable.composer_background)
                setPadding(dp(10), dp(8), dp(10), dp(8))
                addTextChangedListener(object : TextWatcher {
                    override fun beforeTextChanged(value: CharSequence?, start: Int, count: Int, after: Int) = Unit
                    override fun onTextChanged(value: CharSequence?, start: Int, before: Int, count: Int) = Unit
                    override fun afterTextChanged(value: Editable?) {
                        updateQuestionSubmitState(permission, target)
                    }
                })
            }
            questionNotes[question.id] = note
            questionControls += note
            block.addView(note, LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = dp(5) })
            approvalActions.addView(block)
        }

        val actions = LinearLayout(this).apply {
            gravity = android.view.Gravity.END
            orientation = LinearLayout.HORIZONTAL
        }
        val skip = Button(this).apply {
            text = "Skip"
            setAllCaps(false)
            textSize = 12f
            setBackgroundResource(R.drawable.button_secondary)
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_dim))
            setOnClickListener { view ->
                view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                sendQuestionAnswers(target, permission, emptyList())
            }
        }
        questionControls += skip
        actions.addView(skip, LinearLayout.LayoutParams(0, dp(46), 1f).apply {
            marginEnd = dp(8)
        })
        val send = Button(this).apply {
            text = "Send answer"
            setAllCaps(false)
            textSize = 12f
            setBackgroundResource(R.drawable.button_primary)
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_accent_ink))
            setOnClickListener { view ->
                view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
                sendQuestionAnswers(target, permission, collectQuestionAnswers(permission))
            }
        }
        questionSendButton = send
        questionControls += send
        actions.addView(send, LinearLayout.LayoutParams(0, dp(46), 1.35f))
        approvalActions.addView(actions, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(14) })
        setQuestionControlsEnabled(isDesktopOnline(target.pairId))
        updateQuestionSubmitState(permission, target)
    }

    private fun collectQuestionAnswers(permission: RemotePermission): List<RemoteQuestionAnswer> =
        permission.questions.map { question ->
            val picked = questionSelections[question.id].orEmpty()
            RemoteQuestionAnswer(
                questionId = question.id,
                labels = question.options.filter { it.id in picked }.map { it.label },
                custom = questionNotes[question.id]?.text?.toString()?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

    private fun updateQuestionSubmitState(permission: RemotePermission, target: ConversationTarget) {
        val complete = permission.questions.all { question ->
            questionSelections[question.id].orEmpty().isNotEmpty() ||
                !questionNotes[question.id]?.text.isNullOrBlank()
        }
        questionSendButton?.apply {
            isEnabled = complete && isDesktopOnline(target.pairId) &&
                !questionSubmitting && pendingDecision(target) == null
            alpha = if (isEnabled) 1f else 0.45f
        }
    }

    private fun setQuestionControlsEnabled(enabled: Boolean) {
        val effective = enabled && !questionSubmitting
        questionControls.forEach { control ->
            if (control !== questionSendButton) control.isEnabled = effective
        }
    }

    private fun isDesktopOnline(pairId: String, now: Long = System.currentTimeMillis()): Boolean =
        hasNetwork() && MobileSyncPolicy.isDesktopOnline(
            cachedSnapshots.firstOrNull { it.pairId == pairId }?.lastSeenAt,
            now,
            CONNECTION_FRESH_MS,
        )

    private fun refreshConversationAvailability() {
        if (!::conversationComposer.isInitialized) return
        val target = selectedTarget ?: return
        val paired = SecretStore.load(this, target.pairId) != null
        val open = target.terminal.status != "exited"
        val online = isDesktopOnline(target.pairId)
        renderAgentControls(target)
        if (!experienceUnavailable && conversationExperience.visibility == View.VISIBLE) {
            conversationExperience.setOnline(online)
        }
        val waitingForDecision = target.terminal.permission != null
        val decisionPending = pendingDecision(target) != null
        val canCompose = paired && open && !waitingForDecision
        conversationComposer.visibility = if (canCompose) View.VISIBLE else View.GONE
        conversationAttach.visibility =
            if (canCompose && target.terminal.mode == "conversation") View.VISIBLE else View.GONE
        findViewById<View>(R.id.conversation_command_button).visibility = conversationAttach.visibility
        conversationInput.hint = if (draftLoading) {
            "Loading draft..."
        } else if (target.terminal.mode == "terminal") {
            "Send input to terminal"
        } else {
            "Message this agent"
        }
        conversationUnavailable.text = when {
            waitingForDecision -> ""
            !paired -> "Pair this desktop again before sending messages."
            !open -> "This terminal is closed and cannot receive messages."
            !online -> "Offline. Your draft is saved. Tap here to retry sync."
            else -> ""
        }
        conversationUnavailable.setOnClickListener {
            if (!paired) navigateToPage(Page.SETTINGS) else requestRemoteRefresh()
        }
        conversationUnavailable.visibility = if (waitingForDecision || canCompose && online) {
            View.GONE
        } else {
            View.VISIBLE
        }
        for (index in 0 until approvalActions.childCount) {
            approvalActions.getChildAt(index).isEnabled = online && !decisionPending
        }
        setQuestionControlsEnabled(online && !decisionPending)
        target.terminal.permission?.takeIf { it.kind == "question" }?.let {
            updateQuestionSubmitState(it, target)
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

    private fun beginPendingAction(action: PendingMobileAction) {
        pendingMobileActions = pendingMobileActions.filterNot { it.id == action.id } + action
        pendingActionStore.put(action)
        refreshWorkspaces()
        if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
        if (action.kind == PendingMobileAction.CREATE_TERMINAL) {
            projectDetail.postDelayed({
                if (pendingMobileActions.none { it.id == action.id }) {
                    return@postDelayed
                }
                if (reconcilePendingActions(cachedSnapshots)) {
                    refreshWorkspaces()
                    if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
                }
            }, PendingMobileActionPolicy.MIN_CREATE_PENDING_MS + 50L)
        }
    }

    private fun removePendingAction(id: String) {
        pendingMobileActions = pendingMobileActions.filterNot { it.id == id }
        pendingActionStore.remove(id)
        refreshWorkspaces()
        if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
    }

    private fun showPendingNotice() {
        if (!::pendingNotice.isInitialized) return
        pendingNotice.removeCallbacks(hidePendingNotice)
        pendingNotice.text = "Please wait. The desktop is still updating."
        pendingNotice.visibility = View.VISIBLE
        pendingNotice.alpha = 0f
        pendingNotice.translationY = dp(10).toFloat()
        pendingNotice.animate()
            .alpha(1f)
            .translationY(0f)
            .setDuration(160L)
            .start()
        pendingNotice.postDelayed(hidePendingNotice, 2_800L)
    }

    private val hidePendingNotice = Runnable {
        if (!::pendingNotice.isInitialized) return@Runnable
        pendingNotice.animate()
            .alpha(0f)
            .translationY(dp(8).toFloat())
            .setDuration(140L)
            .withEndAction { pendingNotice.visibility = View.GONE }
            .start()
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
        val action = PendingMobileAction(
            id = UUID.randomUUID().toString(),
            kind = PendingMobileAction.DECISION,
            pairId = target.pairId,
            projectId = target.projectId,
            terminalId = target.terminal.id,
            permissionId = permission.id,
            createdAt = System.currentTimeMillis(),
        )
        beginPendingAction(action)
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
                    removePendingAction(action.id)
                    findViewById<TextView>(R.id.conversation_status).text =
                        error.message ?: "Could not send this decision."
                    renderApproval(target)
                }
            }
        }
    }

    private fun sendQuestionAnswers(
        target: ConversationTarget,
        permission: RemotePermission,
        answers: List<RemoteQuestionAnswer>,
    ) {
        if (!isDesktopOnline(target.pairId)) {
            showDesktopOffline()
            return
        }
        if (answers.isNotEmpty() && answers.any { it.labels.isEmpty() && it.custom.isNullOrBlank() }) {
            return
        }
        val credentials = SecretStore.load(this, target.pairId) ?: return
        val action = PendingMobileAction(
            id = UUID.randomUUID().toString(),
            kind = PendingMobileAction.DECISION,
            pairId = target.pairId,
            projectId = target.projectId,
            terminalId = target.terminal.id,
            permissionId = permission.id,
            createdAt = System.currentTimeMillis(),
        )
        questionSubmitting = true
        beginPendingAction(action)
        setQuestionControlsEnabled(false)
        questionSendButton?.isEnabled = false
        findViewById<TextView>(R.id.conversation_status).text = "Sending answer securely..."
        executor.execute {
            runCatching {
                RelayClient.sendQuestionAnswers(
                    credentials = credentials,
                    projectId = target.projectId,
                    terminalId = target.terminal.id,
                    permissionId = permission.id,
                    answers = answers,
                )
            }.onSuccess {
                runOnUiThread {
                    findViewById<TextView>(R.id.conversation_status).text =
                        if (answers.isEmpty()) {
                            "Question skipped. Waiting for desktop..."
                        } else {
                            "Answer sent. Waiting for desktop..."
                        }
                    requestRemoteRefresh(showSpinner = false)
                }
            }.onFailure { error ->
                runOnUiThread {
                    removePendingAction(action.id)
                    questionSubmitting = false
                    findViewById<TextView>(R.id.conversation_status).text =
                        error.message ?: "Could not send this answer."
                    setQuestionControlsEnabled(true)
                    updateQuestionSubmitState(permission, target)
                }
            }
        }
    }

    private fun renderAgentControls(target: ConversationTarget) {
        val visible = target.terminal.mode == "conversation"
        findViewById<View>(R.id.conversation_controls).visibility = if (visible) View.VISIBLE else View.GONE
        if (!visible) return
        val experience = target.terminal.experience?.let { JSONObject(it) }
        val online = isDesktopOnline(target.pairId) && target.terminal.status != "exited"
        fun choice(kind: String, fallback: String) {
            val options = target.terminal.commands.firstOrNull { it.name == "/$kind" }?.options.orEmpty()
            findViewById<Button>(if (kind == "model") R.id.conversation_model else R.id.conversation_effort).apply {
                text = options.firstOrNull { it.current }?.label ?: if (kind == "model") target.terminal.model ?: fallback
                    else experience?.optString("nextEffort")?.takeIf { it.isNotBlank() && it != "null" }
                        ?: experience?.optString("effort")?.takeIf { it.isNotBlank() && it != "null" } ?: fallback
                contentDescription = "Choose $kind. Current selection: $text"
                isEnabled = online && options.isNotEmpty()
                alpha = if (isEnabled) 1f else 0.5f
            }
        }
        choice("model", "Model")
        choice("effort", "Effort")
        findViewById<View>(R.id.conversation_stop).apply {
            visibility = if (target.terminal.isWorking) View.VISIBLE else View.GONE
            isEnabled = online
        }
        findViewById<View>(R.id.conversation_more).isEnabled = online
    }

    private fun showAgentChoice(kind: String) {
        val target = selectedTarget ?: return
        val options = target.terminal.commands.firstOrNull { it.name == "/$kind" }?.options.orEmpty()
        if (options.isEmpty()) { requestRemoteRefresh(); return }
        dismissKeyboard()
        AlertDialog.Builder(this).setTitle(if (kind == "model") "Choose model" else "Thinking effort")
            .setSingleChoiceItems(options.map { it.label }.toTypedArray(), options.indexOfFirst { it.current }) { dialog, index ->
                sendAgentControl(kind, value = options[index].value)
                dialog.dismiss()
            }.setNegativeButton("Cancel", null).show()
    }

    private fun showConversationActions() {
        val target = selectedTarget ?: return
        dismissKeyboard()
        val actions = buildList {
            if (outgoingMessages.values.any { it.pairId == target.pairId && it.terminalId == target.terminal.id && it.deliveryState == "failed" } ||
                conversationHistory.any { it.pairId == target.pairId && it.terminalId == target.terminal.id && it.deliveryState == "failed" }) add("Retry failed message" to "retry_message")
            add("Schedule message" to "schedule")
            val provider = target.terminal.experience?.let { JSONObject(it).optString("agent") }
            if (provider != "cursor") add("Conversation history" to "history")
            if (target.terminal.scheduled != null) add("Cancel scheduled message" to "cancel_schedule")
            add("New conversation" to "new_chat")
            add("Close terminal" to "close")
        }
        AlertDialog.Builder(this).setTitle("Conversation")
            .setItems(actions.map { it.first }.toTypedArray()) { _, index ->
                when (val action = actions[index].second) {
                    "retry_message" -> (outgoingMessages.values + conversationHistory).lastOrNull {
                        it.pairId == target.pairId && it.terminalId == target.terminal.id && it.deliveryState == "failed"
                    }?.let(::retryConversationMessage)
                    "schedule" -> showScheduleMessage()
                    "close" -> requestCloseTerminal(target)
                    "history" -> {
                        historyRequestedFor = null
                        sendAgentControl("history")
                        Toast.makeText(this, "Loading desktop conversations...", Toast.LENGTH_SHORT).show()
                    }
                    "new_chat" -> {
                        if (target.terminal.status != "idle") {
                            Toast.makeText(this, "Stop the current turn before opening a new conversation.", Toast.LENGTH_LONG).show()
                        } else AlertDialog.Builder(this).setTitle("Start a new conversation?")
                            .setMessage("This also starts a new conversation in the desktop tab. The current conversation stays in history.")
                            .setNegativeButton("Cancel", null).setPositiveButton("New conversation") { _, _ -> sendAgentControl("new_chat") }.show()
                    }
                    else -> sendAgentControl(action)
                }
            }.setNegativeButton("Cancel", null).show()
    }

    private fun showAgentHistory(target: ConversationTarget) {
        if (target.terminal.historyError != null) {
            AlertDialog.Builder(this).setTitle("Conversation history").setMessage(target.terminal.historyError)
                .setPositiveButton("Retry") { _, _ -> historyRequestedFor = null; sendAgentControl("history") }
                .setNegativeButton("Close", null).show()
            return
        }
        val json = JSONArray(target.terminal.history ?: "[]")
        val rows = (0 until json.length()).map { json.getJSONObject(it) }
        if (rows.isEmpty()) {
            AlertDialog.Builder(this).setTitle("Conversation history").setMessage("No saved conversations for this agent in this folder.")
                .setPositiveButton("Close", null).show()
            return
        }
        AlertDialog.Builder(this).setTitle("Conversation history")
            .setItems(rows.map { row ->
                val title = row.optString("title").ifBlank { "Untitled conversation" }
                val at = row.optLong("updatedAt")
                if (at > 0) "$title\n${DateUtils.getRelativeTimeSpanString(at)}" else title
            }.toTypedArray()) { _, index ->
                if (target.terminal.status != "idle") {
                    Toast.makeText(this, "Stop the current turn before resuming a conversation.", Toast.LENGTH_LONG).show()
                } else AlertDialog.Builder(this).setTitle("Resume conversation?")
                    .setMessage("Open this conversation in the desktop tab and on this phone?")
                    .setNegativeButton("Cancel", null).setPositiveButton("Resume") { _, _ ->
                        sendAgentControl("resume", value = rows[index].getString("id"))
                    }.show()
            }.setNegativeButton("Close", null).show()
    }

    private fun showScheduleMessage() {
        if (draftLoading) return
        if (conversationInput.text.isBlank() && selectedDraftAttachment == null) {
            conversationInput.requestFocus()
            Toast.makeText(this, "Write a message before scheduling it.", Toast.LENGTH_SHORT).show()
            return
        }
        val choices = arrayOf("In 5 minutes", "In 15 minutes", "In 30 minutes", "Choose date and time", "When another agent finishes")
        AlertDialog.Builder(this).setTitle("Schedule message").setItems(choices) { _, index ->
            if (index < 3) {
                val minutes = listOf(5, 15, 30)[index]
                sendAgentControl("schedule", scheduledAt = System.currentTimeMillis() + minutes * 60_000L)
            } else if (index == 3) {
                val time = Calendar.getInstance()
                DatePickerDialog(this, { _, year, month, day ->
                    time.set(year, month, day)
                    TimePickerDialog(this, { _, hour, minute ->
                        time.set(Calendar.HOUR_OF_DAY, hour); time.set(Calendar.MINUTE, minute); time.set(Calendar.SECOND, 0)
                        if (time.timeInMillis <= System.currentTimeMillis()) Toast.makeText(this, "Choose a future time.", Toast.LENGTH_SHORT).show()
                        else sendAgentControl("schedule", scheduledAt = time.timeInMillis)
                    }, time.get(Calendar.HOUR_OF_DAY), time.get(Calendar.MINUTE), android.text.format.DateFormat.is24HourFormat(this)).show()
                }, time.get(Calendar.YEAR), time.get(Calendar.MONTH), time.get(Calendar.DAY_OF_MONTH)).apply {
                    datePicker.minDate = System.currentTimeMillis()
                    datePicker.maxDate = System.currentTimeMillis() + 30 * 86_400_000L
                }.show()
            } else {
                val target = selectedTarget ?: return@setItems
                val candidates = cachedSnapshots.firstOrNull { it.pairId == target.pairId }?.projects.orEmpty()
                    .flatMap { project -> project.terminals.filter { it.id != target.terminal.id && it.isWorking }.map { project.name to it } }
                if (candidates.isEmpty()) Toast.makeText(this, "No other agents are working on this desktop.", Toast.LENGTH_LONG).show()
                else AlertDialog.Builder(this).setTitle("Send when agent finishes")
                    .setItems(candidates.map { "${it.first} ? ${it.second.agent ?: it.second.title}" }.toTypedArray()) { _, selected ->
                        sendAgentControl("schedule", targetTerminalId = candidates[selected].second.id)
                    }.setNegativeButton("Cancel", null).show()
            }
        }.setNegativeButton("Cancel", null).show()
    }

    private fun sendAgentControl(action: String, value: String? = null, scheduledAt: Long? = null, targetTerminalId: String? = null) {
        val target = selectedTarget ?: return
        val credentials = SecretStore.load(this, target.pairId) ?: return
        if (!isDesktopOnline(target.pairId)) { showDesktopOffline(); return }
        val text = if (action == "schedule") conversationInput.text.toString() else null
        val attachment = if (action == "schedule") selectedDraftAttachment else null
        commandExecutor.execute {
            val result = runCatching { RelayClient.agentControl(credentials, target.terminal.id, action, value, text, scheduledAt, targetTerminalId, attachment) }
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                result.onSuccess { command ->
                    if (action == "history" && selectedTarget?.let { it.pairId == target.pairId && it.terminal.id == target.terminal.id } == true) {
                        historyRequestedFor = Triple(target.pairId, target.terminal.id, command.id)
                        refreshConversation(reloadHistory = false)
                    }
                    Toast.makeText(this, if (action == "schedule") "Schedule sent to desktop. Keep Duckweed open for delivery." else "Sent to desktop", Toast.LENGTH_SHORT).show()
                    requestRemoteRefresh(showSpinner = false)
                    recoverPendingRelayMessages()
                }.onFailure { error ->
                    historyRequestedFor = null
                    Toast.makeText(this, error.message ?: "Could not reach desktop. Try again.", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun showCreateTerminalDialog() {
        val project = selectedProject ?: return
        if (!project.desktopOnline) { showDesktopOffline(); return }
        val input = EditText(this).apply {
            hint = "Optional command, e.g. codex or claude"
            setSingleLine(true)
        }
        AlertDialog.Builder(this)
            .setTitle("New terminal split")
            .setMessage("Open a new pane in ${project.project.name}.")
            .setView(input)
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Open split") { _, _ ->
                val credentials = SecretStore.load(this, project.pairId) ?: return@setPositiveButton
                val command = input.text.toString()
                val action = PendingMobileAction(
                    id = UUID.randomUUID().toString(),
                    kind = PendingMobileAction.CREATE_TERMINAL,
                    pairId = project.pairId,
                    projectId = project.project.id,
                    label = command.trim().takeIf { it.isNotEmpty() } ?: "New terminal",
                    baselineTerminalIds = project.project.terminals
                        .filter { it.pendingAction == null }
                        .mapTo(mutableSetOf()) { it.id },
                    createdAt = System.currentTimeMillis(),
                )
                beginPendingAction(action)
                executor.execute {
                    runCatching { RelayClient.createTerminal(credentials, project.project.id, command) }
                        .onFailure { error -> runOnUiThread {
                            removePendingAction(action.id)
                            Toast.makeText(this, error.message ?: "Could not open terminal.", Toast.LENGTH_LONG).show()
                        } }
                        .onSuccess { runOnUiThread { requestRemoteRefresh(showSpinner = false) } }
                }
            }.show()
    }

    private fun showCommandBrowser() {
        val commands = selectedTarget?.terminal?.commands.orEmpty()
        if (commands.isEmpty()) { requestRemoteRefresh(); return }
        AlertDialog.Builder(this).setTitle("Agent commands")
            .setItems(commands.map { "${it.name}  ${it.description}" }.toTypedArray()) { _, index ->
                AlertDialog.Builder(this).setTitle("Replace this draft?")
                    .setMessage("The command will replace the text in the composer.")
                    .setNegativeButton("Keep draft", null)
                    .setPositiveButton("Use command") { _, _ ->
                        conversationInput.setText(SlashCommandPolicy.completion(commands[index]))
                        conversationInput.setSelection(conversationInput.length())
                        conversationInput.requestFocus()
                    }.show()
            }.setNegativeButton("Cancel", null).show()
    }

    private fun updateSlashCommandSuggestions() {
        if (!::conversationCommands.isInitialized || !::conversationInput.isInitialized) return
        val target = selectedTarget
        val value = conversationInput.text.toString()
        val catalog = target?.terminal?.commands.orEmpty()
        val visible = target != null && target.terminal.mode == "conversation" &&
            target.terminal.status != "exited" && target.terminal.permission == null &&
            SlashCommandPolicy.isQuery(value, catalog)
        if (!visible) {
            conversationCommandsScroll.visibility = View.GONE
            renderedSuggestions = null
            return
        }
        val suggestions = SlashCommandPolicy.suggestions(value, catalog)
        val empty = if (catalog.isEmpty()) "Commands are not available yet. Tap to sync with desktop."
            else "No matching commands. Try a name or description."
        // Streaming responses must not recreate focused rows or reset the picker scroll.
        if (renderedSuggestions == suggestions && renderedCommandEmpty == empty && conversationCommandsScroll.visibility == View.VISIBLE) return
        renderedSuggestions = suggestions
        renderedCommandEmpty = empty
        conversationCommands.removeAllViews()
        (conversationCommandsScroll as MaxHeightScrollView).scrollTo(0, 0)
        if (suggestions.isEmpty()) {
            conversationCommands.addView(TextView(this).apply {
                text = empty; textSize = 13f; minHeight = dp(56)
                gravity = Gravity.CENTER_VERTICAL; setPadding(dp(12), dp(12), dp(12), dp(12))
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_dim))
                if (catalog.isEmpty()) { isFocusable = true; setOnClickListener { requestRemoteRefresh() } }
            })
        }
        suggestions.forEach { suggestion ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL; isClickable = true; isFocusable = true
                minimumHeight = dp(56)
                background = ContextCompat.getDrawable(this@MainActivity, R.drawable.nav_item)
                setPadding(dp(12), dp(10), dp(12), dp(10))
                contentDescription = "${suggestion.title}. ${suggestion.description}" + if (suggestion.current) ". Current selection" else ""
                setOnClickListener {
                    performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    conversationInput.setText(suggestion.value)
                    conversationInput.setSelection(suggestion.value.length)
                    conversationInput.requestFocus()
                }
            }
            row.addView(TextView(this).apply {
                text = suggestion.title + if (suggestion.current) "  \u2713" else ""
                textSize = 14f
                typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text))
            })
            if (suggestion.description.isNotBlank()) row.addView(TextView(this).apply {
                text = suggestion.description; textSize = 12f; maxLines = 2
                ellipsize = android.text.TextUtils.TruncateAt.END
                setPadding(0, dp(3), 0, 0)
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_text_dim))
            })
            conversationCommands.addView(row, LinearLayout.LayoutParams(-1, -2))
        }
        conversationCommandsScroll.visibility = View.VISIBLE
    }

    private fun usageSwatch(color: Int, sizeDp: Int, cornerDp: Int): View {
        return View(this).apply {
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(cornerDp).toFloat()
                setColor(color)
            }
            minimumWidth = dp(sizeDp)
            minimumHeight = dp(sizeDp)
        }
    }

    private fun usageMeterDrawable(fillColor: Int): LayerDrawable {
        val radius = dp(4).toFloat()
        val track = GradientDrawable().apply {
            cornerRadius = radius
            setColor(ContextCompat.getColor(this@MainActivity, R.color.duckweed_border))
        }
        val fill = GradientDrawable().apply {
            cornerRadius = radius
            setColor(fillColor)
        }
        val clip = ClipDrawable(fill, Gravity.START, ClipDrawable.HORIZONTAL)
        return LayerDrawable(arrayOf(track, clip)).apply {
            setId(0, android.R.id.background)
            setId(1, android.R.id.progress)
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun requestCloseTerminal(target: ConversationTarget) {
        if (!target.desktopOnline) { showDesktopOffline(); return }
        AlertDialog.Builder(this)
            .setTitle("Close terminal?")
            .setMessage("Close ${target.terminal.agent ?: target.terminal.title} on the desktop?")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Close") { _, _ ->
                val credentials = SecretStore.load(this, target.pairId) ?: return@setPositiveButton
                val action = PendingMobileAction(
                    id = UUID.randomUUID().toString(),
                    kind = PendingMobileAction.CLOSE_TERMINAL,
                    pairId = target.pairId,
                    projectId = target.projectId,
                    terminalId = target.terminal.id,
                    label = target.terminal.agent ?: target.terminal.title,
                    createdAt = System.currentTimeMillis(),
                )
                beginPendingAction(action)
                executor.execute {
                    runCatching { RelayClient.closeTerminal(credentials, target.terminal.id) }
                        .onFailure { error -> runOnUiThread {
                            removePendingAction(action.id)
                            Toast.makeText(this, error.message ?: "Could not close terminal.", Toast.LENGTH_LONG).show()
                        } }
                        .onSuccess { runOnUiThread { requestRemoteRefresh(showSpinner = false) } }
                }
            }.show()
    }

    private fun hasNetwork(): Boolean {
        val manager = getSystemService(ConnectivityManager::class.java)
        val capabilities = manager.getNetworkCapabilities(manager.activeNetwork)
        return capabilities?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    private fun requestRemoteRefresh(showSpinner: Boolean = true) {
        if (isFinishing || isDestroyed || !foreground) return
        if (!remoteStateReady) {
            refreshOnLoad = true
            refreshShowsFeedback = refreshShowsFeedback || showSpinner
            refreshRemoteState()
            return
        }
        val credentials = SecretStore.loadAll(this)
        if (credentials.isEmpty()) { finishRemoteRefresh(); return }
        if (!hasNetwork()) {
            finishRemoteRefresh()
            if (showSpinner) Toast.makeText(this, "Connect to Wi-Fi or mobile data, then retry. Your drafts are saved.", Toast.LENGTH_LONG).show()
            return
        }
        refreshShowsFeedback = refreshShowsFeedback || showSpinner
        if (showSpinner) {
            if (selectedPage == Page.PROJECTS) projectsRefresh.isRefreshing = true
            if (selectedPage == Page.ACTIVITY) responsesRefresh.isRefreshing = true
            if (selectedPage == Page.CONVERSATIONS) conversationsRefresh.isRefreshing = true
        }
        // Resume, pull-to-refresh and network callbacks share one in-flight request.
        val focus = selectedTarget?.let { Pair(it.pairId, it.terminal.id) }
        if (refreshRequestedAt > 0) {
            // Opening a different tab must not wait for the app-wide refresh.
            if (focus != null && requestedFocus != focus) {
                requestedFocus = focus
                credentials.firstOrNull { it.pairId == focus.first }?.let { pairing ->
                    commandExecutor.execute {
                        runCatching { RelayClient.requestWorkspaceRefresh(pairing, focus.second) }
                        runOnUiThread { if (!isDestroyed) recoverPendingRelayMessages() }
                    }
                }
            }
            return
        }
        requestedFocus = focus
        val generation = ++refreshGeneration
        refreshRequestedAt = System.currentTimeMillis()
        refreshHadFailure = false
        refreshBaselines = credentials.associate { pair ->
            pair.pairId to (cachedSnapshots.firstOrNull { it.pairId == pair.pairId }?.updatedAt ?: 0L)
        }
        refreshPending = refreshBaselines.keys
        retryConnectionButton.isEnabled = false
        refreshConnectionHealth()
        connectionDot.removeCallbacks(refreshTimeout)
        connectionDot.postDelayed(refreshTimeout, 15_000)
        credentials.forEach { pairing -> syncExecutor.execute {
            val result = runCatching { RelayClient.requestWorkspaceRefresh(pairing, focus?.takeIf { it.first == pairing.pairId }?.second) }
            runOnUiThread {
                if (isDestroyed || generation != refreshGeneration) return@runOnUiThread
                if (result.isFailure) {
                    refreshHadFailure = true
                    refreshPending = refreshPending - pairing.pairId
                    if (refreshPending.isEmpty()) finishRemoteRefresh()
                } else recoverPendingRelayMessages()
            }
        } }
        // Fetch promptly even if a push wake-up is delayed. Never resubmit user input.
        for (delay in listOf(1_000L, 3_000L, 6_000L)) connectionDot.postDelayed({
            if (foreground && !isDestroyed && generation == refreshGeneration) recoverPendingRelayMessages()
        }, delay)
    }

    private fun finishRemoteRefresh(timedOut: Boolean = false) {
        val report = refreshRequestedAt > 0 && refreshShowsFeedback && foreground
        val failed = refreshHadFailure || timedOut
        refreshGeneration++
        refreshRequestedAt = 0
        refreshBaselines = emptyMap()
        refreshPending = emptySet()
        refreshShowsFeedback = false
        if (::connectionDot.isInitialized) connectionDot.removeCallbacks(refreshTimeout)
        if (::responsesRefresh.isInitialized) responsesRefresh.isRefreshing = false
        if (::projectsRefresh.isInitialized) projectsRefresh.isRefreshing = false
        if (::conversationsRefresh.isInitialized) conversationsRefresh.isRefreshing = false
        if (::retryConnectionButton.isInitialized) retryConnectionButton.isEnabled = true
        refreshConnectionHealth()
        if (report && failed) {
            Toast.makeText(this, "Could not finish syncing. Keep Duckweed open on desktop and tap Retry. Saved conversations are still available.", Toast.LENGTH_LONG).show()
        }
    }

    private fun sendConversationMessage() {
        val target = selectedTarget ?: return
        val text = conversationInput.text.toString().trim().take(32_000)
        val attachments = listOfNotNull(selectedDraftAttachment)
        if (text.isEmpty() && attachments.isEmpty()) return
        if (attachments.isNotEmpty() && target.terminal.mode != "conversation") {
            Toast.makeText(this, "Images require the structured agent view.", Toast.LENGTH_LONG).show()
            return
        }
        if (!isDesktopOnline(target.pairId)) {
            showDesktopOffline()
            return
        }
        val commandId = UUID.randomUUID().toString()
        val sentAt = System.currentTimeMillis()
        conversationSend.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        val outgoing = CompletionRecord(
            id = commandId,
            pairId = target.pairId,
            projectId = target.projectId,
            terminalId = target.terminal.id,
            terminalTitle = target.terminal.title,
            sentAt = sentAt,
            agent = "You",
            project = target.projectName,
            kind = "user",
            response = text,
            durationMs = null,
            attachments = attachments,
            deliveryState = "sending",
        )
        outgoingMessages[commandId] = outgoing
        conversationInput.removeCallbacks(draftPersistRunnable)
        DraftStore.io.execute { draftStore.clear(target.pairId, target.terminal.id) }
        selectedDraftAttachment = null
        conversationInput.text.clear()
        renderDraftAttachment()
        conversationShouldStickToBottom = true
        refreshConversation(reloadHistory = false)
        if (target.terminal.mode == "terminal") {
            findViewById<TextView>(R.id.conversation_status).text = "Sending input securely..."
        }
        commandExecutor.execute {
            runCatching {
                MessageStore(this).use { it.put(outgoing) }
                val credentials = SecretStore.load(this, target.pairId)
                    ?: error("Desktop pairing is no longer available. Pair this desktop again.")
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
                MessageStore(this).use { it.updateOutgoingState(commandId, "sent") }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    outgoingMessages[commandId] = outgoing.copy(deliveryState = "sent")
                    if (target.terminal.mode == "terminal") {
                        findViewById<TextView>(R.id.conversation_status).text =
                            "Input delivered. Waiting for terminal output..."
                    } else {
                        refreshConversation()
                    }
                    trackDelivery(
                        commandId,
                        target.pairId,
                        awaitWorkspaceConfirmation = target.terminal.mode == "conversation",
                    )
                }
            }.onFailure { error ->
                MessageStore(this).use {
                    it.updateOutgoingState(commandId, "failed", error.message ?: "Could not send this message.")
                }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    outgoingMessages[commandId] = outgoing.copy(
                        deliveryState = "failed", deliveryError = error.message,
                    )
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
        val text = message.response.orEmpty()
        if (text.isBlank() && message.attachments.none { it.dataUrl != null }) {
            Toast.makeText(this, "This image is no longer available to retry.", Toast.LENGTH_LONG).show()
            return
        }
        conversationList.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
        outgoingMessages[message.id] = message.copy(deliveryState = "sending", deliveryError = null)
        refreshConversation(reloadHistory = false)
        commandExecutor.execute {
            runCatching {
                MessageStore(this).use { it.updateOutgoingState(message.id, "sending") }
                val credentials = SecretStore.load(this, pairId)
                    ?: error("Desktop pairing is no longer available. Pair this desktop again.")
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
                MessageStore(this).use { it.updateOutgoingState(message.id, "sent") }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    outgoingMessages[message.id] = message.copy(deliveryState = "sent", deliveryError = null)
                    refreshConversation()
                    trackDelivery(
                        message.id,
                        pairId,
                        awaitWorkspaceConfirmation = selectedTarget?.terminal?.let {
                            it.id == terminalId && it.mode == "conversation"
                        } ?: true,
                    )
                }
            }.onFailure { error ->
                MessageStore(this).use {
                    it.updateOutgoingState(message.id, "failed", error.message ?: "Could not send this message.")
                }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    outgoingMessages[message.id] = message.copy(deliveryState = "failed", deliveryError = error.message)
                    refreshConversation()
                }
            }
        }
    }

    private fun trackDelivery(
        messageId: String,
        pairId: String,
        awaitWorkspaceConfirmation: Boolean,
    ) {
        if (!deliveryChecks.add(messageId)) return
        scheduleDeliveryCheck(messageId, pairId, awaitWorkspaceConfirmation, 0)
    }

    private fun scheduleDeliveryCheck(
        messageId: String,
        pairId: String,
        awaitWorkspaceConfirmation: Boolean,
        attempt: Int,
    ) {
        conversationList.postDelayed({
            if (isFinishing || isDestroyed) {
                deliveryChecks.remove(messageId)
                return@postDelayed
            }
            syncExecutor.execute {
                val credentials = SecretStore.load(this, pairId)
                val delivered = credentials?.let {
                    runCatching { !RelayClient.isCommandPending(it, messageId) }.getOrNull()
                }
                if (delivered == true) {
                    MessageStore(this).use {
                        it.updateOutgoingState(messageId, if (awaitWorkspaceConfirmation) "received" else "delivered")
                    }
                }
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    when {
                        delivered == true -> {
                            recoverPendingRelayMessages()
                            outgoingMessages.remove(messageId)
                            deliveryChecks.remove(messageId)
                            if (conversationDetail.visibility == View.VISIBLE) refreshConversation()
                        }
                        attempt >= 20 -> deliveryChecks.remove(messageId)
                        else -> scheduleDeliveryCheck(
                            messageId,
                            pairId,
                            awaitWorkspaceConfirmation,
                            attempt + 1,
                        )
                    }
                }
            }
        }, if (attempt == 0) 400L else 1_200L)
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
        if (draftLoading) return
        val target = selectedTarget ?: return
        val draft = ConversationDraft(conversationInput.text.toString(), selectedDraftAttachment)
        DraftStore.io.execute { draftStore.save(target.pairId, target.terminal.id, draft) }
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
            !draftLoading &&
            target != null &&
            target.terminal.status != "exited" &&
            target.terminal.permission == null &&
            isDesktopOnline(target.pairId) &&
            (conversationInput.text.isNotBlank() || selectedDraftAttachment != null)
        conversationSend.alpha = if (conversationSend.isEnabled) 1f else 0.38f
    }

    private fun openIntentResponse() {
        if (isAppLockEnabled() && !appUnlocked) return
        val messageId = intent.getStringExtra("message_id") ?: return
        val message = MessageStore(this).use { it.response(messageId) } ?: return
        intent.removeExtra("message_id")
        navigateToPage(Page.ACTIVITY)
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
        private const val STATE_PAGE_HISTORY = "page-history"
        private const val CONNECTION_FRESH_MS = 75_000L
        private const val PENDING_ALPHA = 0.48f
        private const val APP_LOCK_PREFERENCES = "app-lock"
        private const val APP_LOCK_ENABLED = "enabled"
        private val APP_LOCK_AUTHENTICATORS =
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
    }
}
