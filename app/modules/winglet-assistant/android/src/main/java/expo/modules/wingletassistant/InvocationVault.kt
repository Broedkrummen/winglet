package expo.modules.wingletassistant

/** Pure in-memory lease state; no persistence or intent data. */
internal class InvocationVault(private val clock: () -> Long, private val nonce: () -> String, private val ttlMs: Long = 90_000L) {
  data class Entry(val id: String, val expires: Long, val serverId: String, val chatId: String,
    val question: String = "", val context: String = "", val source: String = "",
    val handoff: Boolean = false, val bound: List<String>? = null)
  private var entry: Entry? = null
  @Synchronized fun begin(serverId: String, chatId: String): String {
    val id=nonce();require(Regex("^[a-f0-9]{32}$").matches(id))
    entry=Entry(id,clock()+ttlMs,serverId.take(160),chatId.take(160));return id
  }
  @Synchronized fun read(id: String): Entry? {
    val e=entry ?: return null
    if(clock()>=e.expires){entry=null;return null}
    return e.takeIf{it.id==id}
  }
  @Synchronized fun context(id: String, text: String, source: String) {
    val e=read(id) ?: return;if(e.handoff)return
    entry=e.copy(context=text.take(6000),source=source.take(160))
  }
  @Synchronized fun handoff(id: String, question: String): Boolean {
    val e=read(id) ?: return false;entry=e.copy(question=question.take(4000),handoff=true);return true
  }
  @Synchronized fun bind(id: String, server: String, chat: String, request: String, digest: String): Boolean {
    val e=read(id) ?: return false;if(!e.handoff)return false;val key=listOf(server,chat,request,digest)
    if(key.any{it.isBlank() || it.length>180} || !Regex("^[a-f0-9]{64}$").matches(digest) || (e.bound!=null && e.bound!=key))return false
    entry=e.copy(bound=key);return true
  }
  @Synchronized fun clear(id: String){if(entry?.id==id)entry=null}
  @Synchronized fun clearAll(){entry=null}
}

