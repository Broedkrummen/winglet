# Winglet design guide

How every screen in the app should look and read. When a screen disagrees with this file, the screen is wrong.

## Character

Calm, crisp and professional, in the family of ChatGPT, Claude, Linear and Apple's own apps: a near-black (or near-white)
canvas, solid surfaces one step apart, hairline borders and confident type. Polish comes from spacing, alignment and
restraint, never from effects. The pets are the one place with colour and motion of their own.

- **No gradients, glows, sheen or tinted icon circles.** The only gradients allowed are inside the pets and bot avatars.
- **Surfaces**: `bg`, then `surface` for cards and grouped lists (with a `border` hairline), `surfaceSunken` for inputs,
  search and segmented controls, `surfaceHigh` for a selected row. Floating chrome (chat header, composer, sheets) is
  near-opaque, never a see-through tint.
- **Ink and accent**: the strongest action on a screen is `ink` (the text colour as a fill: white in dark, black in light),
  so is the send button. The accent (the user's choice) marks only links, toggles, progress and focus. Your own messages
  sit in a neutral `bubble`.
- **Icons** are plain lucide line icons in `textSecondary` (or `text` when selected); colour only for state.
- **Shape**: radius 10–12 for controls and rows, 16 for cards and groups, 22 for sheets; pills only for filter chips.
- **Motion**: short fades (≈180 ms) for things arriving, critically damped springs for press feedback and sheets. No
  bobbing, pulsing or staggered cascades.
- **Type**: Inter. `display` (28 bold) for screen titles, `hero` (26 semibold) for the landing greeting, `heading` for
  bars and sheet titles, body 16.

## Words

- A screen title names the place. It does **not** get a paragraph under it. If a screen needs one sentence of
  explanation, put it as a `Footnote` under the group it explains, and keep it to one line where possible.
- A list row has a title. It gets a subtitle only when the subtitle carries **live information** (a value, a state,
  a count, a warning) or the row is a switch whose effect isn't obvious from its title. Never a description of what
  the destination page contains ("Who it is and how it talks", "Tokens and cost").
- Values go on the right (`value`), not in a subtitle.
- Sentence case everywhere. No ALL-CAPS labels. Buttons say exactly what they do ("Save", "Restart server").
- Empty states: one short line saying what will appear here, plus the action that creates it when there is one.

## Structure

- **Pushed screen** (`Screen`): a sticky top bar with a plain back arrow (and optional actions on the right), then a
  large left-aligned title that scrolls with the content. When the large title scrolls away, the small title fades
  into the top bar. Content column max 680 wide, 16 side padding.
- **Top-level views** (chat, landing): `NavigationHeader` — sidebar button (panel icon, never "⋯"), left-aligned
  title, actions on the right. "⋯" means *more options for this thing* and nothing else.
- **Groups**: `SectionHeader` (small, sentence case, secondary colour) then one `ListGroup` card of rows divided by
  inset hairlines. Don't wrap a single row in its own card unless it's alone in its section.
- **Rows**: icon (plain line icon, secondary colour, no tinted tile), title, optional value, chevron when it navigates.
  Colour an icon only for state (`iconColor` = success / warning / danger).
- **Sheets**: title is the name of what you're choosing or acting on. Actions are rows; settings (switches) never sit
  between actions — put them under a separator at the end.

## Tokens (see `app/src/lib/theme.ts`)

| | |
|---|---|
| Dark surfaces | `bg #0C0C0E`, `surface #161619`, raised/sunken `#1B1B1F`, high and bubble `#232327`, hairlines white 7% / 13% |
| Light surfaces | `bg #FAFAFA`, `surface #FFFFFF`, sunken `#F1F1F3`, bubble `#EFEFF1`, hairlines black 8% / 14% |
| Type | Inter. display 28/34 bold, hero 26/32 semibold, title 20/26, heading 16.5/22, body 16/24, callout 15/20, footnote 13/18, caption 12/16 |
| Radius | 6 / 10 / 12 / 16 / 22 / pill |
| Spacing | 4 / 8 / 12 / 16 / 24 / 32; page padding 16; section gap 28 |
| Touch | 44–48dp minimum target |

Primary buttons and the send button are a flat `ink` fill. Your message bubble is a neutral `bubble` with a 6dp corner on
its tail. No gradients or glows outside the pets.

## Chat

- Assistant replies are flat (no bubble) under a small identity line (face, name, time) shown once per group.
- Copy / reply / more actions show under the **latest** reply only; every other message gets them by long-press
  (touch) or hover (mouse).
- Gateway progress notices ("⏳ Working …", "⚡ Stopped …") are status, not conversation: one muted line.
- Tool activity collapses into a single "N steps" pill.
