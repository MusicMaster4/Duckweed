package dev.slop.duckweed.companion

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

class MessageStore(context: Context) : SQLiteOpenHelper(context, "duckweed-messages.db", null, 3) {
    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE messages (
              id TEXT PRIMARY KEY,
              sent_at INTEGER NOT NULL,
              encrypted_payload TEXT NOT NULL,
              notified_at INTEGER
            )
            """.trimIndent(),
        )
        database.execSQL("CREATE INDEX messages_sent_at ON messages(sent_at DESC)")
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 3) {
            database.execSQL("ALTER TABLE messages ADD COLUMN notified_at INTEGER")
            // Responses from an older build have already had their alert. Do not
            // replay the entire history the first time the new toggle is enabled.
            database.execSQL("UPDATE messages SET notified_at = sent_at")
        }
    }

    fun put(message: CompletionRecord) {
        val notifiedAt = notifiedAt(message.id)
        val payload = JSONObject()
            .put("id", message.id)
            .put("sentAt", message.sentAt)
            .put("agent", message.agent)
            .put("project", message.project)
            .put("kind", message.kind)
            .put("response", message.response)
            .put("durationMs", message.durationMs)
            .toString()
            .toByteArray(Charsets.UTF_8)
        writableDatabase.insertWithOnConflict(
            "messages",
            null,
            ContentValues().apply {
                put("id", message.id)
                put("sent_at", message.sentAt)
                put("encrypted_payload", SecretStore.encryptLocal(payload))
                if (notifiedAt != null) put("notified_at", notifiedAt)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
        writableDatabase.execSQL(
            "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY sent_at DESC LIMIT 200)",
        )
    }

    fun markNotified(messageId: String, at: Long = System.currentTimeMillis()) {
        writableDatabase.update(
            "messages",
            ContentValues().apply { put("notified_at", at) },
            "id = ?",
            arrayOf(messageId),
        )
    }

    fun isNotificationPending(messageId: String): Boolean = notifiedAt(messageId) == null

    fun pendingNotifications(): List<CompletionRecord> = latest("notified_at IS NULL")

    fun latest(): List<CompletionRecord> = latest(null)

    private fun latest(selection: String?): List<CompletionRecord> {
        val messages = mutableListOf<CompletionRecord>()
        readableDatabase.query(
            "messages",
            arrayOf("encrypted_payload"),
            selection,
            null,
            null,
            null,
            "sent_at DESC",
            "200",
        ).use { cursor ->
            while (cursor.moveToNext()) {
                runCatching {
                    JSONObject(String(SecretStore.decryptLocal(cursor.getString(0)), Charsets.UTF_8))
                }.getOrNull()?.let { json ->
                    messages += CompletionRecord(
                        id = json.getString("id"),
                        sentAt = json.getLong("sentAt"),
                        agent = json.getString("agent"),
                        project = json.getString("project"),
                        kind = json.optString("kind", "completed"),
                        response = if (json.isNull("response")) null else json.getString("response"),
                        durationMs = if (json.isNull("durationMs")) null else json.getLong("durationMs"),
                    )
                }
            }
        }
        return messages
    }

    private fun notifiedAt(messageId: String): Long? {
        readableDatabase.query(
            "messages",
            arrayOf("notified_at"),
            "id = ?",
            arrayOf(messageId),
            null,
            null,
            null,
            "1",
        ).use { cursor ->
            if (!cursor.moveToFirst() || cursor.isNull(0)) return null
            return cursor.getLong(0)
        }
    }
}
