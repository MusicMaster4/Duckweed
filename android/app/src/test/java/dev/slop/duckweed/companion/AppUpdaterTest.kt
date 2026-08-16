package dev.slop.duckweed.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdaterTest {
    private val json = """
        {
          "channel": "testing",
          "versionName": "1.2.3-testing.4",
          "versionCode": 42,
          "apkUrl": "https://github.com/MusicMaster4/Duckweed/releases/download/v1.2.3-testing.4/duckweed-companion-beta.apk",
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
    """.trimIndent()

    @Test
    fun parsesAChannelBoundManifest() {
        val manifest = AndroidUpdateManifest.fromJson(json)
        assertEquals("testing", manifest.channel)
        assertEquals("1.2.3-testing.4", manifest.versionName)
        assertTrue(manifest.isNewerThan(41))
        assertFalse(manifest.isNewerThan(42))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsDownloadsOutsideGitHub() {
        AndroidUpdateManifest.fromJson(json.replace("https://github.com", "https://example.com"))
    }
}
