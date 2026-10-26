package dev.winglet.watch

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognizerIntent
import android.text.InputFilter
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject

/** Foreground-only transcript, native text/voice composition, and deliberate sends. */
class WatchActivity:Activity(){
    private val handler=Handler(Looper.getMainLooper())
    private lateinit var panel:LinearLayout
    private lateinit var scroll:ScrollView
    private var selected=""
    private var composer:EditText?=null
    private var draft=""
    private var voiceChat=""
    private var licenses=false
    private var resumed=false
    private val poll=object:Runnable {override fun run(){
        if(!resumed)return
        if((getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked){WatchState.suspendPrivate();draft="";render()}
        else if(!licenses && !WatchState.busy && composer?.hasFocus()!=true && !WatchState.canRetry()){
            val linked=runCatching{WatchState.state(this@WatchActivity).has("link")}.getOrDefault(false)
            if(linked)WatchState.request(applicationContext,"read",if(selected.isEmpty())JSONObject() else JSONObject().put("chat_id",selected))
        }
        handler.postDelayed(this,10000)
    }}
    override fun onCreate(savedInstanceState:Bundle?){
        super.onCreate(savedInstanceState);window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        scroll=ScrollView(this).apply{isFillViewport=true;setBackgroundColor(Color.rgb(14,12,22))}
        panel=LinearLayout(this).apply{orientation=LinearLayout.VERTICAL;gravity=Gravity.CENTER_HORIZONTAL
            val inset=if(resources.configuration.isScreenRound)28 else 16;setPadding(dp(inset),dp(24),dp(inset),dp(40))}
        scroll.addView(panel);setContentView(scroll)
    }
    override fun onResume(){super.onResume();resumed=true;WatchState.active=true;WatchState.listener={if(composer?.hasFocus()!=true)render()};render();handler.postDelayed(poll,1000)}
    override fun onPause(){resumed=false;handler.removeCallbacks(poll);WatchState.suspendPrivate();draft="";composer?.setText("");selected="";panel.removeAllViews();super.onPause()}
    private fun dp(value:Int)=(value*resources.displayMetrics.density).toInt()
    private fun text(value:String,size:Float=14f,accent:Boolean=false){panel.addView(TextView(this).apply{
        text=value;textSize=size;setTextColor(if(accent)Color.rgb(190,166,255) else Color.rgb(236,232,246));gravity=Gravity.CENTER
        setPadding(0,dp(6),0,dp(6));if(size>=19)typeface=Typeface.DEFAULT_BOLD
    },LinearLayout.LayoutParams(-1,-2))}
    private fun button(label:String,enabled:Boolean=true,action:()->Unit){panel.addView(Button(this).apply{
        text=label;isEnabled=enabled;isAllCaps=false;minHeight=dp(48);textSize=14f;setOnClickListener{action()}
    },LinearLayout.LayoutParams(-1,-2).apply{topMargin=dp(4)})}
    private fun render(){
        if(!resumed)return
        val locked=(getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked
        panel.removeAllViews();composer=null;text("Winglet",22f,true)
        if(locked){text("Unlock your watch to see conversations.");return}
        if(licenses){
            text("Third-party notices",17f,true);button("‹ Back"){licenses=false;render()}
            text(assets.open("third-party-notices.txt").bufferedReader().use{it.readText()},12f);return
        }
        val state=try{WatchState.state(this)}catch(_:Exception){text("The watch key is unavailable. Reset this watch link and pair again.");button("Reset local link"){WatchState.unlink(applicationContext)};return}
        val link=state.optJSONObject("link");val pending=state.optJSONObject("pending")
        if(link==null){
            text("Your agents, on your wrist")
            text("Install Winglet on a paired Android phone with Google Play services, using the same app version and signing certificate.")
            if(pending?.optLong("setupExpires")?.let{it>System.currentTimeMillis()/1000}==true){
                if(pending.has("sas")){text(pending.getString("sas"),26f,true);text("Match this code in Winglet on your phone. It expires in two minutes.")}
                else text("Waiting for the paired phone…")
            }
            button("Link / check phone"){WatchState.link(applicationContext)}
            if(pending!=null)button("Cancel setup"){WatchState.unlink(applicationContext)}
        }else if(link.optLong("expires")<=System.currentTimeMillis()/1000){
            text("This watch link expired. Renew access from your phone.");button("Remove expired link"){WatchState.unlink(applicationContext)}
        }else{
            val data=WatchState.snapshot
            if(selected.isEmpty()){
                text(data?.optString("bot")?.ifBlank{null} ?: "Shared conversations",17f,true)
                val chats=data?.optJSONArray("chats")
                if(chats==null)text("Refresh to connect through your phone.")
                else if(chats.length()==0)text("No shared conversations are available. Review access on your phone.")
                else for(i in 0 until chats.length()){
                    val chat=chats.getJSONObject(i)
                    val status=when(chat.optString("state")){"needs_you"->"Needs you · open phone";"working"->"Working";else->"Ready"}
                    button(chat.optString("title")+"\n"+status,!WatchState.busy){selected=chat.getString("id");draft="";WatchState.request(applicationContext,"read",JSONObject().put("chat_id",selected));render()}
                }
            }else{
                button("‹ Conversations"){selected="";draft="";WatchState.snapshot=null;render();WatchState.request(applicationContext,"read")}
                val messages=if(data?.optString("chat_id")==selected)data.optJSONArray("messages") else null
                if(messages==null)text("Loading this conversation…")
                else{
                    for(i in 0 until messages.length()){
                        val message=messages.getJSONObject(i)
                        text(if(message.optString("role")=="user")"You" else "Agent",12f,true);text(message.optString("text"))
                    }
                    text("Recent messages only. Use your phone for full history, tools and approvals.",12f)
                    if(data?.optBoolean("can_reply")==true){
                        composer=EditText(this).apply{
                            hint="Short reply";setTextColor(Color.WHITE);setHintTextColor(Color.LTGRAY);textSize=15f
                            filters=arrayOf(InputFilter.LengthFilter(2000));minHeight=dp(56);maxLines=5;setText(draft)
                            setOnFocusChangeListener{_,focused->if(!focused)draft=text.toString()}
                        };panel.addView(composer,LinearLayout.LayoutParams(-1,-2))
                        button("Use “Thanks”",!WatchState.busy && !WatchState.canRetry()){draft="Thanks!";composer?.setText(draft)}
                        button("Use “Give me a short update”",!WatchState.busy && !WatchState.canRetry()){draft="Give me a short update.";composer?.setText(draft)}
                        button("Speak reply",!WatchState.busy && !WatchState.canRetry()){
                            draft=composer?.text?.toString().orEmpty()
                            voiceChat=selected
                            try{startActivityForResult(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,RecognizerIntent.LANGUAGE_MODEL_FREE_FORM).putExtra(RecognizerIntent.EXTRA_PROMPT,"Dictate a reply, then review and tap Send"),17)}catch(_:Exception){voiceChat="";WatchState.error="Voice input is unavailable. Type a reply instead.";render()}
                        }
                        button("Send reply",!WatchState.busy && !WatchState.canRetry()){
                            val body=composer?.text?.toString()?.trim().orEmpty()
                            if(body.isEmpty() || body.startsWith('/')){WatchState.error="Write a reply without slash commands.";draft=body;render()}
                            else{composer?.clearFocus();draft="";WatchState.request(applicationContext,"send",JSONObject().put("chat_id",selected).put("request_id",dev.winglet.wear.WearCrypto.id()).put("text",body));render()}
                        }
                    }else text("Read-only watch access",12f)
                }
                button("Open on phone",!WatchState.busy){WatchState.request(applicationContext,"open",JSONObject().put("chat_id",selected))}
            }
            button("Refresh",!WatchState.busy && !WatchState.canRetry()){
                composer?.clearFocus();WatchState.request(applicationContext,"read",if(selected.isEmpty())JSONObject() else JSONObject().put("chat_id",selected))
            }
            if(WatchState.canRetry())button("Retry the same reply",!WatchState.busy){composer?.clearFocus();WatchState.retrySend(applicationContext)}
            button("Unlink watch"){text("Remove access on this watch?");button("Confirm unlink"){WatchState.unlink(applicationContext)}}
        }
        if(WatchState.notice.isNotEmpty())text(WatchState.notice,13f,true)
        if(WatchState.error.isNotEmpty())text(WatchState.error,13f)
        button("Licenses"){licenses=true;render()}
        text("Voice uses your watch’s selected speech provider. No wake word or background recording.",11f)
    }
    @Deprecated("Platform activity result retained for this small native screen")
    override fun onActivityResult(requestCode:Int,resultCode:Int,data:Intent?){
        super.onActivityResult(requestCode,resultCode,data)
        if(requestCode==17){
            if(resultCode==RESULT_OK && voiceChat.isNotEmpty()){
                selected=voiceChat;draft=data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.take(2000).orEmpty()
            };voiceChat=""
        }
    }
}
