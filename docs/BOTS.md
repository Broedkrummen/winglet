# More than one bot

Each Hermes profile is a bot, the same as Hermes Desktop's Bots: its own persona, memory, skills, chats
and pet. Keep your main bot for everyday chat and add bots for separate jobs.

## Main bot

The app opens on your main bot (the first one paired, until you pick another under Agent → Main bot).
Home puts that bot up front with its pet and a message box, and keeps your other bots in a small row you
tap to bring forward.

## On the same server, from the phone

"Add a bot" (in the bot switcher, on Home, or under Agent) offers to create a new bot, scan a QR, or pair
with a code from another server. Creating one needs an owner phone and compatible Hermes support. It makes
a new profile the way Hermes Desktop does (your provider keys and model, never your chat-platform tokens)
and it's on the phone at once, with no new port and no pairing. Bots made in Hermes Desktop, with
`hermes profile create`, or by the agent itself show up too.

Hermes serves every profile from the one gateway once there are two of them; after the first new bot,
restart the server once (the app offers to). If you used to run a gateway per profile, fold them into one
first with `hermes gateway migrate --multiplex`.

## Teamwork

Your bots can call on each other. Say "ask Chef what's for dinner" in any chat and your bot asks Chef and
brings back the answer, the way Hermes Desktop's Bot Mode does (the message lands in Chef's "Bot Chat").
Ask your bot to make a new one ("make me a bot that plans meals") and it does, after you approve it like a
risky command. Both tools are in the "bots" toolset under Tools.

## On another server

Pair it as usual; it stacks up in the sidebar with the others. A profile can also keep its own gateway
and port:

```bash
hermes -p researcher winglet setup --port 8788
hermes -p researcher gateway run
hermes -p researcher winglet pair
```
