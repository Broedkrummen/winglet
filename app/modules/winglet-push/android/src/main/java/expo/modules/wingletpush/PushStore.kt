package expo.modules.wingletpush

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object PushStore {
  val mutex=Any()
  private val random=SecureRandom()
  fun b64(bytes: ByteArray)=Base64.encodeToString(bytes,Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  fun unb64(text: String): ByteArray {
    require(Regex("^[A-Za-z0-9_-]+$").matches(text))
    return Base64.decode(text,Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING).also{require(b64(it)==text)}
  }
  fun hex(bytes: ByteArray)=bytes.joinToString(""){(it.toInt() and 255).toString(16).padStart(2,'0')}
  fun scope(server: String,device: String)=hex(MessageDigest.getInstance("SHA-256").digest((server+"\u0000"+device).toByteArray(Charsets.UTF_8)))
  private fun directory(context: Context)=File(context.noBackupFilesDir,"winglet-push-v1").also{it.mkdirs()}
  private fun file(context: Context,scope: String): AtomicFile {
    require(Regex("^[a-f0-9]{64}$").matches(scope))
    return AtomicFile(File(directory(context),scope+".json"))
  }
  fun scopes(context: Context)=directory(context).listFiles().orEmpty().filter{it.name.matches(Regex("^[a-f0-9]{64}\\.json$"))}.take(32).map{it.name.removeSuffix(".json")}
  private fun key(scope: String,create: Boolean=false): SecretKey {
    val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)}
    val alias="winglet.push."+scope
    val existing=store.getKey(alias,null)
    if(existing!=null)return existing as SecretKey
    check(create){"Notification key was lost. Rotate encrypted push on this device."}
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{
      init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
    }.generateKey()
  }
  fun read(context: Context,scope: String): JSONObject? {
    val target=file(context,scope)
    if(!target.baseFile.exists())return null
    require(target.baseFile.length()<=2_500_000)
    val record=JSONObject(target.openRead().use{it.readBytes().toString(Charsets.UTF_8)})
    val cipher=Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE,key(scope),GCMParameterSpec(128,unb64(record.getString("iv"))))
    cipher.updateAAD(scope.toByteArray(Charsets.UTF_8))
    return JSONObject(cipher.doFinal(unb64(record.getString("ct"))).toString(Charsets.UTF_8))
  }
  fun write(context: Context,scope: String,value: JSONObject,create: Boolean=false) {
    val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(scope,create))
    cipher.updateAAD(scope.toByteArray(Charsets.UTF_8))
    val plain=value.toString().toByteArray(Charsets.UTF_8);require(plain.size<=1_800_000)
    val payload=JSONObject().put("iv",b64(cipher.iv)).put("ct",b64(cipher.doFinal(plain))).toString().toByteArray(Charsets.UTF_8)
    val target=file(context,scope);val stream=target.startWrite()
    try{stream.write(payload);target.finishWrite(stream)}catch(e:Exception){target.failWrite(stream);throw e}
  }
  fun prepare(context: Context,server: String,device: String,rotate: Boolean): Pair<String,JSONObject> {
    require(server.isNotBlank() && device.isNotBlank() && server.length<=160 && device.length<=160 && !server.contains('\u0000') && !device.contains('\u0000'))
    val scope=scope(server,device)
    val current=try{read(context,scope)}catch(e:Exception){if(!rotate)throw e else null}
    if(current!=null && !rotate)return scope to current
    check(scope in scopes(context) || scopes(context).size<32){"Too many push pairings. Remove an old pairing first."}
    val bytes=ByteArray(32).also{random.nextBytes(it)}
    val fresh=JSONObject().put("v",1).put("server",server).put("device",device)
      .put("kid",hex(ByteArray(16).also{random.nextBytes(it)})).put("key",b64(bytes))
      .put("active",false).put("previews",current?.optBoolean("previews",false) ?: false).put("seen",JSONObject())
    bytes.fill(0);write(context,scope,fresh,true)
    return scope to fresh
  }
  fun delete(context: Context,scope: String) {
    file(context,scope).delete()
    KeyStore.getInstance("AndroidKeyStore").apply{load(null);deleteEntry("winglet.push."+scope)}
  }
  fun mark(value: JSONObject,stage: String){value.put(stage,System.currentTimeMillis()/1000)}
}
