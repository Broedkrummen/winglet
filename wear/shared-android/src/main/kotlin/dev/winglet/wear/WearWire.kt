package dev.winglet.wear
import org.json.JSONObject

object WearWire {
  const val HELLO="/winglet/wear/v1/hello"
  const val CHALLENGE="/winglet/wear/v1/challenge"
  const val MESSAGE="/winglet/wear/v1/message"
  private fun aad(association:String,from:String,to:String,purpose:String,id:String,issued:Long,expires:Long)=
    WearCrypto.frame("winglet.wear.channel","1",association,from,to,purpose,id,issued.toString(),expires.toString())
  fun encode(link:JSONObject,from:String,to:String,purpose:String,id:String,body:JSONObject,ttl:Long=60):ByteArray {
    require(WearPolicy.validId(id));val stamp=System.currentTimeMillis()/1000;val expires=stamp+ttl
    val nonce=WearCrypto.bytes(12);val association=link.getString("association")
    val key=WearCrypto.raw(link.getString("secret"))
    val ciphertext=try{WearCrypto.encrypt(key,nonce,body.toString().toByteArray(Charsets.UTF_8),aad(association,from,to,purpose,id,stamp,expires))}finally{key.fill(0)}
    return JSONObject().put("v",1).put("association",association).put("purpose",purpose).put("id",id)
      .put("issued",stamp).put("expires",expires).put("n",WearCrypto.b64(nonce)).put("ct",WearCrypto.b64(ciphertext)).toString().toByteArray(Charsets.UTF_8)
  }
  fun decode(link:JSONObject,from:String,to:String,purpose:String,bytes:ByteArray):Pair<String,JSONObject> {
    require(bytes.size<=32768 && from==link.getString("peer"))
    val e=JSONObject(bytes.toString(Charsets.UTF_8));val association=e.getString("association");val id=e.getString("id")
    require(e.get("v")==1 && association==link.getString("association") && e.getString("purpose")==purpose && WearPolicy.validId(id))
    require((e.get("issued") is Int || e.get("issued") is Long) && (e.get("expires") is Int || e.get("expires") is Long))
    val issued=e.getLong("issued");val expires=e.getLong("expires");require(WearPolicy.fresh(issued,expires,System.currentTimeMillis()/1000))
    val key=WearCrypto.raw(link.getString("secret"))
    val plain=try{WearCrypto.decrypt(key,WearCrypto.raw(e.getString("n")),WearCrypto.raw(e.getString("ct")),aad(association,from,to,purpose,id,issued,expires))}finally{key.fill(0)}
    return id to JSONObject(plain.toString(Charsets.UTF_8))
  }
}
