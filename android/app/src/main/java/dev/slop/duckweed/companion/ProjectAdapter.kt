package dev.slop.duckweed.companion

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView

data class ProjectRow(val pairId: String, val project: RemoteProject)

class ProjectAdapter(
    private val onOpen: (ProjectRow) -> Unit,
) : RecyclerView.Adapter<ProjectAdapter.Holder>() {
    private var projects: List<ProjectRow> = emptyList()

    fun submit(next: List<ProjectRow>) {
        projects = next
        notifyDataSetChanged()
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_project, parent, false),
    )

    override fun getItemCount(): Int = projects.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val row = projects[position]
        val project = row.project
        val working = project.terminals.count(RemoteTerminal::isWorking)
        holder.name.text = project.name
        holder.meta.text = buildList {
            add("${project.terminals.size} terminal${if (project.terminals.size == 1) "" else "s"}")
            project.branch?.let { add(it) }
        }.joinToString("  •  ")
        holder.status.text = if (working > 0) "$working working" else "Open  ›"
        holder.shimmer.visibility = if (working > 0) View.VISIBLE else View.GONE
        holder.itemView.setOnClickListener { onOpen(row) }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val name: TextView = view.findViewById(R.id.project_name)
        val meta: TextView = view.findViewById(R.id.project_meta)
        val status: TextView = view.findViewById(R.id.project_status)
        val shimmer: View = view.findViewById(R.id.project_shimmer)
    }
}
