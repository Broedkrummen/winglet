package expo.modules.wingletpush
import org.junit.Assert.*
import org.junit.Test
class PushCipherTest {
  private fun hex(value: String)=value.chunked(2).map{it.toInt(16).toByte()}.toByteArray()
  private val key=ByteArray(32){it.toByte()}
  private val nonce=ByteArray(12){it.toByte()}
  private val kid="a".repeat(32)
  private val ciphertext=hex("3c20b474a19ce021af11e5e2c7880c08a3a2e247845bafe3b4d6c7f81ebf7c3aeae7df523583f5d5b10ae52d")
  @Test fun opensIndependentPythonAesGcmVectorWithIdenticalUtf8Framing(){
    val value=PushCipher.open(key,"server","phone",kid,nonce,ciphertext).toString(Charsets.UTF_8)
    assertEquals("{\"body\":\"Private test 🌱\"}",value)
  }
  @Test fun wrongServerDeviceKeyNonceCiphertextAndKeyIdFailAuthentication(){
    fun refused(work:()->Unit){try{work();fail("Forged envelope accepted")}catch(expected:java.security.GeneralSecurityException){}}
    refused{PushCipher.open(key,"other","phone",kid,nonce,ciphertext)}
    refused{PushCipher.open(key,"server","other",kid,nonce,ciphertext)}
    refused{PushCipher.open(key,"server","phone","b".repeat(32),nonce,ciphertext)}
    refused{PushCipher.open(ByteArray(32){99},"server","phone",kid,nonce,ciphertext)}
    refused{PushCipher.open(key,"server","phone",kid,nonce.copyOf().also{it[0]=99},ciphertext)}
    refused{PushCipher.open(key,"server","phone",kid,nonce,ciphertext.copyOf().also{it[0]=99})}
  }
}
