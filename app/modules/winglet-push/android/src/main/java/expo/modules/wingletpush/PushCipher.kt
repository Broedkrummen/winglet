package expo.modules.wingletpush

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Protocol framing only; cryptographic operations use the platform AES-GCM implementation. */
internal object PushCipher {
  fun aad(server: String, device: String, kid: String): ByteArray {
    val out=ByteArrayOutputStream()
    DataOutputStream(out).use { stream ->
      listOf("winglet.push","1",server,device,kid,"notification").forEach {
        val bytes=it.toByteArray(Charsets.UTF_8);stream.writeInt(bytes.size);stream.write(bytes)
      }
    }
    return out.toByteArray()
  }
  fun open(key: ByteArray, server: String, device: String, kid: String, nonce: ByteArray, ciphertext: ByteArray): ByteArray {
    require(key.size==32 && nonce.size==12 && ciphertext.size in 16..2216)
    require(Regex("^[a-f0-9]{32}$").matches(kid))
    val cipher=Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE,SecretKeySpec(key,"AES"),GCMParameterSpec(128,nonce))
    cipher.updateAAD(aad(server,device,kid))
    return cipher.doFinal(ciphertext)
  }
}

/** Persist snapshot BEFORE showing a notification. Refuse overflow rather than forget live IDs. */
internal class PushGuard(private val now: () -> Long, remembered: Map<String,Long> = emptyMap(), private val capacity: Int=16384) {
  private val seen=remembered.toMutableMap()
  fun accept(id: String, issued: Long, expires: Long): Boolean {
    val stamp=now()
    seen.entries.removeAll{it.value<stamp}
    if(!Regex("^[a-f0-9]{32}$").matches(id) || issued<0 || issued>stamp+60 || expires<=stamp ||
      expires<issued || expires-issued>86400 || stamp-issued>86400 || seen.containsKey(id) || seen.size>=capacity)return false
    seen[id]=expires;return true
  }
  fun snapshot(): Map<String,Long> = seen.toMap()
}
