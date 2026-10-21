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
  let active: { holding: boolean; cancelled: boolean; recording: boolean; startedAt: number } | null = null;

  return {
    async start() {
      // Permission, preparation and stopping own the recorder too. A rapid second hold must never
      // overwrite the release/cancellation belonging to the first one.
      if (active) return;
      const run = { holding: true, cancelled: false, recording: false, startedAt: 0 };
      active = run;
      try {
        if (!(await d.permission())) {
          if (run.holding) d.denied();
          return;
        }
        if (!run.holding) return; // let go during the prompt
        await d.begin();
        if (!run.holding) {
          await d.stop();
          if (!run.cancelled) d.tooShort();
          return;
        }
        run.recording = true;
        run.startedAt = d.now();
        d.started();
      } catch {
        run.recording = false;
        await d.stop().catch(() => null);
        d.failed();
      } finally {
        if (!run.recording && active === run) active = null;
      }
    },

    async finish(cancel: boolean) {
      const run = active;
      if (!run) return;
      run.holding = false;
      run.cancelled ||= cancel;
      if (!run.recording) return; // getting ready or already stopping
      run.recording = false;
      const held = d.now() - run.startedAt;
      try {
        const uri = await d.stop();
        if (run.cancelled || held < MIN_MS || !uri) {
          if (!run.cancelled && held < MIN_MS) d.tooShort();
          return;
        }
        d.send(uri);
      } catch {
        d.failed();
      } finally {
        if (active === run) active = null;
      }
    },
  };
}
