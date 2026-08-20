package dev.slop.duckweed.companion

import android.graphics.Typeface
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.format.DateUtils
import android.text.style.ForegroundColorSpan
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
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
    }

    private inner class ActivityHolder(view: View) : RecyclerView.ViewHolder(view) {
        private val card: LinearLayout = view.findViewById(R.id.activity_card)
        private val kind: TextView = view.findViewById(R.id.activity_kind)
        private val status: TextView = view.findViewById(R.id.activity_status)
        private val title: TextView = view.findViewById(R.id.activity_title)
        private val detail: TextView = view.findViewById(R.id.activity_detail)
        private val command: TextView = view.findViewById(R.id.activity_command)
        private val changes: LinearLayout = view.findViewById(R.id.activity_changes)
        private val time: TextView = view.findViewById(R.id.activity_time)
        private val expand: TextView = view.findViewById(R.id.activity_expand)

        fun bind(activity: RemoteAgentActivity, expanded: Boolean) {
            kind.text = when (activity.kind) {
                "thinking" -> "THINKING"
                "plan" -> "PLAN"
                else -> "TOOL CALL"
            }
            status.text = when (activity.status) {
                "running" -> "In progress"
                "pending" -> "Pending"
                "error" -> "Failed"
                else -> "Completed"
            }
            status.setTextColor(
                ContextCompat.getColor(
                    itemView.context,
                    when (activity.status) {
                        "running" -> R.color.duckweed_accent
                        "error" -> R.color.duckweed_error
                        else -> R.color.duckweed_text_faint
                    },
                ),
            )
            title.text = activity.title
            bindOptionalText(detail, activity.detail, if (expanded) Int.MAX_VALUE else 4)
            bindOptionalText(command, activity.command, if (expanded) Int.MAX_VALUE else 4)
            bindChanges(activity.changes, expanded)
            time.text = relativeTime(activity.at)

            val expandable = activity.detail.orEmpty().lineSequence().count() > 4 ||
                activity.command.orEmpty().lineSequence().count() > 4 ||
                activity.changes.any { it.diff.orEmpty().lineSequence().count() > COLLAPSED_DIFF_LINES }
            expand.visibility = if (expandable) View.VISIBLE else View.GONE
            expand.text = if (expanded) "Show less" else "Show more"
            card.isClickable = expandable
            card.isFocusable = expandable
            card.setOnClickListener(if (expandable) View.OnClickListener {
                val position = bindingAdapterPosition
                val rowId = rows.getOrNull(position)?.id ?: return@OnClickListener
                if (!expandedActivity.add(rowId)) expandedActivity.remove(rowId)
                notifyItemChanged(position)
            } else null)
            card.contentDescription = buildString {
                append(kind.text).append(". ").append(status.text).append(". ").append(activity.title)
                if (expandable) append(if (expanded) ". Expanded" else ". Collapsed. Double tap to expand")
            }
        }

        private fun bindOptionalText(view: TextView, value: String?, maxLines: Int) {
            view.visibility = if (value.isNullOrBlank()) View.GONE else View.VISIBLE
            view.text = value
            view.maxLines = maxLines
        }

        private fun bindChanges(fileChanges: List<RemoteFileChange>, expanded: Boolean) {
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
                        text = styledDiff(change.diff, expanded)
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

        private fun styledDiff(value: String, expanded: Boolean): SpannableStringBuilder {
            val clean = value.lineSequence()
                .filterNot { it.startsWith("diff ") || it.startsWith("---") || it.startsWith("+++") }
                .toList()
            val limit = if (expanded) EXPANDED_DIFF_LINES else COLLAPSED_DIFF_LINES
            val visible = clean.take(limit)
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
                copy.append("\n… ${clean.size - visible.size} more lines")
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
        private const val COLLAPSED_DIFF_LINES = 12
        private const val EXPANDED_DIFF_LINES = 80
    }
}
