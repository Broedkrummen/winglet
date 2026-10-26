package expo.modules.wingletwear

import android.app.KeyguardManager
import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.Wearable
import dev.winglet.wear.WearCrypto
import dev.winglet.wear.WearStorage
import dev.winglet.wear.WearWire
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class WingletWearModule:Module(){
  private val context:Context get()=appContext.reactContext ?: throw CodedException("Watch setup unavailable")
  private fun guard(){
    val activity=appContext.currentActivity
    if(Build.VERSION.SDK_INT<26 || !PhoneWearState.foreground || PhoneWearState.locked || activity==null || activity.isFinishing ||
      (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED)!=true ||
      (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked)
      throw CodedException("Open and unlock Winglet to manage watches.")
  }
  override fun definition()=ModuleDefinition {
    Name("WingletWear")
    Function("security"){locked:Boolean,foreground:Boolean,pairs:List<String> ->
      PhoneWearState.locked=locked;PhoneWearState.foreground=foreground;PhoneWearState.allowed=pairs.toSet()
    }
    OnActivityEntersBackground{PhoneWearState.foreground=false}
    OnDestroy{PhoneWearState.foreground=false;PhoneWearState.locked=true;PhoneWearState.pending.clear()}
    AsyncFunction("capabilities"){
      mapOf("supported" to (Build.VERSION.SDK_INT>=26 && GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)==ConnectionResult.SUCCESS))
    }
    AsyncFunction("status"){
      guard();synchronized(WearStorage.mutex){
        PhoneWearState.prune()
        val links=PhoneWearState.links(context)
        mapOf("pending" to PhoneWearState.pending.values.map{p->mapOf("association" to p.getString("association"),"name" to p.getString("name"),"code" to p.getString("sas"),"expires" to p.getLong("setupExpires"))},
          "links" to links.keys().asSequence().map{key->val link=links.getJSONObject(key);mapOf("association" to key,"name" to link.optString("name"),"serverId" to link.optString("serverId"),"grantId" to link.optString("grantId"),"expires" to link.optLong("expires"),"background" to link.optBoolean("background"))}.toList())
      }
    }
    AsyncFunction("finish"){association:String,config:Map<String,Any> ->
      guard();synchronized(WearStorage.mutex){
        guard();PhoneWearState.prune()
        val pending=PhoneWearState.pending[association] ?: throw CodedException("This watch code expired. Start Link again on the watch.")
        val link=JSONObject(config)
        val uri=Uri.parse(link.getString("url"))
        require(uri.scheme in listOf("https","http") && uri.host!=null && uri.userInfo==null && uri.query==null && uri.fragment==null)
        require(link.getString("token").startsWith("wr1_") && link.getString("token").length<=100)
        require(WearCrypto.raw(link.getString("identity")).size==32)
        require(link.getString("device").length<=160 && link.getString("serverId").length<=160 && link.getString("gatewayId").length<=160)
        require(PhoneWearState.allowed?.contains(link.getString("serverId")+"\u0000"+link.getString("device"))==true)
        require(link.getJSONArray("chat_ids").length() in 1..12 && link.getLong("expires")>System.currentTimeMillis()/1000)
        link.put("association",association).put("secret",pending.getString("secret")).put("peer",pending.getString("peer"))
          .put("watch_nonce",pending.getString("watch_nonce")).put("linkedAt",System.currentTimeMillis()/1000).put("name",pending.getString("name"))
        val links=PhoneWearState.links(context)
        links.keys().asSequence().toList().filter{links.getJSONObject(it).optString("peer")==link.getString("peer")}.forEach{links.remove(it)}
        check(links.length()<8){"Unlink an old watch first"}
        links.put(association,link);PhoneWearState.save(context,links)
        PhoneWearState.pending.remove(association)
        val me=Tasks.await(Wearable.getNodeClient(context).localNode,4,TimeUnit.SECONDS).id
        val bytes=WearWire.encode(link,me,link.getString("peer"),"linked",link.getString("watch_nonce"),JSONObject().put("name",link.getString("name")).put("expires",link.getLong("expires")),120)
        runCatching{Tasks.await(Wearable.getMessageClient(context).sendMessage(link.getString("peer"),WearWire.MESSAGE,bytes),5,TimeUnit.SECONDS)}
        Unit
      }
    }
    AsyncFunction("remove"){association:String ->
      guard();synchronized(WearStorage.mutex){guard();val links=PhoneWearState.links(context);links.remove(association);PhoneWearState.save(context,links);PhoneWearState.pending.remove(association);Unit}
    }
    AsyncFunction("cancel"){association:String ->guard();synchronized(WearStorage.mutex){PhoneWearState.pending.remove(association);Unit}}
    AsyncFunction("retain"){
      synchronized(WearStorage.mutex){
        val links=PhoneWearState.links(context)
        var changed=false
        links.keys().asSequence().toList().forEach{key->val link=links.getJSONObject(key)
          if(PhoneWearState.allowed?.contains(link.optString("serverId")+"\u0000"+link.optString("device"))==false){links.remove(key);changed=true}}
        if(changed)PhoneWearState.save(context,links)
      }
    }
    AsyncFunction("reset"){guard();synchronized(WearStorage.mutex){WearStorage.reset(context,"phone");PhoneWearState.pending.clear()}}
  }
}
