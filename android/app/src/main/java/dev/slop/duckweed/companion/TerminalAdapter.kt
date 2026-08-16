package dev.slop.duckweed.companion

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView

class TerminalAdapter(
    private val onOpen: (ConversationTarget) -> Unit,
) : RecyclerView.Adapter<TerminalAdapter.Holder>() {
    private var project: ProjectRow? = null

    fun submit(next: ProjectRow?) {
        project = next
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_terminal, parent, false),
    )

    override fun getItemCount(): Int = project?.project?.terminals?.size ?: 0

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val row = project ?: return
        val terminal = row.project.terminals[position]
        holder.context.text = "⌁  ${row.project.name}"
        holder.title.text = terminal.agent ?: terminal.title
        holder.model.text = terminal.model ?: terminal.shell
        holder.status.text = when (terminal.status) {
            "working" -> "THINKING"
            "waiting" -> "NEEDS YOU"
            "exited" -> "CLOSED"
            else -> "READY"
        }
        holder.status.setTextColor(
            ContextCompat.getColor(
                holder.itemView.context,
                when (terminal.status) {
                    "working" -> R.color.duckweed_accent
                    "waiting" -> R.color.duckweed_attention
                    else -> R.color.duckweed_text_faint
                },
            ),
        )
        holder.shimmer.visibility = if (terminal.isWorking) View.VISIBLE else View.GONE
        holder.itemView.setOnClickListener {
            onOpen(ConversationTarget(row.pairId, row.project.id, row.project.name, terminal))
        }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val context: TextView = view.findViewById(R.id.terminal_context)
        val status: TextView = view.findViewById(R.id.terminal_status)
        val title: TextView = view.findViewById(R.id.terminal_title)
        val model: TextView = view.findViewById(R.id.terminal_model)
        val shimmer: View = view.findViewById(R.id.terminal_shimmer)
    }
}
