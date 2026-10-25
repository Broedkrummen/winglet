# Herald phone tools adaptation

Source: https://github.com/Giton22/herald/tree/95ca999fa48c1c9de232fe499a174900f0d25272

Adapted behavior and UI hierarchy from shared/core/src/commonMain/kotlin/dev/hermeskotlin/core/phone/PhoneToolsBridge.kt,
PhoneTool.kt and shared/ui/src/commonMain/kotlin/dev/hermeskotlin/ui/settings/PhoneToolAccess.kt,
PhoneToolsScreen.kt. Winglet uses its authenticated session, signed grants, single-socket push and a restricted read-only Android module.
No upstream source is copied verbatim. Permission repair, bounded lookup and cancellation patterns informed this implementation.

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
