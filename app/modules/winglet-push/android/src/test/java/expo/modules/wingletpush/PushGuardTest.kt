package expo.modules.wingletpush
import org.junit.Assert.*
import org.junit.Test

class PushGuardTest {
  @Test fun duplicatesSurviveRestartAndExpiryAllowsBoundedPruning(){
    var now=100L;val g=PushGuard({now});val id="a".repeat(32)
    assertTrue(g.accept(id,100,200));assertFalse(g.accept(id,100,200))
    val restart=PushGuard({now},g.snapshot());assertFalse(restart.accept(id,100,200))
    now=201;assertFalse(restart.accept(id,100,200));assertTrue(restart.accept(id,201,300))
  }
  @Test fun invalidFutureExpiredAndOversizedAgeWindowsAreRefused(){
    val g=PushGuard({100L});val id="a".repeat(32)
    for(times in listOf(161L to 200L,0L to 100L,100L to 99L,100L to 86501L,-1L to 200L))
      assertFalse(g.accept(id,times.first,times.second))
    assertFalse(g.accept("forged",100,200))
  }
  @Test fun capacityNeverEvictsLiveReplayRecords(){
    val g=PushGuard({100L},capacity=1)
    assertTrue(g.accept("a".repeat(32),100,200));assertFalse(g.accept("b".repeat(32),100,200))
    assertFalse(g.accept("a".repeat(32),100,200))
  }
}
