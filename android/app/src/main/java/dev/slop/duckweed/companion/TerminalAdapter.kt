package dev.slop.duckweed.companion

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.DiffUtil

class TerminalAdapter(
    private val onOpen: (ConversationTarget) -> Unit,
) : RecyclerView.Adapter<TerminalAdapter.Holder>() {
    private var targets: List<ConversationTarget> = emptyList()

    fun submit(next: ProjectRow?) {
        submitTargets(next?.let { row ->
            row.project.terminals.map { terminal ->
                ConversationTarget(row.pairId, row.project.id, row.project.name, terminal)
            }
        }.orEmpty())
    }

    fun submitTargets(next: List<ConversationTarget>) {
        val previous = targets
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize(): Int = previous.size
            override fun getNewListSize(): Int = next.size
            override fun areItemsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition].pairId == next[newItemPosition].pairId &&
                    previous[oldItemPosition].terminal.id == next[newItemPosition].terminal.id
            override fun areContentsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition] == next[newItemPosition]
        })
        targets = next
        diff.dispatchUpdatesTo(this)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_terminal, parent, false),
    )

    override fun getItemCount(): Int = targets.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val target = targets[position]
        val terminal = target.terminal
        holder.context.text = "Project  ${target.projectName}"
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
        holder.shimmer.visibility = if (terminal.status == "working") View.VISIBLE else View.GONE
        holder.itemView.setOnClickListener { onOpen(target) }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val context: TextView = view.findViewById(R.id.terminal_context)
        val status: TextView = view.findViewById(R.id.terminal_status)
        val title: TextView = view.findViewById(R.id.terminal_title)
        val model: TextView = view.findViewById(R.id.terminal_model)
        val shimmer: View = view.findViewById(R.id.terminal_shimmer)
    }
}
