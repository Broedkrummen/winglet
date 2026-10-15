/** What a voice note needs from the phone, so the order of things can be tested without one. */
export type VoiceDeps = {
  permission: () => Promise<boolean>;
  /** Get the recorder ready and recording. */
  begin: () => Promise<void>;
  /** Stop recording; the file, if there is one. */
  stop: () => Promise<string | null>;
  now: () => number;
  started: () => void;
  denied: () => void;
  tooShort: () => void;
  failed: () => void;
  send: (uri: string) => void;
};

const MIN_MS = 600;

/**
 * One hold-to-talk at a time. Getting the recorder ready takes a moment (and the first time, a permission
 * prompt), so letting go can come before recording has started: then it stops as soon as it starts, and
 * nothing is sent. Otherwise a recorder nobody is holding would keep listening.
 */
export function voiceSession(d: VoiceDeps) {
  let holding = false;
  let cancelled = false;
  let recording = false;
  let startedAt = 0;

  return {
    async start() {
      holding = true;
      cancelled = false;
      try {
        if (!(await d.permission())) {
          holding = false;
          d.denied();
          return;
        }
        if (!holding) return; // let go during the prompt
        await d.begin();
        if (!holding) {
          await d.stop();
          if (!cancelled) d.tooShort();
          return;
        }
        recording = true;
        startedAt = d.now();
        d.started();
      } catch {
        holding = false;
        await d.stop().catch(() => null);
        d.failed();
      }
    },

    async finish(cancel: boolean) {
      holding = false;
      cancelled = cancel;
      if (!recording) return; // still getting ready: start() stops it
      recording = false;
      const held = d.now() - startedAt;
      const uri = await d.stop();
      if (cancel || held < MIN_MS || !uri) {
        if (!cancel && held < MIN_MS) d.tooShort();
        return;
      }
      d.send(uri);
    },
  };
}
