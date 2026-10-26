package expo.modules.wingletassistant

import android.app.KeyguardManager
import android.app.role.RoleManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Window
import android.view.WindowManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.security.SecureRandom
import java.lang.ref.WeakReference

internal object AssistantRuntime {
  val vault=InvocationVault({SystemClock.elapsedRealtime()}, {
    val bytes=ByteArray(16);SecureRandom().nextBytes(bytes)
    bytes.joinToString(""){(it.toInt() and 255).toString(16).padStart(2,'0')}
  })
  @Volatile var appLocked=true
  @Volatile var lockEnabled=false
  @Volatile var lockDeadline=Long.MAX_VALUE
  @Volatile var serverId=""
  @Volatile var chatId=""
  @Volatile var title="Winglet"
  fun role(context: Context): Boolean=android.os.Build.VERSION.SDK_INT>=29 &&
    (context.getSystemService(Context.ROLE_SERVICE) as RoleManager).isRoleHeld(RoleManager.ROLE_ASSISTANT)
  fun locked(context: Context): Boolean=(context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked
  fun privateLocked(): Boolean=appLocked || (lockEnabled && SystemClock.elapsedRealtime()>=lockDeadline)
}
class WingletAssistantModule : Module() {
  private val main=Handler(Looper.getMainLooper())
  private var privateWindow: WeakReference<Window>?=null
  private var privateOwner=""
  private var wasSecure=false
  private fun releasePrivacy(id: String?=null){
    if(id!=null && id!=privateOwner)return
    if(!wasSecure)privateWindow?.get()?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    privateWindow=null;privateOwner="";wasSecure=false
  }
  private val context: Context get()=appContext.reactContext ?: throw CodedException("Assistant is unavailable")
  private fun foreground() {
    val activity=appContext.currentActivity
    val resumed=(activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED)==true
    if(activity==null || activity.isFinishing || !resumed || AssistantRuntime.privateLocked() || AssistantRuntime.locked(context))
      throw CodedException("Unlock Winglet in the foreground to continue.")
  }
  private fun authorized(id: String): InvocationVault.Entry {
    foreground()
    if(!AssistantRuntime.role(context)){AssistantRuntime.vault.clearAll();throw CodedException("Winglet is no longer the selected assistant.")}
    return AssistantRuntime.vault.read(id) ?: throw CodedException("This assistant invocation expired. Invoke Winglet again.")
  }
  override fun definition()=ModuleDefinition {
    Name("WingletAssistant")
    Function("security") { locked: Boolean, lockEnabled: Boolean, foreground: Boolean, server: String, chat: String, title: String ->
      AssistantRuntime.appLocked=locked;AssistantRuntime.lockEnabled=lockEnabled
      if(foreground && !locked)AssistantRuntime.lockDeadline=Long.MAX_VALUE
      AssistantRuntime.serverId=server.take(160)
      AssistantRuntime.chatId=chat.take(160);AssistantRuntime.title=title.take(100)
      if(locked)AssistantRuntime.vault.clearAll()
    }
    Function("discard"){id: String -> AssistantRuntime.vault.clear(id)}
    Function("discardAll"){AssistantRuntime.vault.clearAll()}
    Function("unprotect"){id: String -> main.post{releasePrivacy(id)}}
    OnActivityEntersBackground{AssistantRuntime.vault.clearAll();AssistantRuntime.lockDeadline=SystemClock.elapsedRealtime()+60_000}
    OnActivityDestroys{AssistantRuntime.vault.clearAll();AssistantRuntime.appLocked=true;main.post{releasePrivacy()}}
    OnDestroy{AssistantRuntime.vault.clearAll();AssistantRuntime.appLocked=true;main.post{releasePrivacy()}}
    AsyncFunction("capabilities") {
      val manager=if(Build.VERSION.SDK_INT>=29)context.getSystemService(Context.ROLE_SERVICE) as RoleManager else null
      mapOf("supported" to (manager?.isRoleAvailable(RoleManager.ROLE_ASSISTANT)==true),
        "held" to (manager?.isRoleHeld(RoleManager.ROLE_ASSISTANT)==true))
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestRole") {
      foreground()
      if(Build.VERSION.SDK_INT<29)throw CodedException("Assistant role needs Android10 or later.")
      val manager=context.getSystemService(Context.ROLE_SERVICE) as RoleManager
      if(!manager.isRoleAvailable(RoleManager.ROLE_ASSISTANT))throw CodedException("This device does not offer the assistant role.")
      if(manager.isRoleHeld(RoleManager.ROLE_ASSISTANT))
        appContext.currentActivity!!.startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
      else
        appContext.currentActivity!!.startActivityForResult(manager.createRequestRoleIntent(RoleManager.ROLE_ASSISTANT),7304)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("protect") {id: String ->
      authorized(id)
      if(privateOwner!=id){
        releasePrivacy()
        val window=appContext.currentActivity!!.window
        wasSecure=window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0
        privateWindow=WeakReference(window);privateOwner=id
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("peek") {id: String ->
      val e=authorized(id)
      if(!e.handoff)throw CodedException("This invocation has not been handed to Winglet.")
      mapOf("id" to e.id,"serverId" to e.serverId,"chatId" to e.chatId,"question" to e.question,
        "context" to e.context,"source" to e.source,"remainingMs" to (e.expires-SystemClock.elapsedRealtime()))
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("bind") {id: String, server: String, chat: String, request: String, digest: String ->
      authorized(id)
      if(!AssistantRuntime.vault.bind(id,server,chat,request,digest))throw CodedException("This invocation already belongs to another conversation or question.")
    }.runOnQueue(Queues.MAIN)
  }
}

