package dev.slop.duckweed.companion

import android.content.Context

object NotificationPreference {
    private const val PREFERENCES = "duckweed-notification-preferences"
    private const val ENABLED = "completion-notifications-enabled"

    fun isEnabled(context: Context): Boolean =
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getBoolean(ENABLED, true)

    fun setEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(ENABLED, enabled)
            .apply()
    }
}
