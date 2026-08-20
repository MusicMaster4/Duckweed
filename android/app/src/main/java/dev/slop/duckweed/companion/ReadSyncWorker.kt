package dev.slop.duckweed.companion

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters

class ReadSyncWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val store = MessageStore(applicationContext)
        var retry = false
        store.pendingReadSyncs().forEach { sync ->
            val credentials = SecretStore.load(applicationContext, sync.pairId)
            if (credentials == null) {
                retry = true
                return@forEach
            }
            runCatching {
                RelayClient.sendRead(
                    credentials,
                    sync.terminalId,
                    sync.completionSeq,
                    sync.commandId,
                )
            }.onSuccess {
                store.completeReadSync(sync)
            }.onFailure {
                retry = true
            }
        }
        return if (retry) Result.retry() else Result.success()
    }
}

object ReadSyncScheduler {
    private const val WORK_NAME = "duckweed-read-sync"

    fun enqueue(context: Context) {
        val request = OneTimeWorkRequestBuilder<ReadSyncWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build(),
            )
            .build()
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
            WORK_NAME,
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }
}
