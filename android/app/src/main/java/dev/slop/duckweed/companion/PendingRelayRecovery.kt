package dev.slop.duckweed.companion

/** Each successful receive acknowledges its payload before the next page is fetched. */
object PendingRelayRecovery {
    fun drain(fetchPage: () -> RelayClient.PendingPage, receive: (RelayClient.PendingMessage) -> Unit) {
        val attempted = mutableSetOf<Pair<String, Long>>()
        while (true) {
            val page = fetchPage()
            val unseen = page.messages.filter { attempted.add(it.id to it.sentAt) }
            // Failed receives stay on the relay for WorkManager to retry. Stop if
            // they fill the page, rather than spinning on the same payloads.
            if (unseen.isEmpty()) return
            unseen.forEach(receive)
            if (!page.hasMore) return
        }
    }
}
