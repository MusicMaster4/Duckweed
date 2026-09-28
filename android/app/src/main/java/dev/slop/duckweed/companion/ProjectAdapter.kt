package dev.slop.duckweed.companion

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.AsyncListDiffer
import androidx.core.content.ContextCompat

data class ProjectRow(
    val pairId: String,
    val project: RemoteProject,
    val desktopOnline: Boolean = true,
)

class ProjectAdapter(
    private val onOpen: (ProjectRow) -> Unit,
) : RecyclerView.Adapter<ProjectAdapter.Holder>() {
    private val differ = AsyncListDiffer(this, object : DiffUtil.ItemCallback<ProjectRow>() {
        override fun areItemsTheSame(old: ProjectRow, new: ProjectRow) = old.pairId == new.pairId && old.project.id == new.project.id
        override fun areContentsTheSame(old: ProjectRow, new: ProjectRow) = old == new
    })
    private val projects: List<ProjectRow> get() = differ.currentList
    private var submitted: List<ProjectRow> = emptyList()
    private var marks: Map<String, String> = emptyMap()

    private fun key(row: ProjectRow): String = "${row.pairId}\u0000${row.project.id}"

    fun submit(next: List<ProjectRow>) {
        if (next == submitted) return
        submitted = next
        marks = ProjectMarks.assign(next.map { ProjectMarkIdentity(key(it), it.project.name) })
        differ.submitList(next)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_project, parent, false),
    )

    override fun getItemCount(): Int = projects.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val row = projects[position]
        val project = row.project
        val accent = MobileTabColorStyle.parse(project.color)
        MobileTabColorStyle.apply(holder.itemView, accent)
        holder.mark.background = android.graphics.drawable.GradientDrawable().apply {
            cornerRadius = 10f * holder.itemView.resources.displayMetrics.density
            setColor(0x24000000)
        }
        holder.mark.setTextColor(accent ?: ContextCompat.getColor(holder.itemView.context, R.color.duckweed_accent))
        val working = if (row.desktopOnline) project.terminals.count(RemoteTerminal::isWorking) else 0
        val waiting = project.terminals.count { it.permission != null || it.status == "waiting" }
        holder.mark.text = marks[key(row)] ?: "P0"
        holder.name.text = project.name
        holder.meta.text = buildList {
            add("${project.terminals.size} terminal${if (project.terminals.size == 1) "" else "s"}")
            project.branch?.let { add(it) }
        }.joinToString("  •  ")
        holder.status.text = when {
            !row.desktopOnline -> "Offline"
            waiting > 0 -> "Needs you"
            working > 0 -> "$working working"
            else -> "Open  ›"
        }
        holder.status.setTextColor(ContextCompat.getColor(holder.itemView.context,
            if (!row.desktopOnline) R.color.duckweed_text_faint
            else if (waiting > 0) R.color.duckweed_attention
            else if (working > 0) R.color.duckweed_accent else R.color.duckweed_text_dim))
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
