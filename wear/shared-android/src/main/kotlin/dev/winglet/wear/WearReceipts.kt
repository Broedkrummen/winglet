package dev.winglet.wear
import org.json.JSONObject

/** Persist value after claim, before effects; only bounded send acknowledgements are cached. */
class WearReceipts(val value:JSONObject,now:Long){
    data class Claim(val mode:String,val result:JSONObject?=null)
    private val stamp=now
    init {value.keys().asSequence().toList().forEach{if(value.getJSONObject(it).optLong("at")<now-180)value.remove(it)}}
    fun claim(id:String,body:JSONObject):Claim{
        require(WearPolicy.validId(id))
        val digest=WearCrypto.hash(body.toString().toByteArray(Charsets.UTF_8))
        val previous=value.optJSONObject(id)
        if(previous!=null){
            if(previous.optString("hash")!=digest)return Claim("conflict")
            return previous.optJSONObject("result")?.let{Claim("cached",it)} ?: Claim("retry")
        }
        if(value.length()>=128)return Claim("full")
        value.put(id,JSONObject().put("at",stamp).put("hash",digest));return Claim("new")
    }
    fun accept(id:String,result:JSONObject){
        require(result.optString("status")=="accepted" && result.toString().toByteArray(Charsets.UTF_8).size<=1024)
        value.getJSONObject(id).put("result",JSONObject(result.toString()))
    }
}
