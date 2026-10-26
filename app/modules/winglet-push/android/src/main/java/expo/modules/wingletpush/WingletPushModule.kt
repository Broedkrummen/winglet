package expo.modules.wingletpush

import android.Manifest
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.unifiedpush.android.connector.UnifiedPush

class WingletPushModule : Module() {
  @Volatile private var locked=true
  @Volatile private var visible=false
  private val context:Context get()=appContext.reactContext ?: throw CodedException("Push setup is unavailable")
  private fun guard(){
    val activity=appContext.currentActivity
    val resumed=(activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED)==true
    if(Build.VERSION.SDK_INT<26 || locked || !visible || !resumed || activity==null || activity.isFinishing ||
      (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked)
      throw CodedException("Unlock Winglet in the foreground to configure encrypted push.")
  }
  private fun status(scope: String): Map<String,Any?> {
    val entry=try{PushStore.read(context,scope)}catch(_:Exception){return mapOf("keyLost" to true,"registered" to false,"active" to false,"error" to "key_lost")}
      ?: return mapOf("registered" to false,"active" to false)
    return mapOf("registered" to entry.has("subscription"),"active" to entry.optBoolean("active"),"kid" to entry.getString("kid"),
      "needsSync" to entry.optBoolean("needsSync"),"previews" to entry.optBoolean("previews"),"error" to entry.optString("error"),
      "received" to entry.optLong("received"),"decrypted" to entry.optLong("decrypted"),"displayed" to entry.optLong("displayed"),
      "suppressed" to entry.optLong("suppressed"))
  }
  private fun remove(scope: String){
    UnifiedPush.unregister(context,scope)
    PushStore.delete(context,scope)
    val manager=context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.activeNotifications.filter{it.tag?.startsWith(scope+":")==true}.forEach{manager.cancel(it.tag,it.id)}
  }
  override fun definition()=ModuleDefinition {
    Name("WingletPush")
    Function("security"){isLocked:Boolean,privatePreviews:Boolean,foreground:Boolean,online:List<String> ->
      locked=isLocked;visible=foreground;PushVisibility.locked=isLocked
      PushVisibility.online=if(foreground)online.toSet() else emptySet()
      // No user content or credentials, and persisted for cold-start privacy.
      context.getSharedPreferences("winglet-push-policy",Context.MODE_PRIVATE).edit().putBoolean("private",privatePreviews).apply()
    }
    OnActivityEntersBackground{visible=false;PushVisibility.online=emptySet()}
    OnActivityDestroys{visible=false;locked=true;PushVisibility.online=emptySet();PushVisibility.locked=true}
    OnDestroy{visible=false;locked=true;PushVisibility.online=emptySet();PushVisibility.locked=true}
    AsyncFunction("capabilities"){
      guard()
      mapOf("supported" to (Build.VERSION.SDK_INT>=26),"distributors" to UnifiedPush.getDistributors(context).map{pkg ->
        mapOf("id" to pkg,"name" to runCatching{context.packageManager.getApplicationLabel(context.packageManager.getApplicationInfo(pkg,0)).toString()}.getOrDefault(pkg))
      },"notificationsAllowed" to (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).areNotificationsEnabled())
    }
    AsyncFunction("requestPermission"){promise:Promise ->
      guard()
      if(Build.VERSION.SDK_INT>=33)Permissions.askForPermissionsWithPermissionsManager(appContext.permissions,promise,Manifest.permission.POST_NOTIFICATIONS)
      else promise.resolve(mapOf("granted" to true))
    }
    AsyncFunction("status"){server:String,device:String -> guard();synchronized(PushStore.mutex){status(PushStore.scope(server,device))}}
    AsyncFunction("prepare"){server:String,device:String,distributor:String,vapid:String,rotate:Boolean ->
      guard()
      if(distributor !in UnifiedPush.getDistributors(context))throw CodedException("Install or choose an available UnifiedPush distributor, such as ntfy.")
      synchronized(PushStore.mutex){
        val (scope,_)=PushStore.prepare(context,server,device,rotate)
        UnifiedPush.saveDistributor(context,distributor)
        UnifiedPush.register(context,instance=scope,messageForDistributor="Winglet",vapid=vapid)
        status(scope)
      }
    }
    AsyncFunction("credentials"){server:String,device:String ->
      guard()
      synchronized(PushStore.mutex){
        val entry=PushStore.read(context,PushStore.scope(server,device)) ?: throw CodedException("Set up encrypted push first.")
        val sub=entry.optJSONObject("subscription") ?: throw CodedException("Waiting for the push distributor. Keep ntfy running and retry.")
        val keys=sub.getJSONObject("keys")
        mapOf("v" to 1,"kid" to entry.getString("kid"),"key" to entry.getString("key"),"subscription" to
          mapOf("endpoint" to sub.getString("endpoint"),"keys" to mapOf("p256dh" to keys.getString("p256dh"),"auth" to keys.getString("auth"))))
      }
    }
    AsyncFunction("activate"){server:String,device:String,kid:String ->
      guard();synchronized(PushStore.mutex){
        val scope=PushStore.scope(server,device);val entry=PushStore.read(context,scope) ?: throw CodedException("Push key was lost")
        if(entry.getString("kid")!=kid)throw CodedException("Push key changed. Retry setup.")
        entry.put("active",true).put("needsSync",false).put("error","");PushStore.write(context,scope,entry)
      }
    }
    AsyncFunction("previews"){server:String,device:String,enabled:Boolean ->
      guard();synchronized(PushStore.mutex){
        val scope=PushStore.scope(server,device);val entry=PushStore.read(context,scope) ?: throw CodedException("Set up encrypted push first")
        entry.put("previews",enabled);PushStore.write(context,scope,entry)
      }
    }
    AsyncFunction("remove"){server:String,device:String -> guard();synchronized(PushStore.mutex){remove(PushStore.scope(server,device))}}
    AsyncFunction("retain"){pairs:List<Map<String,String>> ->
      val keep=pairs.map{PushStore.scope(it["server"] ?: "",it["device"] ?: "")}.toSet()
      synchronized(PushStore.mutex){PushStore.scopes(context).filter{it !in keep}.forEach{remove(it)}}
    }
  }
}
