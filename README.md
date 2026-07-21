# Mixed Gaming Blurred MTG Raffle Bot

## Version 1.1

This update adds:

- `/startraffle card: aliases:` — owner-only raffle creation
- `/guess card:` — private answer checking
- Case-insensitive and punctuation-insensitive matching
- First correct player receives 2 physical tickets
- Next four correct players receive 1 physical ticket each
- Sequential ticket assignment beginning with the saved next ticket number
- `/mytickets` — private player ticket list
- `/rafflestatus` — private owner summary
- Persistent SQLite storage on the Railway Volume

## Railway Volume

Mount the Railway Volume at:

```text
/data
```

Set:

```env
DATABASE_PATH=/data/raffle.db
STARTING_TICKET_NUMBER=158114
```

`STARTING_TICKET_NUMBER` is only used when the database is created for the first time. The current number is saved inside SQLite afterward.

## Test order

1. Deploy the update.
2. Run `/raffleping`.
3. Run `/startraffle card: Lightning Bolt`.
4. Submit a wrong `/guess` from a test account.
5. Submit the correct `/guess`.
6. Run `/mytickets` from the winner account.
7. Run `/rafflestatus` as the owner.
