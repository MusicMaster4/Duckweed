package dev.slop.duckweed.companion

import android.text.format.DateUtils
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView

class MessageAdapter : RecyclerView.Adapter<MessageAdapter.Holder>() {
    private var messages: List<CompletionRecord> = emptyList()
    private val expanded = mutableSetOf<String>()

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
        val isExpanded = expanded.contains(message.id)
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
        holder.response.maxLines = if (isExpanded) Int.MAX_VALUE else 6
        val canExpand = (message.response?.length ?: 0) > 260
        holder.expand.visibility = if (canExpand) View.VISIBLE else View.GONE
        holder.expand.text = if (isExpanded) "Collapse response" else "Show full response"
        holder.itemView.setOnClickListener {
            if (!canExpand) return@setOnClickListener
            if (!expanded.add(message.id)) expanded.remove(message.id)
            notifyItemChanged(holder.bindingAdapterPosition)
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
