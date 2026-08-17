package dev.slop.duckweed.companion

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.DiffUtil

class MessageAdapter(
    private val onOpen: (CompletionRecord) -> Unit,
) : RecyclerView.Adapter<MessageAdapter.Holder>() {
    private var messages: List<CompletionRecord> = emptyList()

    fun submit(next: List<CompletionRecord>) {
        if (next == messages) return
        val previous = messages
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize(): Int = previous.size
            override fun getNewListSize(): Int = next.size
            override fun areItemsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition].id == next[newItemPosition].id
            override fun areContentsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition] == next[newItemPosition]
        })
        messages = next
        diff.dispatchUpdatesTo(this)
    }

    fun markRead(messageId: String, at: Long = System.currentTimeMillis()) {
        val index = messages.indexOfFirst { it.id == messageId }
        if (index < 0 || messages[index].readAt != null) return
        messages = messages.toMutableList().also { it[index] = it[index].copy(readAt = at) }
        notifyItemChanged(index)
    }

    fun markConversationRead(pairId: String, terminalId: String, at: Long = System.currentTimeMillis()) {
        val changed = mutableListOf<Int>()
        messages = messages.mapIndexed { index, message ->
            if (
                message.pairId == pairId && message.terminalId == terminalId && message.readAt == null
            ) {
                changed += index
                message.copy(readAt = at)
            } else {
                message
            }
        }
        changed.forEach(::notifyItemChanged)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_message, parent, false)
        return Holder(view)
    }

    override fun getItemCount(): Int = messages.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val message = messages[position]
        holder.itemView.setBackgroundResource(
            if (message.readAt == null) R.drawable.message_card_unread else R.drawable.message_card,
        )
        holder.agent.text = if (message.kind == "attention") {
            "${message.agent} · needs attention"
        } else {
            message.agent
        }
        holder.agent.setTextColor(
            ContextCompat.getColor(
                holder.itemView.context,
                if (message.kind == "attention") R.color.duckweed_attention else R.color.duckweed_accent,
            ),
        )
        holder.project.text = message.project
        holder.time.text = DateUtils.getRelativeTimeSpanString(
            message.sentAt,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
        )
        holder.response.text = message.response
            ?: "This terminal-only session did not expose a structured final response."
        holder.response.maxLines = 5
        holder.expand.visibility = View.VISIBLE
        holder.expand.text = "Open conversation  ›"
        holder.itemView.setOnClickListener { onOpen(message) }
        holder.itemView.contentDescription = buildString {
            if (message.readAt == null) append("Unread response. ")
            append("${message.agent}, ${message.project}")
        }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val agent: TextView = view.findViewById(R.id.message_agent)
        val project: TextView = view.findViewById(R.id.message_project)
        val time: TextView = view.findViewById(R.id.message_time)
        val response: TextView = view.findViewById(R.id.message_response)
        val expand: TextView = view.findViewById(R.id.message_expand)
    }
}
