package dev.slop.duckweed.companion

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.AsyncListDiffer
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView

class PromptTemplateAdapter(private val onView: (RemotePromptTemplate) -> Unit,
    private val onCopy: (RemotePromptTemplate) -> Unit) : RecyclerView.Adapter<PromptTemplateAdapter.Holder>() {
    private val differ = AsyncListDiffer(this, object : DiffUtil.ItemCallback<PromptTemplateRow>() {
        override fun areItemsTheSame(old: PromptTemplateRow, new: PromptTemplateRow) = old.pairId == new.pairId && old.template.id == new.template.id
        override fun areContentsTheSame(old: PromptTemplateRow, new: PromptTemplateRow) = old == new
    })
    private var submitted: List<PromptTemplateRow> = emptyList()
    fun submit(rows: List<PromptTemplateRow>) {
        if (rows == submitted) return
        submitted = rows
        differ.submitList(rows)
    }
    override fun getItemCount() = differ.currentList.size
    override fun onCreateViewHolder(parent: ViewGroup, type: Int) = Holder(
        LayoutInflater.from(parent.context).inflate(R.layout.item_prompt_template, parent, false))
    override fun onBindViewHolder(holder: Holder, position: Int) {
        val template = differ.currentList[position].template
        holder.title.text = template.title
        holder.preview.text = template.content
        holder.view.contentDescription = "View ${template.title}"
        holder.copy.contentDescription = "Copy ${template.title}"
        holder.view.setOnClickListener { onView(template) }
        holder.copy.setOnClickListener { onCopy(template) }
    }
    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val title: TextView = view.findViewById(R.id.prompt_title)
        val preview: TextView = view.findViewById(R.id.prompt_preview)
        val view: View = view.findViewById(R.id.prompt_view)
        val copy: View = view.findViewById(R.id.prompt_copy)
    }
}
