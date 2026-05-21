# 📚 Book Club Discord Bot

A Discord bot for book clubs with reading progress tracking, polls, and StoryGraph/Goodreads integration.

---

## Features

| Command | What it does |
|---|---|
| `/book add <url>` | Add a book via Goodreads, StoryGraph, or Amazon URL |
| `/book list` | Browse the server's full book library |
| `/book current [id]` | View or set the current book being read |
| `/book info <id>` | View details for any book |
| `/book setpages <id> <pages>` | Update total page count |
| `/book remove <id>` | Remove a book |
| `/poll start [book_ids]` | Run a reaction poll to vote for the next book |
| `/poll status` | Check live vote standings |
| `/poll close` | Close the poll and announce the winner |
| `/progress log <amount>` | Log your reading progress (`150`, `45%`, or `150/400`) |
| `/progress view [@user]` | View your or someone else's progress |
| `/progress board` | Leaderboard for the current book |
| `/profile connect` | Link your StoryGraph or Goodreads account |
| `/profile view [@user]` | View a member's reading profile |
| `/profile shelf [@user]` | Pull their Goodreads currently-reading shelf |
| `/profile disconnect` | Unlink a platform |

---

## Setup

### 1. Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → give it a name
3. Go to **Bot** → click **Add Bot**
4. Under **Token**, click **Reset Token** and copy it
5. Under **Privileged Gateway Intents**, enable:
   - ✅ **Message Content Intent**
6. Go to **OAuth2 → URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: `Send Messages`, `Embed Links`, `Add Reactions`, `Read Message History`
7. Copy the generated URL and invite the bot to your server

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_application_id_here   # Found on the General Information page
GUILD_ID=your_server_id_here         # Optional: for instant dev registration
```

### 4. Register Slash Commands

```bash
npm run deploy
```

### 5. Start the Bot

```bash
npm start

# Or for development with auto-restart:
npm run dev
```

---

## Progress Logging Formats

The `/progress log` command accepts three formats:

| Format | Example | Meaning |
|---|---|---|
| Page number | `150` | You're on page 150 (% auto-calculated if total pages known) |
| Percentage | `45%` | You're 45% through the book |
| Fraction | `150/400` | Page 150 of 400 |

---

## StoryGraph & Goodreads Integration

### StoryGraph
- No public API exists yet, so the bot stores your username and links to your profile
- Use `/profile connect platform:StoryGraph username:yourusername`
- Progress is tracked manually via `/progress log`

### Goodreads
- The official API was shut down, but **public RSS feeds still work**
- Use `/profile connect platform:Goodreads username:YOUR_NUMERIC_ID`
- Find your numeric ID in your profile URL: `goodreads.com/user/show/`**`12345678`**`-yourname`
- With your numeric ID connected, `/profile shelf` will pull your currently-reading books

---

## Data Storage

The bot uses a local **SQLite database** (`data/bookclub.db`). No external database needed.

Each Discord server gets its own isolated book library and poll history. User profiles (platform connections) are global across servers.

---

## Deployment

For 24/7 uptime, deploy to any Node.js host:
- **Railway** — free tier, connects to GitHub
- **Fly.io** — generous free tier
- **DigitalOcean App Platform** — $5/mo
- **VPS** — run with `pm2 start src/index.js`

Make sure to copy the `data/` folder or mount a persistent volume so your database survives redeploys.

---

## Roadmap Ideas

- 🗓️ Reading schedule / chapter deadlines
- 💬 Spoiler-tagged discussion threads per chapter
- 📈 Personal reading stats over time
- 🔔 Progress nudge reminders
- ⭐ Star ratings after finishing a book
- 🔗 Automatic OpenLibrary lookup as ISBN fallback
