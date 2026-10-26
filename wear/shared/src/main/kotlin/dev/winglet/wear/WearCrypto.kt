package dev.winglet.wear

import com.google.crypto.tink.subtle.Hkdf
import com.google.crypto.tink.subtle.X25519
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object WearCrypto {
  private val random=SecureRandom()
  fun bytes(size:Int)=ByteArray(size).also{random.nextBytes(it)}
  fun b64(value:ByteArray):String=Base64.getUrlEncoder().withoutPadding().encodeToString(value)
  fun raw(value:String,limit:Int=48000):ByteArray {
    require(value.length<=limit && value.matches(Regex("^[A-Za-z0-9_-]+$")))
    return Base64.getUrlDecoder().decode(value).also{require(b64(it)==value)}
  }
  fun id()=hex(bytes(16))
  fun hex(value:ByteArray)=value.joinToString(""){(it.toInt() and 255).toString(16).padStart(2,'0')}
  fun hash(value:ByteArray)=hex(MessageDigest.getInstance("SHA-256").digest(value))
  fun frame(vararg fields:String):ByteArray {
    val out=ByteArrayOutputStream()
    DataOutputStream(out).use{stream->fields.forEach{val b=it.toByteArray(Charsets.UTF_8);require(b.size<=4096);stream.writeInt(b.size);stream.write(b)}}
    return out.toByteArray()
  }
  fun encrypt(key:ByteArray,nonce:ByteArray,plain:ByteArray,aad:ByteArray):ByteArray {
    require(key.size==32 && nonce.size==12 && plain.size<=24000)
    return Cipher.getInstance("AES/GCM/NoPadding").run{
      init(Cipher.ENCRYPT_MODE,SecretKeySpec(key,"AES"),GCMParameterSpec(128,nonce));updateAAD(aad);doFinal(plain)
    }
  }
  fun decrypt(key:ByteArray,nonce:ByteArray,ciphertext:ByteArray,aad:ByteArray):ByteArray {
    require(key.size==32 && nonce.size==12 && ciphertext.size in 16..24016)
    return Cipher.getInstance("AES/GCM/NoPadding").run{
      init(Cipher.DECRYPT_MODE,SecretKeySpec(key,"AES"),GCMParameterSpec(128,nonce));updateAAD(aad);doFinal(ciphertext)
    }
  }
  /** Existing Winglet sealed-secret protocol, implemented using maintained Tink primitives. */
  fun seal(recipient:ByteArray,purpose:String,device:String,plain:ByteArray):String {
    require(recipient.size==32)
    val private=X25519.generatePrivateKey();val public=X25519.publicFromPrivate(private)
    val shared=X25519.computeSharedSecret(private,recipient)
    val key=Hkdf.computeHkdf("HmacSha256",shared,public+recipient,"winglet-seal-v1".toByteArray(),32)
    val nonce=bytes(12)
    return try{b64(public+nonce+encrypt(key,nonce,plain,("winglet-seal-v1|"+purpose+"|"+device).toByteArray(Charsets.UTF_8)))}
      finally{private.fill(0);shared.fill(0);key.fill(0)}
  }
  fun responseAad(server:String,device:String,nonce:String,purpose:String="response")=
    frame("winglet.wear."+purpose,"1",server,device,nonce)
}

object WearPolicy {
  fun validId(id:String)=Regex("^[a-f0-9]{32}$").matches(id)
  fun fresh(issued:Long,expires:Long,now:Long):Boolean=
    issued>=0 && issued<=now+30 && expires>now && expires>=issued && expires-issued<=120 && now-issued<=120
}
