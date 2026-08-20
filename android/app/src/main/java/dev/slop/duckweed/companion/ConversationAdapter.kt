package dev.slop.duckweed.companion

import android.content.res.ColorStateList
import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.format.DateUtils
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.RecyclerView
import io.noties.markwon.Markwon

class ConversationAdapter(
    private val onRetry: (CompletionRecord) -> Unit,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
    private var rows: List<ConversationTimelineItem> = emptyList()
    private var markdown: Markwon? = null
    private val expandedActivity = mutableSetOf<String>()

    fun submit(next: List<ConversationTimelineItem>) {
        if (next == rows) return
        val previous = rows
        val diff = DiffUtil.calculateDiff(object : DiffUtil.Callback() {
            override fun getOldListSize(): Int = previous.size
            override fun getNewListSize(): Int = next.size
            override fun areItemsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition].id == next[newItemPosition].id
            override fun areContentsTheSame(oldItemPosition: Int, newItemPosition: Int): Boolean =
                previous[oldItemPosition] == next[newItemPosition]
        })
        rows = next
        expandedActivity.retainAll(next.mapTo(mutableSetOf()) { it.id })
        diff.dispatchUpdatesTo(this)
    }

    override fun getItemViewType(position: Int): Int = when (rows[position]) {
        is ConversationTimelineItem.Message -> VIEW_MESSAGE
        is ConversationTimelineItem.Activity -> VIEW_ACTIVITY
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
        val inflater = LayoutInflater.from(parent.context)
        return if (viewType == VIEW_MESSAGE) {
            val renderer = markdown ?: Markwon.create(parent.context).also { markdown = it }
            MessageHolder(inflater.inflate(R.layout.item_conversation_message, parent, false), renderer)
        } else {
            ActivityHolder(inflater.inflate(R.layout.item_conversation_activity, parent, false))
        }
    }

    override fun getItemCount(): Int = rows.size

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val row = rows[position]) {
            is ConversationTimelineItem.Message -> (holder as MessageHolder).bind(row.record)
            is ConversationTimelineItem.Activity -> (holder as ActivityHolder).bind(
                row.record,
                row.id in expandedActivity,
            )
        }
    }

    private inner class MessageHolder(view: View, val markdown: Markwon) : RecyclerView.ViewHolder(view) {
        private val row: LinearLayout = view.findViewById(R.id.conversation_row)
        private val bubble: LinearLayout = view.findViewById(R.id.conversation_bubble)
        private val author: TextView = view.findViewById(R.id.conversation_author)
        private val text: TextView = view.findViewById(R.id.conversation_text)
        private val attachment: TextView = view.findViewById(R.id.conversation_attachment)
        private val time: TextView = view.findViewById(R.id.conversation_time)
        private val delivery: TextView = view.findViewById(R.id.conversation_delivery)

        fun bind(message: CompletionRecord) {
            val outgoing = message.kind == "user"
            row.gravity = if (outgoing) Gravity.END else Gravity.START
            bubble.setBackgroundResource(if (outgoing) R.drawable.bubble_user else R.drawable.bubble_agent)
            (bubble.layoutParams as LinearLayout.LayoutParams).apply {
                width = if (outgoing) {
                    LinearLayout.LayoutParams.WRAP_CONTENT
                } else {
                    LinearLayout.LayoutParams.MATCH_PARENT
                }
                marginStart = if (outgoing) dp(48) else 0
                marginEnd = 0
                bubble.layoutParams = this
            }
            author.text = when {
                outgoing -> "YOU"
                message.streaming -> "${message.agent.uppercase()}  ·  WRITING"
                else -> message.agent.uppercase()
            }
            author.setTextColor(
                ContextCompat.getColor(
                    itemView.context,
                    if (outgoing) R.color.duckweed_text_dim else R.color.duckweed_accent,
                ),
            )
            markdown.setMarkdown(
                text,
                message.response
                    ?: "This terminal session did not expose a structured final response.",
            )
            val messageAttachment = message.attachments.firstOrNull()
            text.visibility = if (message.response.isNullOrBlank() && messageAttachment != null) View.GONE else View.VISIBLE
            attachment.visibility = if (messageAttachment == null) View.GONE else View.VISIBLE
            attachment.text = messageAttachment?.name
            time.text = relativeTime(message.sentAt)
            val deliveryState = if (outgoing) message.deliveryState else null
            delivery.visibility = if (deliveryState == null) View.GONE else View.VISIBLE
            delivery.text = when (deliveryState) {
                "sending" -> "Sending securely..."
                "sent" -> "Sent securely"
                "delivered" -> "Received by desktop"
                "failed" -> "Not sent. Tap to retry"
                else -> deliveryState
            }
            delivery.setTextColor(
                ContextCompat.getColor(
                    itemView.context,
                    if (deliveryState == "failed") R.color.duckweed_error else R.color.duckweed_text_faint,
                ),
            )
            val retryable = outgoing && deliveryState == "failed"
            bubble.isClickable = retryable
            bubble.isFocusable = retryable
            bubble.contentDescription = if (retryable) {
                "Message not sent. Double tap to retry."
            } else {
                null
            }
            bubble.setOnClickListener(if (retryable) View.OnClickListener { onRetry(message) } else null)
        }

        private fun dp(value: Int): Int =
            (value * itemView.resources.displayMetrics.density).toInt()
    }

    private inner class ActivityHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val container: LinearLayout = view.findViewById(R.id.activity_container)
        private val row: View = view.findViewById(R.id.activity_row)
        private val icon: ImageView = view.findViewById(R.id.activity_icon)
        private val title: TextView = view.findViewById(R.id.activity_title)
        private val status: TextView = view.findViewById(R.id.activity_status)
        private val expand: ImageView = view.findViewById(R.id.activity_expand)
        private val details: LinearLayout = view.findViewById(R.id.activity_details)
        private val detail: TextView = view.findViewById(R.id.activity_detail)
        private val command: TextView = view.findViewById(R.id.activity_command)
        private val changes: LinearLayout = view.findViewById(R.id.activity_changes)
        private val time: TextView = view.findViewById(R.id.activity_time)

        fun bind(activity: RemoteAgentActivity, expanded: Boolean) {
            val reasoning = activity.kind == "thinking"
            val hasDiff = activity.changes.isNotEmpty()
            icon.setImageResource(
                when {
                    reasoning -> R.drawable.ic_reasoning_activity
                    hasDiff -> R.drawable.ic_diff_activity
                    else -> R.drawable.ic_tool_activity
                },
            )
            val tint = ContextCompat.getColor(
                itemView.context,
                when (activity.status) {
                    "running" -> R.color.duckweed_accent
                    "error" -> R.color.duckweed_error
                    else -> R.color.duckweed_text_faint
                },
            )
            icon.imageTintList = ColorStateList.valueOf(tint)
            title.text = if (reasoning) "Reasoning..." else activity.title
            status.text = when (activity.status) {
                "running" -> "Running"
                "pending" -> "Queued"
                "error" -> "Failed"
                else -> ""
            }
            status.visibility = if (status.text.isEmpty()) View.GONE else View.VISIBLE
            status.setTextColor(tint)

            val expandable = if (reasoning) {
                !activity.detail.isNullOrBlank()
            } else {
                !activity.detail.isNullOrBlank() || !activity.command.isNullOrBlank() || hasDiff
            }
            details.visibility = if (expanded && expandable) View.VISIBLE else View.GONE
            bindOptionalText(detail, activity.detail)
            bindOptionalText(command, activity.command)
            if (expanded) {
                bindChanges(activity.changes)
            } else {
                changes.removeAllViews()
                changes.visibility = View.GONE
            }
            time.text = relativeTime(activity.at)
            expand.visibility = if (expandable) View.VISIBLE else View.INVISIBLE
            expand.rotation = if (expanded) 90f else 0f
            row.isClickable = expandable
            row.isFocusable = expandable
            row.setOnClickListener(if (expandable) View.OnClickListener {
                val position = bindingAdapterPosition
                val rowId = rows.getOrNull(position)?.id ?: return@OnClickListener
                if (!expandedActivity.add(rowId)) expandedActivity.remove(rowId)
                notifyItemChanged(position)
            } else null)
            container.contentDescription = buildString {
                append(if (reasoning) "Reasoning" else "Tool. ${activity.title}")
                if (status.text.isNotEmpty()) append(". ").append(status.text)
                if (expandable) append(if (expanded) ". Expanded" else ". Collapsed. Double tap to expand")
            }
        }

        private fun bindOptionalText(view: TextView, value: String?) {
            view.visibility = if (value.isNullOrBlank()) View.GONE else View.VISIBLE
            view.text = value
        }

        private fun bindChanges(fileChanges: List<RemoteFileChange>) {
            changes.removeAllViews()
            changes.visibility = if (fileChanges.isEmpty()) View.GONE else View.VISIBLE
            fileChanges.forEach { change ->
                val block = LinearLayout(itemView.context).apply {
                    orientation = LinearLayout.VERTICAL
                    setBackgroundResource(R.drawable.diff_surface)
                    setPadding(dp(10), dp(8), dp(10), dp(9))
                }
                block.addView(TextView(itemView.context).apply {
                    text = fileHeading(change)
                    textSize = 11f
                    maxLines = 2
                    setTextColor(ContextCompat.getColor(context, R.color.duckweed_text_dim))
                    setTypeface(typeface, Typeface.BOLD)
                })
                if (!change.diff.isNullOrBlank()) {
                    block.addView(TextView(itemView.context).apply {
                        text = styledDiff(change.diff)
                        textSize = 10f
                        typeface = Typeface.MONOSPACE
                        setLineSpacing(0f, 1.08f)
                        setTextColor(ContextCompat.getColor(context, R.color.duckweed_text_dim))
                        setTextIsSelectable(true)
                    }, LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(7) })
                }
                changes.addView(
                    block,
                    LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = dp(7) },
                )
            }
        }

        private fun fileHeading(change: RemoteFileChange): SpannableStringBuilder {
            val copy = SpannableStringBuilder(change.path)
            if (change.insertions > 0) appendColored(copy, "  +${change.insertions}", R.color.duckweed_accent)
            if (change.deletions > 0) appendColored(copy, "  -${change.deletions}", R.color.duckweed_error)
            return copy
        }

        private fun styledDiff(value: String): SpannableStringBuilder {
            val clean = value.lineSequence()
                .filterNot { it.startsWith("diff ") || it.startsWith("---") || it.startsWith("+++") }
                .toList()
            val visible = clean.take(EXPANDED_DIFF_LINES)
            val copy = SpannableStringBuilder()
            visible.forEachIndexed { index, line ->
                if (index > 0) copy.append('\n')
                val start = copy.length
                copy.append(line.ifEmpty { " " })
                val color = when {
                    line.startsWith("+") -> R.color.duckweed_accent
                    line.startsWith("-") -> R.color.duckweed_error
                    line.startsWith("@@") -> R.color.duckweed_attention
                    else -> R.color.duckweed_text_dim
                }
                copy.setSpan(
                    ForegroundColorSpan(ContextCompat.getColor(itemView.context, color)),
                    start,
                    copy.length,
                    Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
                )
            }
            if (clean.size > visible.size) {
                copy.append("\n... ${clean.size - visible.size} more lines")
            }
            return copy
        }

        private fun appendColored(copy: SpannableStringBuilder, value: String, color: Int) {
            val start = copy.length
            copy.append(value)
            copy.setSpan(
                ForegroundColorSpan(ContextCompat.getColor(itemView.context, color)),
                start,
                copy.length,
                Spannable.SPAN_EXCLUSIVE_EXCLUSIVE,
            )
        }

        private fun dp(value: Int): Int =
            (value * itemView.resources.displayMetrics.density).toInt()
    }

    private fun relativeTime(at: Long): CharSequence = DateUtils.getRelativeTimeSpanString(
        at,
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
    )

    companion object {
        private const val VIEW_MESSAGE = 0
        private const val VIEW_ACTIVITY = 1
        private const val EXPANDED_DIFF_LINES = 80
    }
}
