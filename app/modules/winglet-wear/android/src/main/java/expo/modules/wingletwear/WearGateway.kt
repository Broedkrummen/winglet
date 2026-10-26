package expo.modules.wingletwear
import com.google.crypto.tink.subtle.Ed25519Verify
import dev.winglet.wear.WearCrypto
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

internal object WearGateway {
  private fun http(url:String,body:JSONObject?=null):JSONObject {
    val connection=URL(url).openConnection() as HttpURLConnection
    connection.connectTimeout=5000;connection.readTimeout=5000;connection.instanceFollowRedirects=false
    connection.setRequestProperty("Accept","application/json")
    try{
      if(body!=null){connection.requestMethod="POST";connection.doOutput=true;connection.setRequestProperty("Content-Type","application/json")
        connection.outputStream.use{it.write(body.toString().toByteArray(Charsets.UTF_8))}}
      check(connection.responseCode in 200..299)
      val bytes=connection.inputStream.use{it.readNBytes(36001)};require(bytes.size<=36000)
      return JSONObject(bytes.toString(Charsets.UTF_8))
    }finally{connection.disconnect()}
  }
  fun request(link:JSONObject,op:String,data:JSONObject):JSONObject {
    val base=link.getString("url").trimEnd('/')
    val info=http(base+"/api/server-key")
    require(info.get("v")==1 && info.getString("identity")==link.getString("identity"))
    val identity=WearCrypto.raw(link.getString("identity"));require(identity.size==32)
    val sealing=WearCrypto.raw(info.getString("sealing"));require(sealing.size==32)
    Ed25519Verify(identity).verify(WearCrypto.raw(info.getString("sealing_sig")),"winglet-sealing-key-v1".toByteArray()+sealing)
    val responseKey=WearCrypto.bytes(32);val nonce=WearCrypto.id();val device=link.getString("device")
    val value=JSONObject().put("v",1).put("token",link.getString("token")).put("op",op).put("data",data)
      .put("issued",System.currentTimeMillis()/1000).put("nonce",nonce).put("response_key",WearCrypto.b64(responseKey))
    try{
      val envelope=http(base+"/api/wear/relay",JSONObject().put("device_id",device)
        .put("sealed",WearCrypto.seal(sealing,"wear-relay",device,value.toString().toByteArray(Charsets.UTF_8))))
      require(envelope.get("v")==1)
      val plain=WearCrypto.decrypt(responseKey,WearCrypto.raw(envelope.getString("nonce")),WearCrypto.raw(envelope.getString("ct")),
        WearCrypto.responseAad(link.getString("gatewayId"),device,nonce))
      return JSONObject(plain.toString(Charsets.UTF_8))
    }finally{responseKey.fill(0)}
  }
}
