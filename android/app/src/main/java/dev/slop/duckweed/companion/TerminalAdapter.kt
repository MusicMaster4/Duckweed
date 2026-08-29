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
    private val onClose: ((ConversationTarget) -> Unit)? = null,
    private val onPending: (() -> Unit)? = null,
) : RecyclerView.Adapter<TerminalAdapter.Holder>() {
    private var targets: List<ConversationTarget> = emptyList()

    fun submit(
        next: ProjectRow?,
        unreadKeys: Set<Pair<String, String>> = emptySet(),
    ) {
        submitTargets(next?.let { row ->
            row.project.terminals.map { terminal ->
                ConversationTarget(
                    row.pairId,
                    row.project.id,
                    row.project.name,
                    row.project.color,
                    terminal,
                    Pair(row.pairId, terminal.id) in unreadKeys,
                    row.desktopOnline,
                )
            }
        }.orEmpty())
    }

    fun submitTargets(next: List<ConversationTarget>) {
        if (next == targets) return
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

    fun markRead(pairId: String, terminalId: String) {
        val index = targets.indexOfFirst {
            it.pairId == pairId && it.terminal.id == terminalId && it.unread
        }
        if (index < 0) return
        targets = targets.toMutableList().also { it[index] = it[index].copy(unread = false) }
        notifyItemChanged(index)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_terminal, parent, false),
    )

    override fun getItemCount(): Int = targets.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val target = targets[position]
        val terminal = target.terminal
        val pending = terminal.pendingAction
        val accent = MobileTabColorStyle.parse(target.projectColor)
        MobileTabColorStyle.apply(holder.itemView, accent, unread = target.unread)
        holder.itemView.alpha = if (pending == null) 1f else PENDING_ALPHA
        holder.context.text = "Project  ${target.projectName}"
        holder.title.text = terminal.agent ?: terminal.title
        holder.model.text = terminal.model ?: terminal.shell
        holder.status.text = if (pending != null) {
            when (pending.kind) {
                PendingMobileAction.CREATE_TERMINAL -> "OPENING..."
                PendingMobileAction.CLOSE_TERMINAL -> "CLOSING..."
                else -> "UPDATING..."
            }
        } else if (!target.desktopOnline) {
            "OFFLINE"
        } else {
            when (terminal.status) {
                "starting" -> "OPENING"
                "working" -> if (terminal.agent != null) "THINKING" else "RUNNING"
                "waiting" -> "NEEDS YOU"
                "exited" -> "CLOSED"
                else -> "READY"
            }
        }
        holder.status.setTextColor(
            ContextCompat.getColor(
                holder.itemView.context,
                if (pending != null) {
                    R.color.duckweed_text_faint
                } else if (!target.desktopOnline) {
                    R.color.duckweed_error
                } else {
                    when (terminal.status) {
                        "working" -> R.color.duckweed_accent
                        "waiting" -> R.color.duckweed_attention
                        else -> R.color.duckweed_text_faint
                    }
                },
            ),
        )
        holder.shimmer.visibility =
            if (pending == null && target.desktopOnline && terminal.status == "working" && terminal.agent != null) View.VISIBLE else View.GONE
        holder.itemView.setOnClickListener {
            if (pending == null) onOpen(target) else onPending?.invoke()
        }
        holder.itemView.setOnLongClickListener {
            if (pending == null) onClose?.invoke(target) else onPending?.invoke()
            pending != null || onClose != null
        }
        holder.itemView.contentDescription = buildString {
            if (pending != null) append("Waiting for the desktop to update. ")
            if (target.unread) append("Unread conversation. ")
            append("${terminal.agent ?: terminal.title}, ${target.projectName}")
        }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val context: TextView = view.findViewById(R.id.terminal_context)
        val status: TextView = view.findViewById(R.id.terminal_status)
        val title: TextView = view.findViewById(R.id.terminal_title)
        val model: TextView = view.findViewById(R.id.terminal_model)
        val shimmer: View = view.findViewById(R.id.terminal_shimmer)
    }

    companion object {
        private const val PENDING_ALPHA = 0.48f
    }
}
