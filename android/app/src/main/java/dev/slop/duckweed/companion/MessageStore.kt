package dev.slop.duckweed.companion

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID

class MessageStore(context: Context) : SQLiteOpenHelper(context, "duckweed-messages.db", null, 6) {
    override fun onCreate(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE messages (
              id TEXT PRIMARY KEY,
              sent_at INTEGER NOT NULL,
              encrypted_payload TEXT NOT NULL,
              notified_at INTEGER,
              read_at INTEGER,
              pair_id TEXT,
              terminal_id TEXT,
              kind TEXT
            )
            """.trimIndent(),
        )
        database.execSQL("CREATE INDEX messages_sent_at ON messages(sent_at DESC)")
        database.execSQL("CREATE INDEX messages_conversation ON messages(pair_id, terminal_id, sent_at DESC)")
        database.execSQL("CREATE INDEX messages_unread ON messages(read_at, kind, pair_id, terminal_id)")
        database.execSQL(
            "CREATE TABLE conversation_reads (pair_id TEXT NOT NULL, terminal_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY(pair_id, terminal_id))",
        )
        createPendingReadSyncs(database)
    }

    override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 3) {
            database.execSQL("ALTER TABLE messages ADD COLUMN notified_at INTEGER")
            // Responses from an older build have already had their alert. Do not
            // replay the entire history the first time the new toggle is enabled.
            database.execSQL("UPDATE messages SET notified_at = sent_at")
        }
        if (oldVersion < 4) {
            database.execSQL("ALTER TABLE messages ADD COLUMN read_at INTEGER")
            // Do not turn the existing response history red after an upgrade.
            database.execSQL("UPDATE messages SET read_at = sent_at")
        }
        if (oldVersion < 5) {
            database.execSQL("ALTER TABLE messages ADD COLUMN pair_id TEXT")
            database.execSQL("ALTER TABLE messages ADD COLUMN terminal_id TEXT")
            database.execSQL("ALTER TABLE messages ADD COLUMN kind TEXT")
            backfillRoutingColumns(database)
            database.execSQL("CREATE INDEX messages_conversation ON messages(pair_id, terminal_id, sent_at DESC)")
            database.execSQL("CREATE INDEX messages_unread ON messages(read_at, kind, pair_id, terminal_id)")
            database.execSQL(
                "CREATE TABLE conversation_reads (pair_id TEXT NOT NULL, terminal_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY(pair_id, terminal_id))",
            )
        }
        if (oldVersion < 6) createPendingReadSyncs(database)
    }

    fun put(message: CompletionRecord) {
        val state = deliveryState(message.id)
        val readAt = state.readAt
            ?: message.readAt
            ?: message.sentAt.takeIf { message.unreadOnDesktop == false }
            ?: message.sentAt.takeIf {
                val pairId = message.pairId
                val terminalId = message.terminalId
                pairId != null && terminalId != null &&
                    it <= conversationReadAt(writableDatabase, pairId, terminalId)
            }
        if (message.unreadOnDesktop == false && message.pairId != null && message.terminalId != null) {
            markConversationReadThrough(
                writableDatabase,
                message.pairId,
                message.terminalId,
                message.sentAt,
            )
        }
        writableDatabase.insertWithOnConflict(
            "messages",
            null,
            valuesFor(message, state.notifiedAt, readAt),
            SQLiteDatabase.CONFLICT_REPLACE,
        )
        prune(writableDatabase)
    }

    private fun valuesFor(
        message: CompletionRecord,
        notifiedAt: Long?,
        readAt: Long?,
    ): ContentValues {
        val payload = JSONObject()
            .put("id", message.id)
            .put("pairId", message.pairId)
            .put("sentAt", message.sentAt)
            .put("agent", message.agent)
            .put("project", message.project)
            .put("projectId", message.projectId)
            .put("terminalId", message.terminalId)
            .put("terminalTitle", message.terminalTitle)
            .put("kind", message.kind)
            .put("response", message.response)
            .put("durationMs", message.durationMs)
            .put("soundCue", message.soundCue)
            .put("deliveryState", message.deliveryState)
            .put("deliveryError", message.deliveryError)
            .put("unreadOnDesktop", message.unreadOnDesktop)
            .put("completionSeq", message.completionSeq)
            .put(
                "attachments",
                JSONArray().apply {
                    message.attachments.forEach { attachment ->
                        put(
                            JSONObject()
                                .put("id", attachment.id)
                                .put("name", attachment.name)
                                .put("mimeType", attachment.mimeType)
                                .put("dataUrl", attachment.dataUrl)
                                .put("size", attachment.size),
                        )
                    }
                },
            )
            .toString()
            .toByteArray(Charsets.UTF_8)
        return ContentValues().apply {
            put("id", message.id)
            put("sent_at", message.sentAt)
            put("encrypted_payload", SecretStore.encryptLocal(payload))
            put("pair_id", message.pairId)
            put("terminal_id", message.terminalId)
            put("kind", message.kind)
            if (notifiedAt != null) put("notified_at", notifiedAt)
            if (readAt != null) put("read_at", readAt)
        }
    }

    fun markNotified(messageId: String, at: Long = System.currentTimeMillis()) {
        writableDatabase.update(
            "messages",
            ContentValues().apply { put("notified_at", at) },
            "id = ?",
            arrayOf(messageId),
        )
    }

    fun markRead(messageId: String, at: Long = System.currentTimeMillis()) {
        writableDatabase.update(
            "messages",
            ContentValues().apply { put("read_at", at) },
            "id = ?",
            arrayOf(messageId),
        )
    }

    fun markConversationRead(
        pairId: String,
        terminalId: String,
        completionSeq: Long?,
        at: Long = System.currentTimeMillis(),
    ): List<String> {
        val database = writableDatabase
        var messageIds = emptyList<String>()
        database.beginTransaction()
        try {
            messageIds = unreadMessageIds(database, pairId, terminalId, at)
            markConversationReadThrough(database, pairId, terminalId, at)
            if (messageIds.isNotEmpty()) {
                database.insertWithOnConflict(
                    "pending_read_syncs",
                    null,
                    ContentValues().apply {
                        put("pair_id", pairId)
                        put("terminal_id", terminalId)
                        if (completionSeq != null) put("completion_seq", completionSeq) else putNull("completion_seq")
                        put("command_id", UUID.randomUUID().toString())
                    },
                    SQLiteDatabase.CONFLICT_REPLACE,
                )
            }
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
        return messageIds
    }

    fun pendingReadSyncs(): List<PendingReadSync> {
        val pending = mutableListOf<PendingReadSync>()
        readableDatabase.query(
            "pending_read_syncs",
            arrayOf("pair_id", "terminal_id", "completion_seq", "command_id"),
            null,
            null,
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                pending += PendingReadSync(
                    pairId = cursor.getString(0),
                    terminalId = cursor.getString(1),
                    completionSeq = if (cursor.isNull(2)) null else cursor.getLong(2),
                    commandId = cursor.getString(3),
                )
            }
        }
        return pending
    }

    fun completeReadSync(sync: PendingReadSync) {
        writableDatabase.delete(
            "pending_read_syncs",
            "pair_id = ? AND terminal_id = ? AND command_id = ?",
            arrayOf(sync.pairId, sync.terminalId, sync.commandId),
        )
    }

    fun discardReadSyncs(pairId: String) {
        writableDatabase.delete("pending_read_syncs", "pair_id = ?", arrayOf(pairId))
    }

    fun unreadConversationKeys(): Set<Pair<String, String>> {
        val keys = mutableSetOf<Pair<String, String>>()
        readableDatabase.query(
            true,
            "messages",
            arrayOf("pair_id", "terminal_id"),
            "read_at IS NULL AND kind IN (?, ?) AND pair_id IS NOT NULL AND terminal_id IS NOT NULL",
            arrayOf("completed", "attention"),
            null,
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) keys += Pair(cursor.getString(0), cursor.getString(1))
        }
        return keys
    }

    fun isNotificationPending(messageId: String): Boolean = notifiedAt(messageId) == null

    fun dismissPendingNotifications(at: Long = System.currentTimeMillis()) {
        writableDatabase.update(
            "messages",
            ContentValues().apply { put("notified_at", at) },
            "notified_at IS NULL",
            null,
        )
    }

    fun pendingNotifications(): List<CompletionRecord> =
        read("notified_at IS NULL").filter { it.kind == "completed" || it.kind == "attention" }

    fun latest(): List<CompletionRecord> =
        read(
            "kind IN (?, ?) OR kind IS NULL",
            arrayOf("completed", "attention"),
        ).filter { it.kind == "completed" || it.kind == "attention" }

    fun latestForOpenAgents(
        openTerminals: Set<Pair<String, String>>,
        limit: Int = 50,
    ): List<CompletionRecord> {
        val responses = latest()
        val visible = if (openTerminals.isEmpty()) {
            responses
        } else {
            responses.filter { message ->
                val pairId = message.pairId
                val terminalId = message.terminalId
                pairId != null && terminalId != null && Pair(pairId, terminalId) in openTerminals
            }
        }
        return visible.distinctBy { message ->
            message.terminalId?.let { "${message.pairId.orEmpty()}:$it" }
                ?: "${message.pairId.orEmpty()}:${message.projectId ?: message.project}:${message.agent.lowercase()}"
        }.take(limit.coerceIn(1, 50))
    }

    fun response(messageId: String): CompletionRecord? =
        message(messageId)?.takeIf { it.kind == "completed" || it.kind == "attention" }

    fun message(messageId: String): CompletionRecord? =
        read("id = ?", arrayOf(messageId)).firstOrNull()

    fun conversation(pairId: String, terminalId: String): List<CompletionRecord> =
        read(
            "(pair_id = ? AND terminal_id = ?) OR pair_id IS NULL",
            arrayOf(pairId, terminalId),
        )
            .filter { it.pairId == pairId && it.terminalId == terminalId }
            .sortedBy { it.sentAt }

    fun putOutgoing(
        target: ConversationTarget,
        id: String,
        sentAt: Long,
        text: String,
        attachments: List<MobileImageAttachment> = emptyList(),
        deliveryState: String = "sending",
        deliveryError: String? = null,
    ) {
        put(
            CompletionRecord(
                id = id,
                pairId = target.pairId,
                sentAt = sentAt,
                agent = "You",
                project = target.projectName,
                projectId = target.projectId,
                terminalId = target.terminal.id,
                terminalTitle = target.terminal.title,
                kind = "user",
                response = text,
                durationMs = null,
                soundCue = null,
                workspace = null,
                attachments = attachments,
                deliveryState = deliveryState,
                deliveryError = deliveryError,
            ),
        )
    }

    fun updateOutgoingState(messageId: String, state: String, error: String? = null) {
        val current = message(messageId) ?: return
        val attachments = if (state == "sent" || state == "delivered") {
            current.attachments.map { it.copy(dataUrl = null) }
        } else {
            current.attachments
        }
        put(
            current.copy(
                attachments = attachments,
                deliveryState = state,
                deliveryError = error,
            ),
        )
    }

    fun recoverInterruptedSends() {
        read(null)
            .filter { it.kind == "user" && it.deliveryState == "sending" }
            .forEach {
                put(
                    it.copy(
                        deliveryState = "failed",
                        deliveryError = "Sending was interrupted. Tap to retry.",
                    ),
                )
            }
    }

    fun putSyncedConversation(snapshot: WorkspaceSnapshot): List<String> {
        val database = writableDatabase
        val clearedNotificationIds = mutableListOf<String>()
        database.beginTransaction()
        try {
            snapshot.projects.forEach { project ->
                project.terminals.forEach { terminal ->
                    val mobileReadAt = conversationReadAt(database, snapshot.pairId, terminal.id)
                    val latestAssistantId = terminal.conversation
                        .lastOrNull { it.role == "assistant" && !it.streaming }
                        ?.id
                    terminal.conversation.filterNot { it.streaming }.forEach { message ->
                        val id = "workspace:${snapshot.pairId}:${terminal.id}:${message.id}"
                        val unread = MobileSyncPolicy.isSyncedMessageUnread(
                            terminal.unreadOnDesktop,
                            message.id == latestAssistantId,
                            message.sentAt,
                            mobileReadAt,
                        )
                        val record = CompletionRecord(
                            id = id,
                            pairId = snapshot.pairId,
                            sentAt = message.sentAt,
                            agent = terminal.agent ?: "Agent",
                            project = project.name,
                            projectId = project.id,
                            terminalId = terminal.id,
                            terminalTitle = terminal.title,
                            kind = if (message.role == "user") "user" else "completed",
                            response = message.text,
                            durationMs = null,
                            soundCue = null,
                            workspace = null,
                            readAt = message.sentAt.takeUnless { unread },
                            unreadOnDesktop = terminal.unreadOnDesktop,
                            completionSeq = terminal.completionSeq,
                        )
                        if (!recordExists(database, id)) {
                            database.insertWithOnConflict(
                                "messages",
                                null,
                                valuesFor(record, message.sentAt, record.readAt),
                                SQLiteDatabase.CONFLICT_IGNORE,
                            )
                        }
                        // Records created by older app versions did not have routing columns.
                        database.update(
                            "messages",
                            ContentValues().apply {
                                put("pair_id", snapshot.pairId)
                                put("terminal_id", terminal.id)
                                put("kind", record.kind)
                            },
                            "id = ?",
                            arrayOf(id),
                        )
                    }
                    if (terminal.unreadOnDesktop == false) {
                        clearedNotificationIds += unreadMessageIds(
                            database,
                            snapshot.pairId,
                            terminal.id,
                            snapshot.updatedAt,
                        )
                        markConversationReadThrough(
                            database,
                            snapshot.pairId,
                            terminal.id,
                            snapshot.updatedAt,
                        )
                    }
                }
            }
            prune(database)
            database.setTransactionSuccessful()
        } finally {
            database.endTransaction()
        }
        return clearedNotificationIds
    }

    private fun read(selection: String?, selectionArgs: Array<String>? = null): List<CompletionRecord> {
        val messages = mutableListOf<CompletionRecord>()
        readableDatabase.query(
            "messages",
            arrayOf("encrypted_payload", "read_at"),
            selection,
            selectionArgs,
            null,
            null,
            "sent_at DESC",
            "500",
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val readAt = if (cursor.isNull(1)) null else cursor.getLong(1)
                runCatching {
                    JSONObject(String(SecretStore.decryptLocal(cursor.getString(0)), Charsets.UTF_8))
                }.getOrNull()?.let { json ->
                    val attachmentsJson = json.optJSONArray("attachments") ?: JSONArray()
                    messages += CompletionRecord(
                        id = json.getString("id"),
                        pairId = if (json.isNull("pairId")) null else json.optString("pairId").takeIf { it.isNotBlank() },
                        sentAt = json.getLong("sentAt"),
                        agent = json.getString("agent"),
                        project = json.getString("project"),
                        projectId = if (json.isNull("projectId")) null else json.optString("projectId").takeIf { it.isNotBlank() },
                        terminalId = if (json.isNull("terminalId")) null else json.optString("terminalId").takeIf { it.isNotBlank() },
                        terminalTitle = if (json.isNull("terminalTitle")) null else json.optString("terminalTitle").takeIf { it.isNotBlank() },
                        kind = json.optString("kind", "completed"),
                        response = if (json.isNull("response")) null else json.getString("response"),
                        durationMs = if (json.isNull("durationMs")) null else json.getLong("durationMs"),
                        soundCue = if (json.isNull("soundCue")) null else json.optInt("soundCue").takeIf { it in 0..5 },
                        workspace = null,
                        readAt = readAt,
                        attachments = (0 until attachmentsJson.length()).mapNotNull { index ->
                            val attachment = attachmentsJson.optJSONObject(index) ?: return@mapNotNull null
                            val name = attachment.optString("name")
                            val mimeType = attachment.optString("mimeType")
                            if (name.isBlank() || mimeType.isBlank()) return@mapNotNull null
                            MobileImageAttachment(
                                id = attachment.optString("id", "image-$index"),
                                name = name,
                                mimeType = mimeType,
                                dataUrl = if (attachment.isNull("dataUrl")) null else attachment.optString("dataUrl"),
                                size = attachment.optInt("size"),
                            )
                        },
                        deliveryState = if (json.isNull("deliveryState")) null else json.optString("deliveryState"),
                        deliveryError = if (json.isNull("deliveryError")) null else json.optString("deliveryError"),
                        unreadOnDesktop = if (json.has("unreadOnDesktop") && !json.isNull("unreadOnDesktop")) {
                            json.optBoolean("unreadOnDesktop")
                        } else {
                            null
                        },
                        completionSeq = if (json.has("completionSeq") && !json.isNull("completionSeq")) {
                            json.optLong("completionSeq")
                        } else {
                            null
                        },
                    )
                }
            }
        }
        return messages
    }

    private data class StoredDeliveryState(val notifiedAt: Long?, val readAt: Long?)

    private fun deliveryState(messageId: String): StoredDeliveryState {
        readableDatabase.query(
            "messages",
            arrayOf("notified_at", "read_at"),
            "id = ?",
            arrayOf(messageId),
            null,
            null,
            null,
            "1",
        ).use { cursor ->
            if (!cursor.moveToFirst()) return StoredDeliveryState(null, null)
            return StoredDeliveryState(
                if (cursor.isNull(0)) null else cursor.getLong(0),
                if (cursor.isNull(1)) null else cursor.getLong(1),
            )
        }
    }

    private fun notifiedAt(messageId: String): Long? = deliveryState(messageId).notifiedAt

    private fun prune(database: SQLiteDatabase) {
        database.execSQL(
            "DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY sent_at DESC LIMIT 500)",
        )
    }

    private fun createPendingReadSyncs(database: SQLiteDatabase) {
        database.execSQL(
            """
            CREATE TABLE pending_read_syncs (
              pair_id TEXT NOT NULL,
              terminal_id TEXT NOT NULL,
              completion_seq INTEGER,
              command_id TEXT NOT NULL,
              PRIMARY KEY(pair_id, terminal_id)
            )
            """.trimIndent(),
        )
    }

    private fun conversationReadAt(
        database: SQLiteDatabase,
        pairId: String,
        terminalId: String,
    ): Long = database.query(
        "conversation_reads",
        arrayOf("read_at"),
        "pair_id = ? AND terminal_id = ?",
        arrayOf(pairId, terminalId),
        null,
        null,
        null,
        "1",
    ).use { cursor ->
        if (cursor.moveToFirst()) cursor.getLong(0) else 0L
    }

    private fun markConversationReadThrough(
        database: SQLiteDatabase,
        pairId: String,
        terminalId: String,
        at: Long,
    ) {
        database.update(
            "messages",
            ContentValues().apply { put("read_at", at) },
            "pair_id = ? AND terminal_id = ? AND read_at IS NULL AND sent_at <= ?",
            arrayOf(pairId, terminalId, at.toString()),
        )
        val previous = conversationReadAt(database, pairId, terminalId)
        if (at <= previous) return
        database.insertWithOnConflict(
            "conversation_reads",
            null,
            ContentValues().apply {
                put("pair_id", pairId)
                put("terminal_id", terminalId)
                put("read_at", at)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    private fun recordExists(database: SQLiteDatabase, messageId: String): Boolean =
        database.query(
            "messages",
            arrayOf("id"),
            "id = ?",
            arrayOf(messageId),
            null,
            null,
            null,
            "1",
        ).use { it.moveToFirst() }

    private fun unreadMessageIds(
        database: SQLiteDatabase,
        pairId: String,
        terminalId: String,
        through: Long,
    ): List<String> {
        val ids = mutableListOf<String>()
        database.query(
            "messages",
            arrayOf("id"),
            "pair_id = ? AND terminal_id = ? AND read_at IS NULL AND kind IN (?, ?) AND sent_at <= ?",
            arrayOf(pairId, terminalId, "completed", "attention", through.toString()),
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) ids += cursor.getString(0)
        }
        return ids
    }

    private fun backfillRoutingColumns(database: SQLiteDatabase) {
        database.query(
            "messages",
            arrayOf("id", "encrypted_payload"),
            "pair_id IS NULL OR kind IS NULL",
            null,
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val json = runCatching {
                    JSONObject(String(SecretStore.decryptLocal(cursor.getString(1)), Charsets.UTF_8))
                }.getOrNull() ?: continue
                database.update(
                    "messages",
                    ContentValues().apply {
                        put("pair_id", json.optString("pairId").takeIf { it.isNotBlank() })
                        put("terminal_id", json.optString("terminalId").takeIf { it.isNotBlank() })
                        put("kind", json.optString("kind", "completed"))
                    },
                    "id = ?",
                    arrayOf(cursor.getString(0)),
                )
            }
        }
    }
}
