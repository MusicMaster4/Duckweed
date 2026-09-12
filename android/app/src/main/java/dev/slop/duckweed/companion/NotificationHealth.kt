package dev.slop.duckweed.companion

import android.app.Activity
import android.app.ActivityManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.text.format.DateUtils
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.RemoteMessage

/** Local delivery diagnostics only. Never stores message content or credentials. */
object NotificationHealth {
    private const val PREFERENCES = "duckweed-notification-health"

    fun recordDelivery(context: Context, message: RemoteMessage) {
        if (message.originalPriority != RemoteMessage.PRIORITY_HIGH) return
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
            .putLong("last_alert_at", System.currentTimeMillis())
            .putBoolean("last_alert_delayed", message.priority != RemoteMessage.PRIORITY_HIGH)
            .apply()
    }

    fun describe(context: Context): String = buildList {
        val manager = context.getSystemService(NotificationManager::class.java)
        when {
            !NotificationPreference.isEnabled(context) -> add("Alerts are off in Duckweed. Enable Notifications in Activity.")
            !NotificationManagerCompat.from(context).areNotificationsEnabled() ->
                add("Android is blocking notifications. Open notification settings to allow alerts.")
            else -> {
                val quietChannels = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    manager.notificationChannels.count {
                        it.id.startsWith("agent-completions-v3-") &&
                            (it.importance < NotificationManager.IMPORTANCE_DEFAULT || it.sound == null)
                    }
                } else 0
                add(if (quietChannels > 0) "$quietChannels sound channels are muted or disabled. Review notification settings."
                    else "Android notifications are allowed.")
            }
        }
        val audio = context.getSystemService(AudioManager::class.java)
        if (audio.ringerMode != AudioManager.RINGER_MODE_NORMAL || audio.getStreamVolume(AudioManager.STREAM_NOTIFICATION) == 0) {
            add("Notification sound is muted by the phone's sound settings.")
        }
        if (manager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL &&
            manager.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_UNKNOWN) {
            add("Do Not Disturb is active and may silence alerts.")
        }
        val power = context.getSystemService(PowerManager::class.java)
        val restricted = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            context.getSystemService(ActivityManager::class.java).isBackgroundRestricted
        when {
            restricted -> add("Android restricts Duckweed in the background. Open battery settings and allow background use.")
            !power.isIgnoringBatteryOptimizations(context.packageName) ->
                add("Battery optimization is enabled. If alerts arrive only after waking the phone, allow unrestricted battery use for Duckweed.")
            else -> add("Duckweed is exempt from Android battery optimization.")
        }
        val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
        val last = preferences.getLong("last_alert_at", 0L)
        if (last > 0) {
            val time = DateUtils.getRelativeTimeSpanString(last, System.currentTimeMillis(), DateUtils.SECOND_IN_MILLIS)
            add("Last alert push received $time.")
            if (preferences.getBoolean("last_alert_delayed", false)) {
                add("Firebase lowered the last alert's delivery priority. Delivery can wait until the phone wakes.")
            }
        } else {
            add("No alert push recorded yet. Use Send test in desktop Mobile notifications to check delivery.")
        }
    }.joinToString("\n\n")

    fun openNotificationSettings(activity: Activity) {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
        } else appDetails(activity)
        open(activity, intent)
    }

    fun openBatterySettings(activity: Activity) {
        // Leave the choice to the user through the standard Android settings.
        open(activity, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    private fun appDetails(context: Context) = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"),
    )

    private fun open(activity: Activity, intent: Intent) {
        runCatching { activity.startActivity(intent) }.recoverCatching {
            activity.startActivity(appDetails(activity))
        }.onFailure {
            Toast.makeText(activity, "Open Android Settings, then Apps, then Duckweed.", Toast.LENGTH_LONG).show()
        }
    }
}
