# Секрет за секрет

A private two-player guessing game. One static file, `index.html`, with no build step.

Live at https://play.vivannikov.com/

Game state is stored in Supabase with Row Level Security. The key in `index.html` is the public anon key.
True answers and secret pieces stay in the browser of the player who wrote them until the rules reveal them.

## Tests

```bash
npm install
npx playwright install chromium
npx playwright test
```

The tests run against https://play.vivannikov.com by default. Set `BASE_URL` to use another address.
They write real rows to Supabase and use about 25 anonymous sign-ins per full run, so don't run the whole file twice in an hour.
Test game ids are saved to `tests/.game-ids.txt` for cleanup.
