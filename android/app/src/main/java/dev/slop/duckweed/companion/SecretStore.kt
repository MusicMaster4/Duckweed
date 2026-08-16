package dev.slop.duckweed.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object SecretStore {
    private const val ALIAS = "duckweed-companion-pairing"
    private const val PREFERENCES = "duckweed-secure-pairing"
    private const val VALUE = "credentials"

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    fun save(context: Context, credentials: PairCredentials) {
        val plain = JSONObject()
            .put("pairId", credentials.pairId)
            .put("relayUrl", credentials.relayUrl)
            .put("masterKey", credentials.masterKey)
            .put("receiveToken", credentials.receiveToken)
            .put("deviceId", credentials.deviceId)
            .put("deviceName", credentials.deviceName)
            .toString()
            .toByteArray(Charsets.UTF_8)
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .edit()
            .putString(VALUE, encryptLocal(plain))
            .apply()
    }

    fun load(context: Context): PairCredentials? = runCatching {
        val stored = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            .getString(VALUE, null) ?: return null
        val json = JSONObject(String(decryptLocal(stored), Charsets.UTF_8))
        PairCredentials(
            pairId = json.getString("pairId"),
            relayUrl = json.getString("relayUrl"),
            masterKey = json.getString("masterKey"),
            receiveToken = json.getString("receiveToken"),
            deviceId = json.getString("deviceId"),
            deviceName = json.getString("deviceName"),
        )
    }.getOrNull()

    fun clear(context: Context) {
        context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().clear().apply()
    }

    fun encryptLocal(plain: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return JSONObject()
            .put("nonce", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(plain), Base64.NO_WRAP))
            .toString()
    }

    fun decryptLocal(stored: String): ByteArray {
        val wrapper = JSONObject(stored)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            key(),
            GCMParameterSpec(128, Base64.decode(wrapper.getString("nonce"), Base64.NO_WRAP)),
        )
        return cipher.doFinal(Base64.decode(wrapper.getString("ciphertext"), Base64.NO_WRAP))
    }
}
