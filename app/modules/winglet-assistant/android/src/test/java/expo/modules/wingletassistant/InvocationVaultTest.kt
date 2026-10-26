package expo.modules.wingletassistant

import org.junit.Assert.*
import org.junit.Test

class InvocationVaultTest {
  private var now=0L
  private var sequence=0
  private fun vault()=InvocationVault({now},{(++sequence).toString(16).padStart(32,'0')})
  @Test fun forgedExpiredAndSupersededInvocationsCannotReadContext(){
    val v=vault();val first=v.begin("server","chat");v.context(first,"private","source")
    assertNull(v.read("f".repeat(32)))
    val second=v.begin("server","other")
    assertNull(v.read(first));assertNotNull(v.read(second))
    now=90_000;assertNull(v.read(second))
  }
  @Test fun contextIsBoundedAndCannotArriveAfterHandoff(){
    val v=vault();val id=v.begin("server","chat")
    v.context(id,"a".repeat(9000),"b".repeat(200))
    assertEquals(6000,v.read(id)!!.context.length);assertEquals(160,v.read(id)!!.source.length)
    assertTrue(v.handoff(id,"question"))
    v.context(id,"late different screen","other")
    assertEquals("a".repeat(6000),v.read(id)!!.context)
  }
  @Test fun oneInvocationBindsOnlyOneConversationAndRequest(){
    val v=vault();val id=v.begin("server","chat")
    val hash="a".repeat(64)
    assertFalse(v.bind(id,"server","chat","request",hash))
    assertTrue(v.handoff(id,"question"))
    assertTrue(v.bind(id,"server","chat","request",hash))
    assertTrue(v.bind(id,"server","chat","request",hash))
    assertFalse(v.bind(id,"other","chat","request",hash))
    assertFalse(v.bind(id,"server","other","request",hash))
    assertFalse(v.bind(id,"server","chat","other-request",hash))
    assertFalse(v.bind(id,"server","chat","request","b".repeat(64)))
  }
  @Test fun cancellationAndLockTeardownLeaveNoContext(){
    val v=vault();val id=v.begin("server","chat");v.context(id,"private","app")
    v.clear("unknown");assertNotNull(v.read(id))
    v.clear(id);assertNull(v.read(id))
    val next=v.begin("server","chat");v.clearAll();assertNull(v.read(next))
  }
  @Test fun questionIsBoundedAndHandoffRequiresLiveId(){
    val v=vault();val id=v.begin("server","chat")
    assertFalse(v.handoff("forged","question"));assertTrue(v.handoff(id,"q".repeat(5000)))
    assertEquals(4000,v.read(id)!!.question.length)
    now=90_001;assertFalse(v.handoff(id,"expired"))
  }
}

