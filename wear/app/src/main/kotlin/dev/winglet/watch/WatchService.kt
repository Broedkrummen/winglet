package dev.winglet.watch
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
class WatchService:WearableListenerService(){
    override fun onMessageReceived(event:MessageEvent){WatchState.receive(applicationContext,event)}
}
