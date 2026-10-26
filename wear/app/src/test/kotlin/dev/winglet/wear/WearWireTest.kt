package dev.winglet.wear
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import com.google.crypto.tink.subtle.X25519
import com.google.crypto.tink.subtle.Hkdf

class WearWireTest {
    private val key=WearCrypto.b64(ByteArray(32){it.toByte()})
    private fun sender()=JSONObject().put("association","ab".repeat(16)).put("secret",key).put("peer","phone")
    private fun receiver()=sender().put("peer","watch")
    private fun rejected(work:()->Unit){try{work();fail("Expected authentication failure")}catch(e:Exception){}}
    @Test fun coldReceiptStateSupportsLostAcknowledgementsWithoutChangingReplyIdentity(){
        val id="cd".repeat(16);val body=JSONObject().put("op","send").put("data",JSONObject().put("text","Hello"))
        val first=WearReceipts(JSONObject(),100)
        assertEquals("new",first.claim(id,body).mode)
        val cold=WearReceipts(JSONObject(first.value.toString()),110)
        assertEquals("retry",cold.claim(id,body).mode)
        assertEquals("conflict",cold.claim(id,JSONObject().put("op","send").put("data",JSONObject().put("text","Changed"))).mode)
        cold.accept(id,JSONObject().put("status","accepted").put("message_id","server-message"))
        val afterLostAck=WearReceipts(JSONObject(cold.value.toString()),120).claim(id,body)
        assertEquals("cached",afterLostAck.mode);assertEquals("server-message",afterLostAck.result?.getString("message_id"))
        assertFalse(cold.value.toString().contains("Hello"))
        assertEquals("new",WearReceipts(JSONObject(cold.value.toString()),281).claim(id,body).mode)
    }
    @Test fun receiptCapacityFailsClosedUntilOldEntriesExpire(){
        val book=WearReceipts(JSONObject(),100)
        repeat(128){assertEquals("new",book.claim(it.toString(16).padStart(32,'0'),JSONObject()).mode)}
        assertEquals("full",book.claim("ff".repeat(16),JSONObject()).mode)
        assertEquals("new",WearReceipts(book.value,281).claim("ff".repeat(16),JSONObject()).mode)
    }
    @Test fun aadBindsPeerPurposeAndRequest(){
        val bytes=WearWire.encode(sender(),"watch","phone","request","cd".repeat(16),JSONObject().put("op","read"))
        assertEquals("read",WearWire.decode(receiver(),"watch","phone","request",bytes).second.getString("op"))
        rejected{WearWire.decode(receiver(),"watch","other","request",bytes)}
        rejected{WearWire.decode(receiver(),"watch","phone","reply",bytes)}
        rejected{WearWire.decode(receiver().put("association","ee".repeat(16)),"watch","phone","request",bytes)}
        val tampered=JSONObject(String(bytes)).put("id","ef".repeat(16)).toString().toByteArray()
        rejected{WearWire.decode(receiver(),"watch","phone","request",tampered)}
    }
    @Test fun expiryAndNonCanonicalBase64AreRejected(){
        assertTrue(WearPolicy.fresh(100,160,110));assertFalse(WearPolicy.fresh(100,160,160))
        assertFalse(WearPolicy.fresh(150,160,110));assertFalse(WearPolicy.fresh(100,221,110))
        rejected{WearCrypto.raw("AQ==")}
        val bytes=WearWire.encode(sender(),"watch","phone","request","cd".repeat(16),JSONObject(),-1)
        rejected{WearWire.decode(receiver(),"watch","phone","request",bytes)}
    }
    @Test fun pythonSealedVectorOpensWithTink(){
        val private=WearCrypto.raw("AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA")
        val packet=WearCrypto.raw("GksctD90Ul7SEEpNgHnPVkeN8GjjoS68zFrJr_2zYzlkI0RDJGMEg-SjxMNTic48O_3w9FiupqG6j529BLRg3s7txh8khszAuCAUU1GrPvyPPvTiFp77HiHOACSa1skKI6tviC6jV2qhN98id9dkSSPT-DnLp7pJrHd3X0MGZR4KzQ")
        val public=X25519.publicFromPrivate(private);val ephemeral=packet.copyOfRange(0,32)
        val shared=X25519.computeSharedSecret(private,ephemeral)
        val derived=Hkdf.computeHkdf("HmacSha256",shared,ephemeral+public,"winglet-seal-v1".toByteArray(),32)
        val plain=WearCrypto.decrypt(derived,packet.copyOfRange(32,44),packet.copyOfRange(44,packet.size),"winglet-seal-v1|pair|dev-1".toByteArray())
        assertEquals("ABCD2345",JSONObject(String(plain)).getString("code"))
        rejected{WearCrypto.decrypt(derived,packet.copyOfRange(32,44),packet.copyOfRange(44,packet.size),"winglet-seal-v1|wear-relay|dev-1".toByteArray())}
    }
}
