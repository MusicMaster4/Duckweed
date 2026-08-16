package dev.slop.duckweed.companion

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest

data class AndroidUpdateManifest(
    val channel: String,
    val versionName: String,
    val versionCode: Int,
    val apkUrl: String,
    val sha256: String,
) {
    fun isNewerThan(installedVersionCode: Int): Boolean = versionCode > installedVersionCode

    fun toJson(): String = JSONObject()
        .put("channel", channel)
        .put("versionName", versionName)
        .put("versionCode", versionCode)
        .put("apkUrl", apkUrl)
        .put("sha256", sha256)
        .toString()

    companion object {
        fun fromJson(raw: String): AndroidUpdateManifest {
            val json = JSONObject(raw)
            val channel = json.getString("channel")
            require(channel == "stable" || channel == "testing") { "Unknown update channel." }
            val sha256 = json.getString("sha256").lowercase()
            require(sha256.matches(Regex("[a-f0-9]{64}"))) { "The update checksum is invalid." }
            val apkUrl = json.getString("apkUrl")
            require(URI(apkUrl).run { scheme == "https" && host == "github.com" }) {
                "The update download is not hosted by GitHub."
            }
            return AndroidUpdateManifest(
                channel = channel,
                versionName = json.getString("versionName"),
                versionCode = json.getInt("versionCode"),
                apkUrl = apkUrl,
                sha256 = sha256,
            )
        }
    }
}

object UpdateClient {
    private const val STABLE_MANIFEST =
        "https://github.com/MusicMaster4/Duckweed/releases/latest/download/android-update.json"
    private const val TESTING_MANIFEST =
        "https://github.com/MusicMaster4/Duckweed/releases/download/channel-testing/android-update-beta.json"

    fun manifestUrl(channel: String): String =
        if (channel == "testing") TESTING_MANIFEST else STABLE_MANIFEST

    fun fetch(channel: String): AndroidUpdateManifest {
        val connection = URL(manifestUrl(channel)).openConnection() as HttpURLConnection
        return try {
            connection.connectTimeout = 12_000
            connection.readTimeout = 12_000
            connection.instanceFollowRedirects = true
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("User-Agent", "Duckweed-Companion/${BuildConfig.VERSION_NAME}")
            val status = connection.responseCode
            if (status !in 200..299) error("GitHub returned HTTP $status.")
            val manifest = connection.inputStream.bufferedReader().use { it.readText() }
            AndroidUpdateManifest.fromJson(manifest).also {
                require(it.channel == channel) { "The update belongs to a different channel." }
            }
        } finally {
            connection.disconnect()
        }
    }
}

class AppUpdater(private val context: Context) {
    enum class DownloadState { RUNNING, COMPLETE, FAILED, MISSING }

    private val downloads = context.getSystemService(DownloadManager::class.java)
    private val preferences = context.getSharedPreferences("duckweed-updater", Context.MODE_PRIVATE)

    fun enqueue(manifest: AndroidUpdateManifest): Long {
        val target = updateFile()
        if (target.exists() && !target.delete()) error("Could not replace the previous update download.")
        val request = DownloadManager.Request(Uri.parse(manifest.apkUrl))
            .setTitle("Duckweed Companion ${manifest.versionName}")
            .setDescription("Downloading a verified ${manifest.channelLabel()} update")
            .setMimeType(APK_MIME)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, UPDATE_FILE)
        val id = downloads.enqueue(request)
        preferences.edit()
            .putLong(KEY_DOWNLOAD_ID, id)
            .putString(KEY_MANIFEST, manifest.toJson())
            .apply()
        return id
    }

    fun isPendingDownload(id: Long): Boolean = id == preferences.getLong(KEY_DOWNLOAD_ID, -1L)

    fun pendingDownloadId(): Long? = preferences.getLong(KEY_DOWNLOAD_ID, -1L)
        .takeIf { it >= 0L }

    fun downloadState(id: Long): DownloadState {
        downloads.query(DownloadManager.Query().setFilterById(id)).use { cursor ->
            if (!cursor.moveToFirst()) return DownloadState.MISSING
            return when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                DownloadManager.STATUS_SUCCESSFUL -> DownloadState.COMPLETE
                DownloadManager.STATUS_FAILED -> DownloadState.FAILED
                else -> DownloadState.RUNNING
            }
        }
    }

    fun downloadedManifest(): AndroidUpdateManifest? = preferences.getString(KEY_MANIFEST, null)
        ?.let { runCatching { AndroidUpdateManifest.fromJson(it) }.getOrNull() }

    fun verifyDownload(id: Long): AndroidUpdateManifest {
        require(isPendingDownload(id)) { "This download does not belong to Duckweed." }
        downloads.query(DownloadManager.Query().setFilterById(id)).use { cursor ->
            require(cursor.moveToFirst()) { "The update download could not be found." }
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                error("The update download failed (code $reason).")
            }
        }
        val manifest = downloadedManifest() ?: error("The update details were lost.")
        val file = updateFile()
        require(file.isFile) { "The downloaded APK could not be found." }
        if (!file.sha256().equals(manifest.sha256, ignoreCase = true)) {
            file.delete()
            clearPending()
            error("The downloaded APK failed verification and was removed.")
        }
        return manifest
    }

    fun canInstallPackages(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

    fun requestInstallPermission(): Intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:${context.packageName}"),
    )

    fun installVerified() {
        val manifest = downloadedManifest() ?: error("No verified update is ready.")
        val file = updateFile()
        require(file.isFile && file.sha256().equals(manifest.sha256, ignoreCase = true)) {
            "The update needs to be downloaded again."
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, APK_MIME)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            },
        )
        clearPending()
    }

    fun clearPending() {
        preferences.edit().remove(KEY_DOWNLOAD_ID).remove(KEY_MANIFEST).apply()
    }

    private fun updateFile(): File {
        val directory = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: error("External app storage is unavailable.")
        return File(directory, UPDATE_FILE)
    }

    private fun File.sha256(): String {
        val digest = MessageDigest.getInstance("SHA-256")
        inputStream().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun AndroidUpdateManifest.channelLabel(): String =
        if (channel == "testing") "beta" else "stable"

    companion object {
        private const val APK_MIME = "application/vnd.android.package-archive"
        private const val UPDATE_FILE = "duckweed-companion-update.apk"
        private const val KEY_DOWNLOAD_ID = "download-id"
        private const val KEY_MANIFEST = "manifest"
    }
}
