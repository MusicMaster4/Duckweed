package dev.slop.duckweed.companion

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

object NotificationTools {
    private const val SILENT_CHANNEL_ID = "agent-completions-v2-silent"
    private const val SOUND_CHANNEL_PREFIX = "agent-completions-v3-"
    const val ACTION_MESSAGES_CHANGED = "dev.slop.duckweed.companion.MESSAGES_CHANGED"

    fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java)
        val silent = NotificationChannel(
            SILENT_CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.notification_channel_description)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            setSound(null, null)
        }
        manager.createNotificationChannel(silent)
        completionSounds.forEachIndexed { index, sound ->
            val id = "$SOUND_CHANNEL_PREFIX$index"
            if (manager.getNotificationChannel(id) != null) return@forEachIndexed
            val previous = manager.getNotificationChannel("agent-completions-v2-$index")
            val channel = NotificationChannel(
                id,
                "${context.getString(R.string.notification_channel_name)} ${index + 1}",
                previous?.importance ?: NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.notification_channel_description)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
                // Channel sounds are immutable. Preserve user choices while
                // migrating bundled sounds away from unstable numeric IDs.
                val oldSound = previous?.sound
                val bundled = oldSound?.scheme == "android.resource" &&
                    oldSound.authority == context.packageName
                val customized = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                    previous?.hasUserSetSound() == true
                setSound(
                    if (previous == null || (bundled && !customized)) soundUri(context, sound) else oldSound,
                    previous?.audioAttributes ?: notificationAudioAttributes,
                )
                if (previous != null) {
                    enableVibration(previous.shouldVibrate())
                    previous.vibrationPattern?.let { setVibrationPattern(it) }
                    setShowBadge(previous.canShowBadge())
                    lockscreenVisibility = previous.lockscreenVisibility
                }
            }
            manager.createNotificationChannel(channel)
        }
    }

    /** Also used by relay recovery when the push wake-up was lost. */
    @Synchronized
    fun deliverPending(context: Context, store: MessageStore, message: CompletionRecord) {
        if (MobileNotificationVisibility.consumeIfVisible(context, store, message)) return
        if (!NotificationPreference.isEnabled(context) || message.unreadOnDesktop == false) {
            store.markNotified(message.id, message.sentAt)
        } else if (store.isNotificationPending(message.id) && show(context, message, includeApprovalActions = false)) {
            store.markNotified(message.id)
        }
    }

    fun show(context: Context, message: CompletionRecord, includeApprovalActions: Boolean = true): Boolean {
        if (!NotificationPreference.isEnabled(context)) return false
        if (message.readAt != null || MessageStore(context).use { it.isMessageRead(message.id) }) return false
        if (MobileNotificationVisibility.isViewing(context, message)) return false
        if (
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) return false
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("message_id", message.id)
        }
        val pending = PendingIntent.getActivity(
            context,
            message.id.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val copy = CompletionNotificationCopyBuilder.build(message)
        val channelId = message.soundCue?.takeIf { it in completionSounds.indices }
            ?.let { "$SOUND_CHANNEL_PREFIX$it" }
            ?: SILENT_CHANNEL_ID
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            // WorkManager may be the first process entry point after an update.
            if (manager.getNotificationChannel(channelId) == null) createChannel(context)
            if (manager.getNotificationChannel(channelId)?.importance == NotificationManager.IMPORTANCE_NONE) return false
        }
        val publicVersion = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Duckweed agent update")
            .setContentText("Open the companion to view details")
            .build()
        val builder = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(R.drawable.ic_notification)
            .setLargeIcon(BitmapFactory.decodeResource(context.resources, R.mipmap.ic_launcher))
            .setColor(ContextCompat.getColor(context, R.color.duckweed_accent))
            .setContentTitle(copy.title)
            .setContentText(copy.text)
            .setSubText(copy.context)
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .setBigContentTitle(copy.title)
                    .bigText(copy.expandedText)
                    .setSummaryText(copy.context),
            )
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
        readAction(context, message)?.let(builder::addAction)
        // Loading all encrypted workspaces is deferred until after the initial
        // alert. The full-payload worker adds approval actions silently.
        if (includeApprovalActions) approvalActions(context, message).forEach(builder::addAction)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            message.soundCue?.let { completionSounds.getOrNull(it) }
                ?.let { builder.setSound(soundUri(context, it)) }
        }
        val notification = builder.build()
        NotificationManagerCompat.from(context).notify(message.id.hashCode(), notification)
        return true
    }

    private fun readAction(
        context: Context,
        message: CompletionRecord,
    ): NotificationCompat.Action? {
        if (message.pairId == null || message.terminalId == null) return null
        val intent = Intent(context, ReadActionReceiver::class.java).apply {
            action = ReadActionReceiver.ACTION_MARK_READ
            putExtra(ReadActionReceiver.EXTRA_MESSAGE_ID, message.id)
        }
        val pending = PendingIntent.getBroadcast(
            context,
            "read:${message.id}".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Action.Builder(0, "Mark as read", pending)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
    }

    private fun approvalActions(
        context: Context,
        message: CompletionRecord,
    ): List<NotificationCompat.Action> {
        if (message.kind != "attention") return emptyList()
        val pairId = message.pairId ?: return emptyList()
        val terminalId = message.terminalId ?: return emptyList()
        val target = WorkspaceStore(context).all()
            .firstOrNull { it.pairId == pairId }
            ?.projects
            ?.asSequence()
            ?.mapNotNull { project ->
                project.terminals.firstOrNull { it.id == terminalId }?.let { terminal ->
                    ConversationTarget(pairId, project.id, project.name, project.color, terminal)
                }
            }
            ?.firstOrNull()
            ?: return emptyList()
        val permission = target.terminal.permission ?: return emptyList()
        val options = listOfNotNull(
            permission.options.firstOrNull { it.kind == "allow" }?.let { "Approve" to it },
            permission.options.firstOrNull { it.kind == "reject" }?.let { "Reject" to it },
        )
        return options.map { (label, option) ->
            val actionIntent = Intent(context, ApprovalActionReceiver::class.java).apply {
                action = ApprovalActionReceiver.ACTION_DECIDE
                putExtra(ApprovalActionReceiver.EXTRA_MESSAGE_ID, message.id)
                putExtra(ApprovalActionReceiver.EXTRA_PAIR_ID, pairId)
                putExtra(ApprovalActionReceiver.EXTRA_PROJECT_ID, target.projectId)
                putExtra(ApprovalActionReceiver.EXTRA_TERMINAL_ID, terminalId)
                putExtra(ApprovalActionReceiver.EXTRA_PERMISSION_ID, permission.id)
                putExtra(ApprovalActionReceiver.EXTRA_OPTION_ID, option.id)
            }
            val pending = PendingIntent.getBroadcast(
                context,
                "${message.id}:${option.id}".hashCode(),
                actionIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            NotificationCompat.Action.Builder(0, label, pending)
                .setAuthenticationRequired(true)
                .build()
        }
    }

    fun cancel(context: Context, messages: List<CompletionRecord>) {
        cancelIds(context, messages.map { it.id })
    }

    fun cancelIds(context: Context, messageIds: List<String>) {
        val manager = NotificationManagerCompat.from(context)
        messageIds.forEach { manager.cancel(it.hashCode()) }
    }

    fun cancelAll(context: Context) {
        NotificationManagerCompat.from(context).cancelAll()
    }

    fun refreshApprovalActions(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return
        val activeIds = context.getSystemService(NotificationManager::class.java)
            .activeNotifications
            .map { it.id }
            .toSet()
        if (activeIds.isEmpty()) return
        MessageStore(context).use { it.latest() }
            .filter { it.kind == "attention" && it.id.hashCode() in activeIds }
            .forEach { show(context, it) }
    }

    fun announceChanged(context: Context) {
        context.sendBroadcast(Intent(ACTION_MESSAGES_CHANGED).setPackage(context.packageName))
    }

    private val completionSounds = intArrayOf(
        R.raw.completion_sound_a,
        R.raw.completion_sound_c,
        R.raw.completion_sound_c_2,
        R.raw.completion_sound_d,
        R.raw.completion_sound_e,
        R.raw.completion_sound_g,
    )

    private val notificationAudioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_NOTIFICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()

    private fun soundUri(context: Context, resource: Int): Uri = Uri.parse(
        "${android.content.ContentResolver.SCHEME_ANDROID_RESOURCE}://${context.packageName}/raw/${context.resources.getResourceEntryName(resource)}",
    )
}
