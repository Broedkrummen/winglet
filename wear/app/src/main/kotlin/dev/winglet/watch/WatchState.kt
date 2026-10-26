package dev.winglet.watch

import android.app.KeyguardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import com.google.android.gms.tasks.Tasks
import com.google.android.gms.wearable.CapabilityClient
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.Wearable
import dev.winglet.wear.WearCrypto
import dev.winglet.wear.WearPolicy
import dev.winglet.wear.WearStorage
import dev.winglet.wear.WearWire
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** No chat content or drafts on disk. Association keys are wrapped by Android Keystore. */
internal object WatchState {
    private val worker=Executors.newSingleThreadExecutor()
    private val main=Handler(Looper.getMainLooper())
    @Volatile var active=false
    @Volatile var listener:(()->Unit)?=null
    @Volatile var snapshot:JSONObject?=null
    @Volatile var error=""
    @Volatile var notice=""
    @Volatile var busy=false
    private var outstanding:Request?=null
    private var retry:Request?=null
    private data class Request(val id:String,val peer:String,val bytes:ByteArray,val op:String,val expires:Long)
    private fun now()=System.currentTimeMillis()/1000
    private fun unlocked(context:Context)=!(context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked
    private fun emit(){main.post{listener?.invoke()}}
    fun state(context:Context):JSONObject=synchronized(WearStorage.mutex){WearStorage.read(context,"watch")}
    private fun save(context:Context,value:JSONObject)=synchronized(WearStorage.mutex){WearStorage.write(context,"watch",value)}
    private fun me(context:Context)=Tasks.await(Wearable.getNodeClient(context).localNode,4,TimeUnit.SECONDS).id
    private fun send(context:Context,peer:String,path:String,bytes:ByteArray){Tasks.await(Wearable.getMessageClient(context).sendMessage(peer,path,bytes),5,TimeUnit.SECONDS)}
    private fun job(work:()->Unit){worker.execute{try{work()}catch(_:Exception){busy=false;error="Phone unavailable. Open Winglet on your paired phone and retry."}finally{emit()}}}
    fun suspendPrivate(){active=false;snapshot=null;outstanding=null;retry=null;notice="";busy=false;listener=null}
    fun link(context:Context)=job{
        check(active && unlocked(context))
        val state=state(context)
        var pending=state.optJSONObject("pending")
        if(pending==null || pending.optLong("setupExpires")<=now()){
            val peers=Tasks.await(Wearable.getCapabilityClient(context).getCapability("winglet_phone_v1",CapabilityClient.FILTER_REACHABLE),5,TimeUnit.SECONDS).nodes
            check(peers.size==1){"Open Winglet on one paired Android phone."}
            pending=JSONObject().put("peer",peers.first().id).put("watch_nonce",WearCrypto.id()).put("setupExpires",now()+120)
            state.put("pending",pending);save(context,state)
        }
        error="";notice="Open Winglet → Agent → On this phone → Wear OS. Match the code and choose conversations."
        send(context,pending.getString("peer"),WearWire.HELLO,JSONObject().put("v",1).put("nonce",pending.getString("watch_nonce")).toString().toByteArray())
    }
    fun request(context:Context,op:String,data:JSONObject=JSONObject())=job{
        check(active && unlocked(context));if(busy)return@job
        val link=state(context).getJSONObject("link");check(link.getLong("expires")>now())
        val id=WearCrypto.id();val peer=link.getString("peer")
        val bytes=WearWire.encode(link,me(context),peer,"request",id,JSONObject().put("op",op).put("data",data))
        val request=Request(id,peer,bytes,op,now()+60)
        outstanding=request;if(op=="send")retry=request
        busy=true;error="";notice=if(op=="send")"Sending…" else "Connecting…";emit()
        try{send(context,peer,WearWire.MESSAGE,bytes)}catch(e:Exception){busy=false;throw e}
        main.postDelayed({if(outstanding?.id==id){busy=false;error="No acknowledgement yet. Reconnect the phone and retry.";emit()}},12000)
    }
    fun retrySend(context:Context)=job{
        check(active && unlocked(context));if(busy)return@job;val request=retry ?: error("No reply to retry")
        check(request.expires>now()){"Reply expired. Refresh before composing again."}
        outstanding=request;busy=true;error="";notice="Retrying the same reply…";emit()
        try{send(context,request.peer,WearWire.MESSAGE,request.bytes)}finally{busy=false}
    }
    fun canRetry()=retry?.expires?.let{it>now()}==true
    fun unlink(context:Context)=job{
        val state=state(context);val link=state.optJSONObject("link")
        if(link!=null)runCatching{
            val peer=link.getString("peer");send(context,peer,WearWire.MESSAGE,WearWire.encode(link,me(context),peer,"request",WearCrypto.id(),JSONObject().put("op","unlink").put("data",JSONObject())))
        }
        synchronized(WearStorage.mutex){WearStorage.reset(context,"watch")}
        snapshot=null;outstanding=null;retry=null;busy=false;notice="Watch link removed. If offline, also revoke it in Winglet on the phone.";error=""
    }
    fun receive(context:Context,event:MessageEvent)=job{
        if(event.data.size>32768)return@job
        val state=state(context);val pending=state.optJSONObject("pending")
        if(event.path==WearWire.CHALLENGE){
            if(pending==null || pending.optLong("setupExpires")<=now() || pending.optString("peer")!=event.sourceNodeId)return@job
            val challenge=JSONObject(event.data.toString(Charsets.UTF_8))
            require(challenge.get("v")==1 && challenge.getString("watch_nonce")==pending.getString("watch_nonce"))
            require(challenge.getString("peer")==event.sourceNodeId && WearPolicy.validId(challenge.getString("association")))
            require(WearCrypto.raw(challenge.getString("secret")).size==32 && challenge.getString("sas").matches(Regex("^[0-9]{6}$")))
            require(challenge.getLong("setupExpires") in now()+1..now()+120)
            // A duplicate transport delivery cannot replace a previously displayed code/key.
            if(pending.has("association"))require(pending.getString("association")==challenge.getString("association") && pending.getString("secret")==challenge.getString("secret"))
            challenge.put("setupExpires",minOf(challenge.getLong("setupExpires"),pending.getLong("setupExpires")))
            state.put("pending",challenge);save(context,state);return@job
        }
        if(event.path!=WearWire.MESSAGE)return@job
        if(pending!=null && pending.has("secret") && pending.optLong("setupExpires")>now() && event.sourceNodeId==pending.optString("peer")){
            val opened=runCatching{WearWire.decode(pending,event.sourceNodeId,me(context),"linked",event.data)}.getOrNull()
            if(opened!=null){
                require(opened.first==pending.getString("watch_nonce"));val expires=opened.second.getLong("expires");require(expires in now()+1..now()+31*86400)
                pending.put("expires",expires).put("name",opened.second.optString("name").take(80));pending.remove("sas");pending.remove("watch_nonce");pending.remove("setupExpires")
                state.put("link",pending);state.remove("pending");save(context,state);notice="Linked. Refresh to load shared conversations.";error="";return@job
            }
        }
        if(!active || !unlocked(context))return@job
        val link=state.optJSONObject("link") ?: return@job
        if(link.optLong("expires")<=now())return@job
        val request=outstanding ?: return@job
        val (id,body)=WearWire.decode(link,event.sourceNodeId,me(context),"reply",event.data)
        if(id!=request.id)return@job
        outstanding=null;busy=false
        if(body.has("error")){
            if(body.optString("error") in listOf("link_revoked","pairing_changed","bot_unavailable","conversation_unavailable","conversation_not_shared"))snapshot=null
            error=when(body.optString("error")){
                "open_phone"->"Open and unlock Winglet on your phone."
                "link_revoked","pairing_changed","bot_unavailable"->"Watch access changed. Unlink and pair again on your phone."
                "conversation_unavailable","conversation_not_shared"->"This conversation is no longer shared."
                "reply_not_allowed"->"This watch has read-only access."
                "version_mismatch"->"Update Winglet on both the phone and watch, then pair again."
                else->"Request unavailable. Check the phone and refresh."
            };notice="";return@job
        }
        error=""
        if(request.op=="read"){require(body.get("v")==1);snapshot=body;notice=""}
        else if(request.op=="send" && body.optString("status")=="accepted"){
            retry=null;notice="Reply accepted by the server. Refresh to see the agent’s response."
        }else if(request.op=="open")notice="Tap the Winglet notification on your phone."
    }
}
