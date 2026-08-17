package dev.slop.duckweed.companion

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat

class ApprovalActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECIDE) return
        val messageId = intent.getStringExtra(EXTRA_MESSAGE_ID) ?: return
        val pairId = intent.getStringExtra(EXTRA_PAIR_ID) ?: return
        val projectId = intent.getStringExtra(EXTRA_PROJECT_ID) ?: return
        val terminalId = intent.getStringExtra(EXTRA_TERMINAL_ID) ?: return
        val permissionId = intent.getStringExtra(EXTRA_PERMISSION_ID) ?: return
        val optionId = intent.getStringExtra(EXTRA_OPTION_ID) ?: return
        val pendingResult = goAsync()
        Thread({
            val result = runCatching {
                val credentials = SecretStore.load(context, pairId)
                    ?: error("This desktop is no longer paired.")
                val permission = WorkspaceStore(context).all()
                    .firstOrNull { it.pairId == pairId }
                    ?.projects
                    ?.asSequence()
                    ?.flatMap { it.terminals.asSequence() }
                    ?.firstOrNull { it.id == terminalId }
                    ?.permission
                    ?: error("This approval is no longer pending.")
                check(permission.id == permissionId) { "This approval has changed." }
                check(permission.options.any { it.id == optionId }) { "This option is no longer available." }
                RelayClient.sendApproval(
                    credentials,
                    projectId,
                    terminalId,
                    permissionId,
                    optionId,
                )
            }
            Handler(Looper.getMainLooper()).post {
                result.onSuccess {
                    MessageStore(context).markRead(messageId)
                    NotificationManagerCompat.from(context).cancel(messageId.hashCode())
                    Toast.makeText(context, "Decision sent securely", Toast.LENGTH_SHORT).show()
                    NotificationTools.announceChanged(context)
                }.onFailure { error ->
                    MessageStore(context).response(messageId)?.let { NotificationTools.show(context, it) }
                    Toast.makeText(
                        context,
                        error.message ?: "Could not send this decision. Try again.",
                        Toast.LENGTH_LONG,
                    ).show()
                }
                pendingResult.finish()
            }
        }, "duckweed-approval-action").start()
    }

    companion object {
        const val ACTION_DECIDE = "dev.slop.duckweed.companion.APPROVAL_DECIDE"
        const val EXTRA_MESSAGE_ID = "message_id"
        const val EXTRA_PAIR_ID = "pair_id"
        const val EXTRA_PROJECT_ID = "project_id"
        const val EXTRA_TERMINAL_ID = "terminal_id"
        const val EXTRA_PERMISSION_ID = "permission_id"
        const val EXTRA_OPTION_ID = "option_id"
    }
}
