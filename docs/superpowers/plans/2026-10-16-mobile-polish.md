# Mobile polish implementation

1. Record baseline phone screenshots and audit chat, model selection, sheets and recording lifecycle.
2. Add regression coverage and make voice recording serial, cancellable and recoverable.
3. Add model display/search helpers; move model selection to the header; render accessible rows and immediate selection feedback.
4. Constrain sheets, isolate their drag handle, and allocate the tab-bar recorder only during holds. Move pet frame timing to the UI thread.
5. Run app tests/typecheck, inspect the changed flows on the phone, verify web export, fix issues found and record results.
6. Incorporate the user's density follow-up: inspect installed reference apps, tighten model/chat layouts, align approval cards, add visible response actions and device-local pin/archive/restore, and verify persistence and recovery on the phone.

Spec: `docs/superpowers/specs/2026-10-16-mobile-polish-design.md`. Continue on `feat/pets-presence`; leave unrelated untracked review documents alone. No push or PR without the user's requested branch-finishing decision. Any commits use VIKASRP24 without generated/coauthor trailers.
