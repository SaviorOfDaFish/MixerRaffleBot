# Mixed Gaming Raffle Bot — Starter

This starter version:

- logs into Discord;
- registers `/guess` and `/raffleping` in one server;
- only accepts `/guess` in the configured raffle guess channel;
- replies ephemerally so guesses remain private;
- stores guesses in SQLite;
- saves the database at `DATABASE_PATH` (use `/data/raffle.db` on Railway);
- initializes the next physical ticket number at `158114`.

## Railway setup

1. Upload this project to GitHub.
2. Create a Railway service from the GitHub repository.
3. Add every variable from `.env.example` in Railway's Variables tab.
4. Put the real bot token in `DISCORD_TOKEN`.
5. Create a Railway Volume mounted at `/data`.
6. Deploy.

The start command is already defined in `package.json`:

```bash
npm start
```

## Test

After deployment, run `/raffleping` in Discord. Then run `/guess card: Black Lotus` in the raffle guess channel. Both replies should only be visible to you.
