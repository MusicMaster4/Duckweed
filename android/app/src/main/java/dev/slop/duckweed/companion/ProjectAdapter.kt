package dev.slop.duckweed.companion

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.DiffUtil
import androidx.core.content.ContextCompat

data class ProjectRow(
    val pairId: String,
    val project: RemoteProject,
    val desktopOnline: Boolean = true,
)

class ProjectAdapter(
    private val onOpen: (ProjectRow) -> Unit,
) : RecyclerView.Adapter<ProjectAdapter.Holder>() {
    private var projects: List<ProjectRow> = emptyList()
    private var marks: Map<String, String> = emptyMap()

    private fun key(row: ProjectRow): String = "${row.pairId}\u0000${row.project.id}"

    fun submit(next: List<ProjectRow>) {
        if (next == projects) return
        val previous = projects
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize(): Int = previous.size
            override fun getNewListSize(): Int = next.size
            override fun areItemsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition].pairId == next[newItemPosition].pairId &&
                    previous[oldItemPosition].project.id == next[newItemPosition].project.id
            override fun areContentsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition] == next[newItemPosition]
        })
        projects = next
        marks = ProjectMarks.assign(next.map { ProjectMarkIdentity(key(it), it.project.name) })
        diff.dispatchUpdatesTo(this)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_project, parent, false),
    )

    override fun getItemCount(): Int = projects.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val row = projects[position]
        val project = row.project
        val accent = project.color?.let { runCatching { Color.parseColor(it) }.getOrNull() }
        (holder.itemView.background?.mutate() as? GradientDrawable)?.setStroke(
            if (accent != null) 2 else 0,
            accent ?: Color.TRANSPARENT,
        )
        holder.mark.setTextColor(accent ?: ContextCompat.getColor(holder.itemView.context, R.color.duckweed_accent))
        val working = if (row.desktopOnline) project.terminals.count(RemoteTerminal::isWorking) else 0
        holder.mark.text = marks[key(row)] ?: "P0"
        holder.name.text = project.name
        holder.meta.text = buildList {
            add("${project.terminals.size} terminal${if (project.terminals.size == 1) "" else "s"}")
            project.branch?.let { add(it) }
        }.joinToString("  •  ")
        holder.status.text = when {
            !row.desktopOnline -> "Offline"
            working > 0 -> "$working working"
            else -> "Open  ›"
        }
        holder.shimmer.visibility = if (working > 0) View.VISIBLE else View.GONE
        holder.itemView.setOnClickListener { onOpen(row) }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val mark: TextView = view.findViewById(R.id.project_mark)
        val name: TextView = view.findViewById(R.id.project_name)
        val meta: TextView = view.findViewById(R.id.project_meta)
        val status: TextView = view.findViewById(R.id.project_status)
        val shimmer: View = view.findViewById(R.id.project_shimmer)
    }
}
