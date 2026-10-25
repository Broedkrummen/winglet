package expo.modules.wingletphonetools

import android.Manifest
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ContentUris
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Looper
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.round

/** Restricted reads only. No identifiers, background service, exported activity or new disk cache. */
class WingletPhoneToolsModule : Module() {
  private val running = ConcurrentHashMap<String, Job>()
  private val signals = ConcurrentHashMap<String, CancellationSignal>()
  @Volatile private var foreground = true
  private val context: Context get() = appContext.reactContext ?: throw CodedException("Phone unavailable")
  private fun permissions(tool: String): Array<String> = when (tool) {
    "phone_location" -> arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION)
    "phone_contacts" -> arrayOf(Manifest.permission.READ_CONTACTS)
    "phone_calendar" -> arrayOf(Manifest.permission.READ_CALENDAR)
    "phone_status", "phone_shared_note" -> emptyArray()
    else -> throw CodedException("Unknown phone tool")
  }
  private fun granted(permission: String) = ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED
  private fun guard(tool: String, expires: Double, precise: Boolean = false) {
    val activity = appContext.currentActivity
    val keyguard = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    if (!foreground || activity == null || activity.isFinishing || keyguard.isDeviceLocked) throw CodedException("E_PHONE_LOCKED", "Phone locked or backgrounded", null)
    if (System.currentTimeMillis() >= expires) throw CodedException("E_PHONE_EXPIRED", "Phone request expired", null)
    if (permissions(tool).any { !granted(it) } || (precise && !granted(Manifest.permission.ACCESS_FINE_LOCATION))) throw CodedException("E_PHONE_PERMISSION", "Phone permission needed", null)
  }
  private fun cancelAll() { signals.values.forEach { it.cancel() }; signals.clear(); running.values.forEach { it.cancel() }; running.clear() }
  override fun definition() = ModuleDefinition {
    Name("WingletPhoneTools")
    OnActivityEntersForeground { foreground = true }
    OnActivityEntersBackground { foreground = false; cancelAll() }
    OnActivityDestroys { foreground = false; cancelAll() }
    OnDestroy { cancelAll() }
    AsyncFunction("permission") { tool: String, promise: Promise ->
      val required = permissions(tool)
      if (required.isEmpty()) promise.resolve(mapOf("granted" to true, "canAskAgain" to true))
      else Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, *required)
    }
    AsyncFunction("requestPermission") { tool: String, promise: Promise ->
      val required = if (tool == "phone_location") arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION) else permissions(tool)
      if (required.isEmpty()) promise.resolve(mapOf("granted" to true, "canAskAgain" to true))
      else Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *required)
    }
    AsyncFunction("openSettings") {
      val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }
    Function("cancel") { id: String -> signals.remove(id)?.cancel(); running.remove(id)?.cancel() }
    AsyncFunction("execute") Coroutine { id: String, tool: String, args: Map<String, Any?>, expires: Double ->
      if (!Regex("^[a-f0-9]{32}$").matches(id) || expires > System.currentTimeMillis() + 121000) throw CodedException("Invalid phone request")
      val precise = args["precise"] == true
      guard(tool, expires, precise)
      val job = currentCoroutineContext().job
      if (running.putIfAbsent(id, job) != null) throw CodedException("Duplicate phone request")
      val signal = CancellationSignal()
      signals[id] = signal
      try {
        val answer: Map<String, Any> = withTimeout(15000) {
          withContext(Dispatchers.IO) {
            guard(tool, expires, precise)
            when (tool) {
              "phone_status" -> { require(args.isEmpty()); status() }
              "phone_location" -> { require(args.keys == setOf("precise")); location(precise) }
              "phone_contacts" -> { require(args.keys == setOf("query")); contacts(args["query"] as? String ?: "", signal) }
              "phone_calendar" -> { require(args.keys == setOf("start_ms", "end_ms")); calendar((args["start_ms"] as? Number)?.toLong() ?: 0, (args["end_ms"] as? Number)?.toLong() ?: 0, signal) }
              else -> throw CodedException("Unsupported phone read")
            }
          }
        }
        currentCoroutineContext().ensureActive()
        guard(tool, expires, precise)
        answer
      } finally { signals.remove(id)?.cancel(); running.remove(id, job) }
    }
  }
  private fun status(): Map<String, Any> {
    val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
    val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
    val charging = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
    val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    val network = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
    val kind = when {
      network == null -> "offline"
      network.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
      network.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile"
      else -> "other"
    }
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    return mapOf("battery" to (if (level >= 0 && scale > 0) (level*100/scale).coerceIn(0,100) else -1),
      "charging" to (charging == BatteryManager.BATTERY_STATUS_CHARGING || charging == BatteryManager.BATTERY_STATUS_FULL),
      "network" to kind, "metered" to cm.isActiveNetworkMetered,
      "dnd" to (nm.currentInterruptionFilter != NotificationManager.INTERRUPTION_FILTER_ALL),
      "model" to Build.MODEL.take(120), "android" to Build.VERSION.RELEASE.take(40))
  }
  private suspend fun location(precise: Boolean): Map<String, Any> {
    val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
    val provider = if (precise && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER
      else if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) LocationManager.NETWORK_PROVIDER
      else if (manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) LocationManager.GPS_PROVIDER else throw CodedException("Location is off")
    val fix = withTimeout(10000) { suspendCancellableCoroutine<Location> { continuation ->
      if (Build.VERSION.SDK_INT >= 30) {
        val signal = CancellationSignal()
        continuation.invokeOnCancellation { signal.cancel() }
        manager.getCurrentLocation(provider, signal, ContextCompat.getMainExecutor(context)) { value ->
          if (continuation.isActive) {
            if (value != null) continuation.resume(value) else continuation.resumeWithException(CodedException("Location unavailable"))
          }
        }
      } else {
        val listener = object : LocationListener {
          override fun onLocationChanged(value: Location) {
            manager.removeUpdates(this)
            if (continuation.isActive) continuation.resume(value)
          }
          @Deprecated("Legacy provider callback") override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
          override fun onProviderEnabled(provider: String) {}
          override fun onProviderDisabled(provider: String) {}
        }
        continuation.invokeOnCancellation { manager.removeUpdates(listener) }
        @Suppress("DEPRECATION") manager.requestSingleUpdate(provider, listener, Looper.getMainLooper())
      }
    } }
    return mapOf("latitude" to (if (precise) fix.latitude else round(fix.latitude*100)/100),
      "longitude" to (if (precise) fix.longitude else round(fix.longitude*100)/100),
      "accuracy" to (if (precise) fix.accuracy.toDouble() else maxOf(1500.0, fix.accuracy.toDouble())))
  }
  private suspend fun contacts(query: String, signal: CancellationSignal): Map<String, Any> {
    require(query.trim().length in 2..80)
    val resolver = context.contentResolver
    val out = mutableListOf<Map<String, Any>>()
    val seen = mutableSetOf<String>()
    val uri = ContactsContract.Data.CONTENT_URI.buildUpon().appendQueryParameter("limit", "100").build()
    val selection = "(${ContactsContract.Data.MIMETYPE}=? OR ${ContactsContract.Data.MIMETYPE}=? OR ${ContactsContract.Data.MIMETYPE}=?) AND (instr(lower(${ContactsContract.Data.DISPLAY_NAME_PRIMARY}),lower(?))>0 OR instr(lower(${ContactsContract.Data.DATA1}),lower(?))>0)"
    val selectionArgs = arrayOf(ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE, ContactsContract.CommonDataKinds.Email.CONTENT_ITEM_TYPE, query.trim(), query.trim())
    resolver.query(uri, arrayOf(ContactsContract.Data.CONTACT_ID, ContactsContract.Data.DISPLAY_NAME_PRIMARY), selection, selectionArgs, ContactsContract.Data.DISPLAY_NAME_PRIMARY + " ASC", signal)?.use { rows ->
      var candidates = 0
      while (out.size < 5 && candidates < 100 && rows.moveToNext()) {
        candidates += 1
        currentCoroutineContext().ensureActive()
        val contactId = rows.getString(0)
        if (!seen.add(contactId)) continue
        val phones = mutableListOf<String>(); val emails = mutableListOf<String>()
        resolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER), ContactsContract.CommonDataKinds.Phone.CONTACT_ID + "=?", arrayOf(contactId), null, signal)?.use { fields ->
          while (phones.size < 3 && fields.moveToNext()) phones.add((fields.getString(0) ?: "").take(254))
        }
        resolver.query(ContactsContract.CommonDataKinds.Email.CONTENT_URI, arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS), ContactsContract.CommonDataKinds.Email.CONTACT_ID + "=?", arrayOf(contactId), null, signal)?.use { fields ->
          while (emails.size < 3 && fields.moveToNext()) emails.add((fields.getString(0) ?: "").take(254))
        }
        out.add(mapOf("name" to (rows.getString(1) ?: "").take(200), "phones" to phones, "emails" to emails))
      }
    }
    return mapOf("contacts" to out)
  }
  private suspend fun calendar(start: Long, end: Long, signal: CancellationSignal): Map<String, Any> {
    require(start >= 0 && end > start && end <= 4102444800000 && end-start <= 31L*86400000)
    val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
    ContentUris.appendId(builder,start); ContentUris.appendId(builder,end)
    val out = mutableListOf<Map<String, Any>>()
    val projection = arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.ALL_DAY, CalendarContract.Instances.CALENDAR_DISPLAY_NAME)
    context.contentResolver.query(builder.build(), projection, null, null, CalendarContract.Instances.BEGIN + " ASC", signal)?.use { rows ->
      while (out.size < 50 && rows.moveToNext()) {
        currentCoroutineContext().ensureActive()
        val a=rows.getLong(1); val b=rows.getLong(2)
        if (a < end && b > start && b > a) out.add(mapOf("title" to (rows.getString(0) ?: "").take(300), "start_ms" to a, "end_ms" to b, "all_day" to (rows.getInt(3) != 0), "calendar" to (rows.getString(4) ?: "").take(200)))
      }
    }
    return mapOf("events" to out)
  }
}
