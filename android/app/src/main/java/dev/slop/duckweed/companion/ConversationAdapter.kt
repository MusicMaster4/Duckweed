package dev.slop.duckweed.companion

import android.text.format.DateUtils
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView
import io.noties.markwon.Markwon

class ConversationAdapter(
    private val onRetry: (CompletionRecord) -> Unit,
) : RecyclerView.Adapter<ConversationAdapter.Holder>() {
    private var messages: List<CompletionRecord> = emptyList()
    private var markdown: Markwon? = null

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

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_conversation_message, parent, false)
        val renderer = markdown ?: Markwon.create(parent.context).also { markdown = it }
        return Holder(view, renderer)
    }

    override fun getItemCount(): Int = messages.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val message = messages[position]
        val outgoing = message.kind == "user"
        holder.row.gravity = if (outgoing) Gravity.END else Gravity.START
        holder.bubble.setBackgroundResource(if (outgoing) R.drawable.bubble_user else R.drawable.bubble_agent)
        holder.author.text = when {
            outgoing -> "YOU"
            message.streaming -> "${message.agent.uppercase()}  ·  WRITING"
            else -> message.agent.uppercase()
        }
        holder.author.setTextColor(
            ContextCompat.getColor(
                holder.itemView.context,
                if (outgoing) R.color.duckweed_text_dim else R.color.duckweed_accent,
            ),
        )
        holder.markdown.setMarkdown(
            holder.text,
            message.response
                ?: "This terminal session did not expose a structured final response.",
        )
        val attachment = message.attachments.firstOrNull()
        holder.text.visibility = if (message.response.isNullOrBlank() && attachment != null) View.GONE else View.VISIBLE
        holder.attachment.visibility = if (attachment == null) View.GONE else View.VISIBLE
        holder.attachment.text = attachment?.name
        holder.time.text = DateUtils.getRelativeTimeSpanString(
            message.sentAt,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
        )
        val delivery = if (outgoing) message.deliveryState else null
        holder.delivery.visibility = if (delivery == null) View.GONE else View.VISIBLE
        holder.delivery.text = when (delivery) {
            "sending" -> "Sending securely..."
            "sent" -> "Sent securely"
            "delivered" -> "Received by desktop"
            "failed" -> "Not sent. Tap to retry"
            else -> delivery
        }
        holder.delivery.setTextColor(
            ContextCompat.getColor(
                holder.itemView.context,
                if (delivery == "failed") R.color.duckweed_error else R.color.duckweed_text_faint,
            ),
        )
        val retryable = outgoing && delivery == "failed"
        holder.bubble.isClickable = retryable
        holder.bubble.isFocusable = retryable
        holder.bubble.contentDescription = if (retryable) {
            "Message not sent. Double tap to retry."
        } else {
            null
        }
        holder.bubble.setOnClickListener(if (retryable) View.OnClickListener { onRetry(message) } else null)
    }

    class Holder(view: View, val markdown: Markwon) : RecyclerView.ViewHolder(view) {
        val row: LinearLayout = view.findViewById(R.id.conversation_row)
        val bubble: LinearLayout = view.findViewById(R.id.conversation_bubble)
        val author: TextView = view.findViewById(R.id.conversation_author)
        val text: TextView = view.findViewById(R.id.conversation_text)
        val attachment: TextView = view.findViewById(R.id.conversation_attachment)
        val time: TextView = view.findViewById(R.id.conversation_time)
        val delivery: TextView = view.findViewById(R.id.conversation_delivery)
    }
}
