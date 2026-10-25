package expo.modules.wingletvoice

import android.Manifest
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

/** Foreground-only system speech. Never creates a network recognizer or downloads language data. */
class WingletVoiceModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val cancelled = LinkedHashSet<String>()
  @Volatile private var destroyed = false
  @Volatile private var background = false
  private val pendingSpeech = mutableSetOf<String>()
  private var manager: AudioManager? = null
  private var recognition: Pair<String, SpeechRecognizer>? = null
  private var speaking: String? = null
  private var tts: TextToSpeech? = null
  private var ttsStarted = false
  private var ttsReady = false
  private val ttsWaiters = mutableListOf<(TextToSpeech?) -> Unit>()
  private var focus: AudioFocusRequest? = null
  private var focusId: String? = null
  private var routeCallback: AudioDeviceCallback? = null
  private var routeSignature = ""
  private val context: Context get() = appContext.reactContext ?: throw CodedException("Speech context unavailable")
  private val audio: AudioManager get() = manager ?: (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).also { manager = it }
  private fun locale(tag: String) = if (tag.isBlank()) Locale.getDefault() else Locale.forLanguageTag(tag)
  private fun guard(id: String) {
    val activity = appContext.currentActivity
    val resumed = (activity as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.RESUMED) == true
    val locked = (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isDeviceLocked
    if (destroyed || background || !resumed || activity == null || activity.isFinishing || locked)
      throw CodedException("Speech paused: phone locked or backgrounded. Tap to continue.")
    if (id in cancelled) throw CodedException("Cancelled")
    if (!Regex("^[A-Za-z0-9:_-]{8,96}$").matches(id)) throw CodedException("Invalid speech request")
  }
  private fun remember(id: String) {
    cancelled.add(id)
    while (cancelled.size > 64) cancelled.remove(cancelled.first())
  }
  private fun event(channel: String, id: String, kind: String, text: String = "", level: Double = 0.0) {
    if (!destroyed) sendEvent(channel, mapOf("id" to id, "kind" to kind, "text" to text.take(8000), "level" to level))
  }
  private fun releaseFocus(id: String) {
    if (focusId != id) return
    if (Build.VERSION.SDK_INT >= 26) focus?.let { audio.abandonAudioFocusRequest(it) }
    focus = null; focusId = null
  }
  private fun claimFocus(id: String) {
    if (Build.VERSION.SDK_INT < 26) throw CodedException("Device speech requires Android 8 or later.")
    focusId?.let { releaseFocus(it) }
    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
      .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
      .setAcceptsDelayedFocusGain(false)
      .setOnAudioFocusChangeListener({ change ->
        if (change < 0) main.post {
          if (focusId == id) { endRecognition(id, "error", "Audio interrupted. Tap to continue."); endSpeech(id, "error", "Audio interrupted. Tap to continue.") }
        }
      }, main).build()
    focus = request; focusId = id
    if (audio.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
      releaseFocus(id); throw CodedException("Audio focus unavailable. Tap to try again.")
    }
  }
  private fun routes() = audio.getDevices(AudioManager.GET_DEVICES_ALL).map { it.id }.sorted().joinToString(",")
  private fun watchRoutes() {
    if (routeCallback != null) return
    routeSignature = routes()
    val callback = object : AudioDeviceCallback() {
      private fun changed() {
        val next = routes()
        if (next != routeSignature) {
          routeSignature = next
          recognition?.first?.let { endRecognition(it, "error", "Audio route changed. Tap to continue.") }
          speaking?.let { endSpeech(it, "error", "Audio route changed. Tap to continue.") }
        }
      }
      override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = changed()
      override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = changed()
    }
    routeCallback = callback
    audio.registerAudioDeviceCallback(callback, main)
  }
  private fun authorized(id: String, microphone: Boolean): Boolean = try {
    guard(id)
    !microphone || ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
  } catch (_: Exception) { false }
  private fun endRecognition(id: String, kind: String, text: String = "") {
    val run = recognition ?: return
    if (run.first != id) return
    recognition = null
    try { run.second.cancel() } catch (_: Exception) {}
    try { run.second.destroy() } catch (_: Exception) {}
    releaseFocus(id)
    if (kind == "final" && !authorized(id, true)) event("recognition", id, "error", "Speech interrupted or permission changed. Tap to continue.")
    else event("recognition", id, kind, text)
  }
  private fun endSpeech(id: String, kind: String, text: String = "") {
    if (speaking != id) return
    speaking = null
    try { tts?.stop() } catch (_: Exception) {}
    releaseFocus(id)
    if (kind == "done" && !authorized(id, false)) event("synthesis", id, "error", "Phone locked or backgrounded. Tap to continue.")
    else event("synthesis", id, kind, text)
  }
  private fun cancelAll(reason: String) {
    pendingSpeech.forEach { remember(it) }
    recognition?.first?.let { remember(it); endRecognition(it, "error", reason) }
    speaking?.let { remember(it); endSpeech(it, "error", reason) }
  }
  private fun flushTts(engine: TextToSpeech?) {
    val waiters = ttsWaiters.toList(); ttsWaiters.clear()
    waiters.forEach { it(engine) }
  }
  private fun withTts(callback: (TextToSpeech?) -> Unit) {
    if (destroyed) { callback(null); return }
    if (ttsStarted) {
      if (ttsReady) callback(tts)
      else if (tts == null) callback(null)
      else if (ttsWaiters.size < 16) ttsWaiters.add(callback)
      else callback(null)
      return
    }
    ttsStarted = true
    ttsWaiters.add(callback)
    try {
      tts = TextToSpeech(context) { status -> main.post {
        if (destroyed) { tts?.shutdown(); tts = null; flushTts(null) }
        else if (tts == null) { flushTts(null) }
        else if (status == TextToSpeech.SUCCESS) {
          ttsReady = true
          tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) { main.post { if (id != null) endSpeech(id, "done") } }
            @Deprecated("Android compatibility callback")
            override fun onError(id: String?) { main.post { if (id != null) endSpeech(id, "error", "Device speech failed. Choose Server or retry.") } }
            override fun onError(id: String?, code: Int) = onError(id)
            override fun onStop(id: String?, interrupted: Boolean) { main.post { if (id != null) endSpeech(id, "error", "Device speech stopped. Tap to continue.") } }
          })
          flushTts(tts)
        } else { tts?.shutdown(); tts = null; flushTts(null) }
      } }
      main.postDelayed({
        if (!ttsReady) { tts?.shutdown(); tts = null; flushTts(null) }
      }, 7000)
    } catch (_: Exception) { tts = null; flushTts(null) }
  }
  private fun offlineVoice(engine: TextToSpeech, language: Locale): Voice? =
    engine.voices?.filter {
      !it.isNetworkConnectionRequired && it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true &&
        it.locale.language == language.language && engine.isLanguageAvailable(it.locale) >= TextToSpeech.LANG_AVAILABLE
    }?.sortedWith(compareByDescending<Voice> { it.locale.country == language.country }.thenBy { it.name })?.firstOrNull()

  override fun definition() = ModuleDefinition {
    Name("WingletVoice")
    Events("recognition", "synthesis")
    OnActivityEntersForeground { background = false }
    OnActivityEntersBackground { background = true; main.post { cancelAll("Phone backgrounded. Tap to continue.") } }
    OnActivityDestroys { background = true; main.post { cancelAll("Activity closed. Tap to continue.") } }
    OnDestroy {
      main.post {
        destroyed = true
        cancelAll("Speech module closed.")
        routeCallback?.let { audio.unregisterAudioDeviceCallback(it) }; routeCallback = null
        tts?.shutdown(); tts = null; flushTts(null)
      }
    }
    AsyncFunction("capabilities") { tag: String, promise: Promise ->
      val language = locale(tag)
      val available = Build.VERSION.SDK_INT >= 31 && try { SpeechRecognizer.isOnDeviceRecognitionAvailable(context) } catch (_: Exception) { false }
      withTts { engine ->
        val voice = if (engine != null && Build.VERSION.SDK_INT >= 26) offlineVoice(engine, language) else null
        promise.resolve(mapOf("listen" to available, "speak" to (voice != null), "language" to (voice?.locale?.toLanguageTag() ?: language.toLanguageTag()),
          "voice" to (voice?.name?.take(160) ?: ""), "engine" to (engine?.defaultEngine?.take(160) ?: ""),
          "listenReason" to if (available) "Android on-device recognition (" + language.toLanguageTag() + "); an installed language pack is required." else "Requires Android 12 or later and an available on-device recognizer.",
          "speakReason" to if (voice != null) "Installed voice; network connection is not required." else "No installed offline voice for this language. Choose Server."))
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("startRecognition") { id: String, tag: String ->
      guard(id)
      if (Build.VERSION.SDK_INT < 31 || !SpeechRecognizer.isOnDeviceRecognitionAvailable(context))
        throw CodedException("On-device recognition unavailable. Choose Server.")
      if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
        throw CodedException("Microphone permission denied. Allow microphone access in Settings.")
      cancelAll("Another speech request started.")
      watchRoutes(); claimFocus(id)
      try {
        val recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        recognition = id to recognizer
        recognizer.setRecognitionListener(object : RecognitionListener {
          private fun current() = !destroyed && !background && recognition?.first == id
          private fun allowed(): Boolean {
            if (!current()) return false
            if (authorized(id, true)) return true
            endRecognition(id, "error", "Speech interrupted or permission changed. Tap to continue.")
            return false
          }
          private fun text(bundle: Bundle?) = bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty().take(8000)
          override fun onReadyForSpeech(params: Bundle?) { if (allowed()) event("recognition", id, "ready") }
          override fun onBeginningOfSpeech() {}
          override fun onRmsChanged(rmsdB: Float) { if (current()) event("recognition", id, "level", level = ((rmsdB + 2) / 12.0).coerceIn(0.0, 1.0)) }
          override fun onBufferReceived(buffer: ByteArray?) {}
          override fun onEndOfSpeech() {}
          override fun onPartialResults(results: Bundle?) { if (allowed()) event("recognition", id, "partial", text(results)) }
          override fun onResults(results: Bundle?) { if (allowed()) endRecognition(id, "final", text(results)) }
          override fun onError(code: Int) {
            if (!current()) return
            when (code) {
              SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> endRecognition(id, "final")
              SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED, SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ->
                endRecognition(id, "error", "On-device language pack unavailable. Choose Server or install a language in system settings.")
              SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> endRecognition(id, "error", "Microphone permission denied. Allow microphone access in Settings.")
              else -> endRecognition(id, "error", "On-device recognition failed (" + code + "). Choose Server or retry.")
            }
          }
          override fun onEvent(type: Int, params: Bundle?) {}
        })
        recognizer.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
          .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
          .putExtra(RecognizerIntent.EXTRA_LANGUAGE, locale(tag).toLanguageTag())
          .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
          .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
          .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1))
      } catch (_: Exception) {
        endRecognition(id, "error", "On-device recognition could not start. Choose Server.")
        releaseFocus(id)
        throw CodedException("On-device recognition could not start. Choose Server.")
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("finishRecognition") { id: String -> if (recognition?.first == id) recognition?.second?.stopListening() }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelRecognition") { id: String ->
      remember(id); endRecognition(id, "error", "Cancelled")
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("speak") { id: String, text: String, tag: String, promise: Promise ->
      try { guard(id) } catch (error: CodedException) { promise.reject(error); return@AsyncFunction }
      if (text.isBlank() || text.length > TextToSpeech.getMaxSpeechInputLength()) {
        promise.reject("E_SPEECH_LENGTH", "Device speech text is empty or too long.", null); return@AsyncFunction
      }
      if (pendingSpeech.size >= 8) { promise.reject("E_SPEECH_BUSY", "Device speech is busy.", null); return@AsyncFunction }
      pendingSpeech.add(id)
      withTts { engine ->
        pendingSpeech.remove(id)
        try {
          guard(id)
          val readyEngine = engine ?: throw CodedException("Device speech engine unavailable. Choose Server.")
          val voice = offlineVoice(readyEngine, locale(tag)) ?: throw CodedException("No installed offline voice for this language. Choose Server.")
          cancelAll("Another speech request started.")
          watchRoutes(); claimFocus(id)
          if (readyEngine.setLanguage(voice.locale) < TextToSpeech.LANG_AVAILABLE || readyEngine.setVoice(voice) != TextToSpeech.SUCCESS ||
            readyEngine.voice?.name != voice.name || readyEngine.voice?.isNetworkConnectionRequired != false)
            throw CodedException("The offline voice could not be selected. Choose Server.")
          readyEngine.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          speaking = id
          if (readyEngine.speak(text, TextToSpeech.QUEUE_FLUSH, Bundle(), id) != TextToSpeech.SUCCESS)
            throw CodedException("Device speech could not start. Choose Server.")
          promise.resolve()
        } catch (error: Exception) {
          endSpeech(id, "error", "Device speech unavailable. Choose Server."); releaseFocus(id)
          promise.reject("E_DEVICE_SPEECH", (error as? CodedException)?.message ?: "Device speech unavailable. Choose Server.", null)
        }
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelSpeech") { id: String ->
      remember(id); pendingSpeech.remove(id); endSpeech(id, "error", "Cancelled")
    }.runOnQueue(Queues.MAIN)
  }
}
