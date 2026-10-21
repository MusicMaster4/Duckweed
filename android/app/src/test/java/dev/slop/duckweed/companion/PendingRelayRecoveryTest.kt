package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Test

class PendingRelayRecoveryTest {
    private fun message(index: Int) = RelayClient.PendingMessage("part-$index", index.toLong())

    @Test
    fun drainsEveryPartOfALargeTransferInOneRecovery() {
        val pending = (0 until 200).map(::message).toMutableList()
        val received = mutableListOf<String>()
        var requests = 0
        PendingRelayRecovery.drain(
            fetchPage = {
                requests++
                RelayClient.PendingPage(pending.take(8), pending.size > 8)
            },
            receive = {
                received.add(it.id)
                pending.remove(it)
            },
        )
        assertEquals(200, received.distinct().size)
        assertEquals(25, requests)
        assertEquals(0, pending.size)
    }

    @Test
    fun continuesPastAFailedPayloadWithoutRetryingItInATightLoop() {
        val pending = (0 until 30).map(::message).toMutableList()
        val received = mutableListOf<String>()
        PendingRelayRecovery.drain(
            fetchPage = { RelayClient.PendingPage(pending.take(8), pending.size > 8) },
            receive = {
                received.add(it.id)
                if (it.id != "part-0") pending.remove(it)
            },
        )
        assertEquals(30, received.size)
        assertEquals(listOf(message(0)), pending)
    }

    @Test
    fun stopsWhenAcknowledgementsMakeNoProgress() {
        var requests = 0
        var receives = 0
        PendingRelayRecovery.drain(
            fetchPage = {
                requests++
                RelayClient.PendingPage((0 until 8).map(::message), true)
            },
            receive = { receives++ },
        )
        assertEquals(2, requests)
        assertEquals(8, receives)
    }

    @Test
    fun emptyQueueNeedsOnlyOneRequest() {
        var requests = 0
        PendingRelayRecovery.drain(
            fetchPage = {
                requests++
                RelayClient.PendingPage(emptyList(), false)
            },
            receive = { error("No messages expected") },
        )
        assertEquals(1, requests)
    }
}
