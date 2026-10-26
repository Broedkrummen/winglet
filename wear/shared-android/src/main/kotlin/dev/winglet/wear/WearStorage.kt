package dev.winglet.wear

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

object WearStorage {
  val mutex=Any()
  private fun file(context:Context,name:String):AtomicFile {
    require(name.matches(Regex("^[a-z0-9_-]{1,40}$")))
    val dir=File(context.noBackupFilesDir,"winglet-wear-v1").also{it.mkdirs()}
    return AtomicFile(File(dir,name+".json"))
  }
  private fun key(name:String,create:Boolean=false):SecretKey {
    val store=KeyStore.getInstance("AndroidKeyStore").apply{load(null)};val alias="winglet.wear."+name
    val existing=store.getKey(alias,null)
    if(existing!=null)return existing as SecretKey
    check(create){"Watch key unavailable. Reset the local link and pair again."}
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore").apply{
      init(KeyGenParameterSpec.Builder(alias,KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  fun read(context:Context,name:String):JSONObject {
    val target=file(context,name)
    if(!target.baseFile.exists())return JSONObject()
    require(target.baseFile.length()<=1_500_000)
    val envelope=JSONObject(target.openRead().use{it.readBytes().toString(Charsets.UTF_8)})
    val cipher=Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE,key(name),GCMParameterSpec(128,WearCrypto.raw(envelope.getString("n"))))
    cipher.updateAAD(name.toByteArray());return JSONObject(cipher.doFinal(WearCrypto.raw(envelope.getString("ct"),2_000_000)).toString(Charsets.UTF_8))
  }
  fun write(context:Context,name:String,value:JSONObject){
    val plain=value.toString().toByteArray(Charsets.UTF_8);require(plain.size<=1_000_000)
    val cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(name,true));cipher.updateAAD(name.toByteArray())
    val bytes=JSONObject().put("n",WearCrypto.b64(cipher.iv)).put("ct",WearCrypto.b64(cipher.doFinal(plain))).toString().toByteArray()
    val target=file(context,name);val stream=target.startWrite()
    try{stream.write(bytes);target.finishWrite(stream)}catch(e:Exception){target.failWrite(stream);throw e}
  }
  fun reset(context:Context,name:String){file(context,name).delete();KeyStore.getInstance("AndroidKeyStore").apply{load(null);deleteEntry("winglet.wear."+name)}}
}
