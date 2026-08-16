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
    private enum class Page { RESPONSES, CONNECTIONS, UPDATES }

    private lateinit var pairingStatus: TextView
    private lateinit var scanButton: Button
    private lateinit var disconnectButton: Button
    private lateinit var emptyState: View
    private lateinit var notificationsToggle: SwitchCompat
    private lateinit var updateStatus: TextView
    private lateinit var updateButton: Button
    private lateinit var updateProgress: ProgressBar
    private lateinit var appUpdater: AppUpdater
    private val adapter = MessageAdapter()
    private val executor = Executors.newSingleThreadExecutor()
    private var receiverRegistered = false
    private var syncingNotificationsToggle = false
    private var updateAvailable: AndroidUpdateManifest? = null
    private var selectedPage = Page.RESPONSES

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
        override fun onReceive(context: Context?, intent: Intent?) = refreshMessages()
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

        findViewById<RecyclerView>(R.id.message_list).apply {
            layoutManager = LinearLayoutManager(this@MainActivity)
            adapter = this@MainActivity.adapter
        }

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
        refreshMessages()

        if (intent.getStringExtra("message_id") != null) showPage(Page.RESPONSES)
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
        syncNotificationToggle()
        refreshMessages()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getStringExtra("message_id") != null) showPage(Page.RESPONSES)
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
        selectedPage = page
        val pages = mapOf(
            Page.RESPONSES to R.id.responses_page,
            Page.CONNECTIONS to R.id.connections_page,
            Page.UPDATES to R.id.updates_page,
        )
        val navigation = mapOf(
            Page.RESPONSES to R.id.nav_responses,
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
                            .onSuccess { SecretStore.remove(this, pairing.pairId) }
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

    private fun refreshMessages() {
        val messages = MessageStore(this).latest()
        adapter.submit(messages)
        emptyState.visibility = if (messages.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun showPairingError(message: String) {
        scanButton.isEnabled = true
        pairingStatus.text = message
    }

    companion object {
        private const val STATE_PAGE = "selected-page"
    }
}
