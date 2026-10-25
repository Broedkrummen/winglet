# Herald routine history information architecture

Source: https://github.com/Giton22/herald at 95ca999fa48c1c9de232fe499a174900f0d25272.
Reviewed files: core/cron/Routines.kt, core/cron/CronApi.kt and ui/sessions/ScheduledPage.kt,
ScheduledViewModel.kt under shared/core and shared/ui commonMain Kotlin sources.
Winglet adapts the routine summary → bounded run list → recorded output/session information hierarchy.
Its TypeScript/Python implementation uses Winglet's authenticated plugin API and a durable mirror
of the actual pinned Hermes execution ledger; no Kotlin code is copied verbatim.

MIT License

Copyright (c) 2026 Giton22

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
