package dev.slop.duckweed.companion

import android.text.format.DateUtils
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView

class ConversationAdapter : RecyclerView.Adapter<ConversationAdapter.Holder>() {
    private var messages: List<CompletionRecord> = emptyList()

    fun submit(next: List<CompletionRecord>) {
        messages = next
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_conversation_message, parent, false),
    )

    override fun getItemCount(): Int = messages.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val message = messages[position]
        val outgoing = message.kind == "user"
        holder.row.gravity = if (outgoing) Gravity.END else Gravity.START
        holder.bubble.setBackgroundResource(if (outgoing) R.drawable.bubble_user else R.drawable.bubble_agent)
        holder.author.text = if (outgoing) "YOU" else message.agent.uppercase()
        holder.author.setTextColor(
            ContextCompat.getColor(
                holder.itemView.context,
                if (outgoing) R.color.duckweed_text_dim else R.color.duckweed_accent,
            ),
        )
        holder.text.text = message.response
            ?: "This terminal session did not expose a structured final response."
        holder.time.text = DateUtils.getRelativeTimeSpanString(
            message.sentAt,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
        )
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val row: LinearLayout = view.findViewById(R.id.conversation_row)
        val bubble: LinearLayout = view.findViewById(R.id.conversation_bubble)
        val author: TextView = view.findViewById(R.id.conversation_author)
        val text: TextView = view.findViewById(R.id.conversation_text)
        val time: TextView = view.findViewById(R.id.conversation_time)
    }
}
