package dev.slop.duckweed.companion

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

class MessageStore(context: Context) : SQLiteOpenHelper(context, "duckweed-messages.db", null, 2) {
    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE messages (
              id TEXT PRIMARY KEY,
              sent_at INTEGER NOT NULL,
              encrypted_payload TEXT NOT NULL
            )
            """.trimIndent(),
        )
        database.execSQL("CREATE INDEX messages_sent_at ON messages(sent_at DESC)")
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        database.execSQL("DROP TABLE IF EXISTS messages")
        onCreate(database)
    }

    fun put(message: CompletionRecord) {
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
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
        writableDatabase.execSQL(
            "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY sent_at DESC LIMIT 200)",
        )
    }

    fun latest(): List<CompletionRecord> {
        val messages = mutableListOf<CompletionRecord>()
        readableDatabase.query(
            "messages",
            arrayOf("encrypted_payload"),
            null,
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
}
