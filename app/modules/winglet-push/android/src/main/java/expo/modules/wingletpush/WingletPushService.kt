package expo.modules.wingletpush

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.net.Uri
import org.json.JSONObject
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

internal object PushVisibility {
  @Volatile var online:Set<String> = emptySet()
  @Volatile var locked=true
}
class WingletPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint,instance: String){
    synchronized(PushStore.mutex){
      val entry=runCatching{PushStore.read(this,instance)}.getOrNull() ?: return
      val keys=endpoint.pubKeySet
      if(keys==null || endpoint.url.length>2048 || !endpoint.url.startsWith("https://")){entry.put("error","unsupported_endpoint")}
      else{
        entry.put("subscription",JSONObject().put("endpoint",endpoint.url).put("keys",JSONObject().put("p256dh",keys.pubKey).put("auth",keys.auth)))
        entry.put("error","");entry.put("needsSync",true);PushStore.mark(entry,"registered")
      }
      runCatching{PushStore.write(this,instance,entry)}
    }
  }
  override fun onMessage(message: PushMessage,instance: String){
    if(Build.VERSION.SDK_INT<26 || message.content.size>3600 || !message.decrypted)return
    synchronized(PushStore.mutex){
      val entry=runCatching{PushStore.read(this,instance)}.getOrNull() ?: return
      PushStore.mark(entry,"received")
      try{
        val envelope=JSONObject(message.content.toString(Charsets.UTF_8))
        require(envelope.get("v")==1 && envelope.getString("kid")==entry.getString("kid"))
        require(envelope.length()==4)
        val key=PushStore.unb64(entry.getString("key"))
        val plain=try{PushCipher.open(key,entry.getString("server"),entry.getString("device"),entry.getString("kid"),
          PushStore.unb64(envelope.getString("nonce")),PushStore.unb64(envelope.getString("ct")))}finally{key.fill(0)}
        val payload=JSONObject(plain.toString(Charsets.UTF_8));plain.fill(0)
        require(payload.get("issued") is Number && payload.get("expires") is Number)
        val remembered=entry.optJSONObject("seen") ?: JSONObject()
        val ids=remembered.keys().asSequence().associateWith{remembered.getLong(it)}
        val guard=PushGuard({System.currentTimeMillis()/1000},ids)
        if(!guard.accept(payload.getString("id"),payload.getLong("issued"),payload.getLong("expires"))){
          entry.put("error","duplicate_or_stale");PushStore.write(this,instance,entry);return
        }
        val note=payload.getJSONObject("note")
        for(field in listOf("title","body","url","tag","kind","chat_id"))require(note.get(field) is String)
        entry.put("seen",JSONObject(guard.snapshot()));PushStore.mark(entry,"decrypted");entry.put("error","")
        // The durable replay mark is committed before any display side effect.
        PushStore.write(this,instance,entry)
        if(entry.getString("server") in PushVisibility.online){PushStore.mark(entry,"suppressed")}
        else if(show(instance,entry,note)){PushStore.mark(entry,"displayed")}
        else{entry.put("error","notifications_blocked")}
        PushStore.write(this,instance,entry)
      }catch(_:Exception){entry.put("error","invalid_or_unavailable_key");runCatching{PushStore.write(this,instance,entry)}}
    }
  }
  private fun show(instance: String,entry: JSONObject,note: JSONObject): Boolean {
    val manager=getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if(!manager.areNotificationsEnabled())return false
    val channel="winglet-messages-v1"
    manager.createNotificationChannel(NotificationChannel(channel,"Winglet messages",NotificationManager.IMPORTANCE_DEFAULT))
    if(manager.getNotificationChannel(channel).importance==NotificationManager.IMPORTANCE_NONE)return false
    val generic="Open Winglet to review the latest update."
    val details=entry.optBoolean("previews",false) && !PushVisibility.locked && !getSharedPreferences("winglet-push-policy",MODE_PRIVATE).getBoolean("private",true)
    val path=safePath(note.optString("url"),entry.getString("server"))
    val scheme=if(packageName.endsWith(".dev"))"winglet-dev" else "winglet"
    val intent=Intent(Intent.ACTION_VIEW,Uri.parse(scheme+":"+"/"+path)).setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val pending=PendingIntent.getActivity(this,0,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val public=Notification.Builder(this,channel).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Winglet").setContentText(generic).build()
    val notification=Notification.Builder(this,channel).setSmallIcon(android.R.drawable.ic_dialog_info)
      .setContentTitle(if(details)note.optString("title").take(120) else "Winglet")
      .setContentText(if(details)note.optString("body").take(400) else generic)
      .setContentIntent(pending).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(public).build()
    val tag=PushStore.hex(java.security.MessageDigest.getInstance("SHA-256").digest(note.optString("tag").toByteArray()))
    manager.notify(instance+":"+tag,1,notification)
    return true
  }
  private fun safePath(value: String,server: String): String {
    val path=Uri.parse(value)
    if(path.scheme!=null || path.host!=null || path.query!=null || path.fragment!=null)return "/"
    val parts=path.pathSegments
    return if(parts.size==3 && parts[0]=="chat" && (parts[1]==server || parts[1].startsWith(server+"~")) &&
      parts.all{!it.contains('/') && !it.contains('\\') && it!=".." && it!="."}) value else "/"
  }
  override fun onRegistrationFailed(reason: FailedReason,instance: String)=markError(instance,"registration_failed")
  override fun onTempUnavailable(instance: String)=markError(instance,"distributor_unavailable")
  override fun onUnregistered(instance: String)=markError(instance,"unregistered")
  private fun markError(instance: String,error: String){synchronized(PushStore.mutex){runCatching{
    val entry=PushStore.read(this,instance) ?: return;entry.put("error",error);PushStore.write(this,instance,entry)
  }}}
}
