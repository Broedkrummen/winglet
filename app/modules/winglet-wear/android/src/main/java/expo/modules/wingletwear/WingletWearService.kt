package expo.modules.wingletwear

import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import com.google.android.gms.wearable.WearableListenerService
import dev.winglet.wear.WearCrypto
import dev.winglet.wear.WearPolicy
import dev.winglet.wear.WearStorage
import dev.winglet.wear.WearWire
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import java.security.SecureRandom

internal object PhoneWearState {
  @Volatile var foreground=false
  @Volatile var locked=true
  @Volatile var allowed:Set<String>?=null
  val pending=java.util.concurrent.ConcurrentHashMap<String,JSONObject>()
  fun links(context:Context)=WearStorage.read(context,"phone")
  fun save(context:Context,value:JSONObject)=WearStorage.write(context,"phone",value)
  fun prune(){val stamp=System.currentTimeMillis()/1000;pending.entries.removeAll{it.value.optLong("setupExpires")<=stamp}}
}
class WingletWearService:WearableListenerService(){
  private fun local()=Tasks.await(Wearable.getNodeClient(this).localNode,4,TimeUnit.SECONDS).id
  private fun send(peer:String,path:String,bytes:ByteArray){Tasks.await(Wearable.getMessageClient(this).sendMessage(peer,path,bytes),5,TimeUnit.SECONDS)}
  override fun onMessageReceived(event:MessageEvent){
    if(Build.VERSION.SDK_INT<26 || event.data.size>32768 || event.sourceNodeId.length>160)return
    try{
      if(event.path==WearWire.HELLO){hello(event);return}
      if(event.path!=WearWire.MESSAGE)return
      val me=local()
      synchronized(WearStorage.mutex){
        val links=PhoneWearState.links(this)
        val header=JSONObject(event.data.toString(Charsets.UTF_8));val association=header.optString("association")
        val link=links.optJSONObject(association) ?: return
        if(link.getString("peer")!=event.sourceNodeId || link.optLong("expires")<=System.currentTimeMillis()/1000)return
        if(PhoneWearState.allowed?.contains(link.getString("serverId")+"\u0000"+link.getString("device"))==false)return
        val (id,body)=WearWire.decode(link,event.sourceNodeId,me,"request",event.data)
        val op=body.optString("op");val data=body.optJSONObject("data") ?: JSONObject()
        val digest=WearCrypto.hash(body.toString().toByteArray(Charsets.UTF_8))
        val cache=link.optJSONObject("requests") ?: JSONObject()
        val now=System.currentTimeMillis()/1000
        cache.keys().asSequence().toList().forEach{if(cache.getJSONObject(it).optLong("at")<now-180)cache.remove(it)}
        val previous=cache.optJSONObject(id)
        var result:JSONObject
        if(previous!=null && previous.optString("hash")!=digest)result=JSONObject().put("error","request_conflict")
        else if(previous?.optJSONObject("result")!=null)result=previous.getJSONObject("result")
        else{
          if(previous==null && cache.length()>=128)return
          cache.put(id,JSONObject().put("at",now).put("hash",digest));link.put("requests",cache)
          links.put(association,link);PhoneWearState.save(this,links)
          val deviceLocked=(getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked
          val available=link.optBoolean("background") || (PhoneWearState.foreground && !PhoneWearState.locked && !deviceLocked)
          result=if(op=="unlink"){
            runCatching{WearGateway.request(link,"unlink",JSONObject())}
            links.remove(association);PhoneWearState.save(this,links);JSONObject().put("status","unlinked")
          }else if(!available)JSONObject().put("error","open_phone")
          else if(previous!=null && op!="send")JSONObject().put("error","request_replayed")
          else if(op in listOf("read","send"))runCatching{WearGateway.request(link,op,data)}.getOrElse{JSONObject().put("error","phone_unavailable")}
          else if(op=="open"){
            val chat=data.optString("chat_id");val selected=link.getJSONArray("chat_ids")
            require((0 until selected.length()).any{selected.getString(it)==chat})
            val check=runCatching{WearGateway.request(link,"read",JSONObject().put("chat_id",chat))}.getOrElse{JSONObject().put("error","phone_unavailable")}
            if(check.has("error"))check else openPhone(link,chat)
          }else JSONObject().put("error","operation_not_allowed")
          // Read bodies never become a persistent transcript. Only small reply acknowledgements are cached.
          if(op=="send" && result.optString("status")=="accepted"){
            cache.getJSONObject(id).put("result",result);PhoneWearState.save(this,links)
          }
        }
        send(event.sourceNodeId,WearWire.MESSAGE,WearWire.encode(link,me,event.sourceNodeId,"reply",id,result))
      }
    }catch(_:Exception){/* No tokens, node payloads, URLs or private callback errors are logged. */}
  }
  private fun hello(event:MessageEvent){
    require(event.data.size<=512)
    val request=JSONObject(event.data.toString(Charsets.UTF_8));val nonce=request.getString("nonce")
    require(request.get("v")==1 && WearPolicy.validId(nonce));val me=local()
    synchronized(WearStorage.mutex){
      PhoneWearState.prune()
      PhoneWearState.pending.entries.removeAll{it.value.optString("peer")==event.sourceNodeId && it.value.optString("watch_nonce")!=nonce}
      val linked=runCatching{PhoneWearState.links(this)}.getOrElse{return}
      val existing=linked.keys().asSequence().map{linked.getJSONObject(it)}.firstOrNull{it.optString("peer")==event.sourceNodeId && it.optString("watch_nonce")==nonce && it.optLong("linkedAt")>System.currentTimeMillis()/1000-120}
      if(existing!=null){send(event.sourceNodeId,WearWire.MESSAGE,WearWire.encode(existing,me,event.sourceNodeId,"linked",nonce,JSONObject().put("name",existing.optString("name")).put("expires",existing.getLong("expires"))));return}
      var pending=PhoneWearState.pending.values.firstOrNull{it.getString("peer")==event.sourceNodeId && it.getString("watch_nonce")==nonce}
      if(pending==null){
        if(PhoneWearState.pending.size>=8)return
        val name=runCatching{Tasks.await(Wearable.getNodeClient(this).connectedNodes,3,TimeUnit.SECONDS).firstOrNull{it.id==event.sourceNodeId}?.displayName}.getOrNull() ?: "Wear OS watch"
        pending=JSONObject().put("association",WearCrypto.id()).put("peer",event.sourceNodeId).put("watch_nonce",nonce)
          .put("secret",WearCrypto.b64(WearCrypto.bytes(32))).put("sas",SecureRandom().nextInt(1_000_000).toString().padStart(6,'0'))
          .put("name",name.take(80)).put("setupExpires",System.currentTimeMillis()/1000+120)
        PhoneWearState.pending[pending.getString("association")]=pending
      }
      val challenge=JSONObject(pending.toString()).put("v",1).put("peer",me)
      send(event.sourceNodeId,WearWire.CHALLENGE,challenge.toString().toByteArray(Charsets.UTF_8))
    }
  }
  private fun openPhone(link:JSONObject,chat:String):JSONObject {
    val manager=getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if(!manager.areNotificationsEnabled())return JSONObject().put("error","open_phone")
    val channel="winglet-watch-open";manager.createNotificationChannel(NotificationChannel(channel,"Open from watch",NotificationManager.IMPORTANCE_DEFAULT))
    val scheme=if(packageName.endsWith(".dev"))"winglet-dev" else "winglet"
    val path=scheme+"://chat/"+Uri.encode(link.getString("serverId"))+"/"+Uri.encode(chat)
    val intent=Intent(Intent.ACTION_VIEW,Uri.parse(path)).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val pending=PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    manager.notify("winglet-wear-open",1,Notification.Builder(this,channel).setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle("Winglet").setContentText("Your watch asked to open a conversation. Tap to continue.").setContentIntent(pending).setAutoCancel(true).build())
    return JSONObject().put("status","check_phone")
  }
}
