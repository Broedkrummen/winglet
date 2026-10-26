package expo.modules.wingletassistant

import android.app.assist.AssistContent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession
import android.service.voice.VoiceInteractionSessionService
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.text.InputFilter
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import java.util.ArrayDeque
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

class WingletAssistService : VoiceInteractionService() {
  override fun onReady(){super.onReady();setDisabledShowContext(VoiceInteractionSession.SHOW_WITH_SCREENSHOT)}
  override fun onShutdown(){AssistantRuntime.vault.clearAll();super.onShutdown()}
}
class WingletAssistSessionService : VoiceInteractionSessionService() {
  override fun onNewSession(args: Bundle?): VoiceInteractionSession=WingletAssistSession(this)
}
/** Required for the role declaration; never opens a microphone. */
class WingletAssistantRecognizer : RecognitionService() {
  override fun onStartListening(intent: Intent?, listener: Callback){listener.error(SpeechRecognizer.ERROR_CLIENT)}
  override fun onCancel(listener: Callback)=Unit
  override fun onStopListening(listener: Callback)=Unit
}
class WingletAssistSession(private val host: Context) : VoiceInteractionSession(host) {
  private var invocation=""
  private var handedOff=false
  private var shown=false
  private var ending=false
  private lateinit var question: EditText
  private lateinit var caption: TextView
  private val main=Handler(Looper.getMainLooper())
  private val worker=ThreadPoolExecutor(1,1,5,TimeUnit.SECONDS,ArrayBlockingQueue<Runnable>(1),ThreadPoolExecutor.DiscardOldestPolicy())
  override fun onCreateContentView(): View {
    window.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    val box=LinearLayout(host).apply{orientation=LinearLayout.VERTICAL;setPadding(32,24,32,32);setBackgroundColor(0xff17171d.toInt())}
    box.addView(TextView(host).apply{text="Winglet";textSize=22f;setTextColor(0xffffffff.toInt())})
    caption=TextView(host).apply{text="Your question stays here until you continue.";setTextColor(0xffd0cce0.toInt());setPadding(0,12,0,16)}
    box.addView(caption)
    question=EditText(host).apply{
      hint="Ask your agent";setTextColor(0xffffffff.toInt());setHintTextColor(0xffaaa6b8.toInt())
      minLines=2;maxLines=5;filters=arrayOf(InputFilter.LengthFilter(4000))
    }
    box.addView(question)
    box.addView(Button(host).apply{
      text="Continue in Winglet";contentDescription="Review question and screen context in Winglet"
      setOnClickListener{
        if(AssistantRuntime.locked(host) || !AssistantRuntime.role(host)){cancel();return@setOnClickListener}
        if(!AssistantRuntime.vault.handoff(invocation,question.text.toString())){cancel();return@setOnClickListener}
        val scheme=if(host.packageName.endsWith(".dev"))"winglet-dev" else "winglet"
        val intent=Intent(Intent.ACTION_VIEW,Uri.parse("$scheme://assistant?invocation=$invocation")).setPackage(host.packageName)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        try{handedOff=true;startAssistantActivity(intent);end(false)}
        catch(_:Exception){handedOff=false;caption.text="Could not open Winglet. Try opening the app first."}
      }
    })
    box.addView(Button(host).apply{text="Dismiss";setOnClickListener{cancel()}})
    return box
  }
  override fun onShow(args: Bundle?, showFlags: Int) {
    super.onShow(args,showFlags)
    if(shown){cancel();return};shown=true
    if(AssistantRuntime.locked(host) || !AssistantRuntime.role(host)){cancel();return}
    handedOff=false;invocation=AssistantRuntime.vault.begin(AssistantRuntime.serverId,AssistantRuntime.chatId)
    if(::question.isInitialized)question.setText("")
    if(::caption.isInitialized)caption.text=if(AssistantRuntime.privateLocked())"Open Winglet to unlock and choose a bot." else "Review your question in Winglet."
    val id=invocation;main.postDelayed({AssistantRuntime.vault.clear(id)},90_000)
  }
  /** The compatibility callback represents the focused activity; secondary windows are ignored. */
  @Suppress("DEPRECATION")
  override fun onHandleAssist(data: Bundle?, structure: AssistStructure?, content: AssistContent?) {
    if(structure==null || AssistantRuntime.privateLocked() || AssistantRuntime.locked(host))return
    val id=invocation
    worker.execute{
      val text=try{readScreen(structure)}catch(_:Exception){""}
      if(AssistantRuntime.role(host) && !AssistantRuntime.privateLocked() && !AssistantRuntime.locked(host))
        AssistantRuntime.vault.context(id,text,structure.activityComponent?.packageName ?: "")
      main.post{if(invocation==id && !handedOff && text.isNotBlank() && ::caption.isInitialized)caption.text="Screen text is available for your review in Winglet."}
    }
  }
  override fun onHandleScreenshot(screenshot: Bitmap?){/* Screenshots are disabled and never retained. */}
  private fun readScreen(structure: AssistStructure): String {
    val queue=ArrayDeque<AssistStructure.ViewNode>()
    for(i in 0 until minOf(structure.windowNodeCount,4))queue.add(structure.getWindowNodeAt(i).rootViewNode)
    val out=StringBuilder();var visited=0
    while(queue.isNotEmpty() && visited++<256 && out.length<6000){
      val node=queue.removeFirst()
      if(node.isAssistBlocked || node.visibility!=View.VISIBLE || node.inputType!=0 || node.className?.contains("EditText")==true)continue
      val text=node.text?.toString()?.trim().orEmpty()
      if(text.isNotBlank())out.append(text.take(6000-out.length)).append('\n')
      for(i in 0 until minOf(node.childCount,32))if(queue.size<256)queue.add(node.getChildAt(i))
    }
    return out.toString().take(6000).trim()
  }
  private fun end(clear: Boolean){if(ending)return;ending=true;if(clear)AssistantRuntime.vault.clear(invocation);finish()}
  private fun cancel(){end(true)}
  override fun onHide(){if(!handedOff)end(true);super.onHide()}
  override fun onLockscreenShown(){cancel();super.onLockscreenShown()}
  override fun onDestroy(){if(!handedOff)AssistantRuntime.vault.clear(invocation);worker.shutdownNow();super.onDestroy()}
}

