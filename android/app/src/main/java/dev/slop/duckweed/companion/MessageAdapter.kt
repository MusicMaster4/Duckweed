package dev.slop.duckweed.companion

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView

class MessageAdapter(
    private val onOpen: (CompletionRecord) -> Unit,
) : RecyclerView.Adapter<MessageAdapter.Holder>() {
    private var messages: List<CompletionRecord> = emptyList()

    fun submit(next: List<CompletionRecord>) {
        messages = next
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
        val view = LayoutInflater.from(parent.context).inflate(R.layout.item_message, parent, false)
        return Holder(view)
    }

    override fun getItemCount(): Int = messages.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val message = messages[position]
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
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val agent: TextView = view.findViewById(R.id.message_agent)
        val project: TextView = view.findViewById(R.id.message_project)
        val time: TextView = view.findViewById(R.id.message_time)
        val response: TextView = view.findViewById(R.id.message_response)
        val expand: TextView = view.findViewById(R.id.message_expand)
    }
}
