package dev.slop.duckweed.companion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.UUID
import kotlin.math.max
import kotlin.math.roundToInt

object MobileImageTools {
    private const val MAX_SOURCE_BYTES = 12 * 1024 * 1024
    private const val MAX_PAYLOAD_BYTES = 115 * 1024
    private const val MAX_EDGE = 1_440
    private val allowedMimes = setOf("image/png", "image/jpeg", "image/gif", "image/webp")

    fun read(context: Context, uri: Uri): MobileImageAttachment {
        val reportedMime = context.contentResolver.getType(uri)
            ?.lowercase()
            ?.replace("image/jpg", "image/jpeg")
        require(reportedMime == null || reportedMime in allowedMimes) {
            "Only PNG, JPEG, GIF, and WebP images are supported."
        }
        val source = context.contentResolver.openInputStream(uri)?.use(::readBounded)
            ?: error("Could not read this image.")
        val detectedMime = reportedMime ?: mimeFromName(displayName(context, uri))
            ?: error("Could not identify this image format.")
        val (mimeType, bytes) = if (source.size <= MAX_PAYLOAD_BYTES) {
            detectedMime to source
        } else {
            "image/jpeg" to compress(source)
        }
        return MobileImageAttachment(
            id = UUID.randomUUID().toString(),
            name = displayName(context, uri).ifBlank { "mobile-image.${extensionFor(mimeType)}" },
            mimeType = mimeType,
            dataUrl = "data:$mimeType;base64,${Base64.encodeToString(bytes, Base64.NO_WRAP)}",
            size = bytes.size,
        )
    }

    fun decodePreview(attachment: MobileImageAttachment): Bitmap? {
        val encoded = attachment.dataUrl?.substringAfter("base64,", "") ?: return null
        if (encoded.isBlank()) return null
        return runCatching {
            val bytes = Base64.decode(encoded, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }

    private fun readBounded(input: java.io.InputStream): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0
        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            total += read
            require(total <= MAX_SOURCE_BYTES) { "Images must be 12 MB or smaller." }
            output.write(buffer, 0, read)
        }
        return output.toByteArray()
    }

    private fun compress(source: ByteArray): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(source, 0, source.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Could not decode this image." }
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > MAX_EDGE * 2) sample *= 2
        val decoded = BitmapFactory.decodeByteArray(
            source,
            0,
            source.size,
            BitmapFactory.Options().apply { inSampleSize = sample },
        ) ?: error("Could not decode this image.")
        var current = scaleToEdge(decoded, MAX_EDGE)
        if (current !== decoded) decoded.recycle()
        var quality = 84
        repeat(8) {
            val flattened = flattenTransparency(current)
            val output = ByteArrayOutputStream()
            flattened.compress(Bitmap.CompressFormat.JPEG, quality, output)
            if (flattened !== current) flattened.recycle()
            val bytes = output.toByteArray()
            if (bytes.size <= MAX_PAYLOAD_BYTES) {
                current.recycle()
                return bytes
            }
            quality -= 8
            if (quality < 52) {
                val resized = Bitmap.createScaledBitmap(
                    current,
                    max(1, (current.width * 0.82f).roundToInt()),
                    max(1, (current.height * 0.82f).roundToInt()),
                    true,
                )
                current.recycle()
                current = resized
                quality = 76
            }
        }
        current.recycle()
        error("This image could not be reduced enough to send securely.")
    }

    private fun scaleToEdge(bitmap: Bitmap, maxEdge: Int): Bitmap {
        val edge = max(bitmap.width, bitmap.height)
        if (edge <= maxEdge) return bitmap
        val scale = maxEdge.toFloat() / edge
        return Bitmap.createScaledBitmap(
            bitmap,
            max(1, (bitmap.width * scale).roundToInt()),
            max(1, (bitmap.height * scale).roundToInt()),
            true,
        )
    }

    private fun flattenTransparency(bitmap: Bitmap): Bitmap {
        if (!bitmap.hasAlpha()) return bitmap
        return Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888).also { result ->
            Canvas(result).apply {
                drawColor(Color.WHITE)
                drawBitmap(bitmap, 0f, 0f, null)
            }
        }
    }

    private fun displayName(context: Context, uri: Uri): String {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) return cursor.getString(0).orEmpty().take(120)
            }
        return uri.lastPathSegment.orEmpty().substringAfterLast('/').take(120)
    }

    private fun mimeFromName(name: String): String? = when (name.substringAfterLast('.', "").lowercase()) {
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        else -> null
    }

    private fun extensionFor(mimeType: String): String = when (mimeType) {
        "image/jpeg" -> "jpg"
        else -> mimeType.substringAfter('/')
    }
}
