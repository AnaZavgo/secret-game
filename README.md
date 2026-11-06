# Секрет за секрет

A private two-player guessing game. One static file, `index.html`, with no build step.

Live at https://play.vivannikov.com/

Game state is stored in Supabase with Row Level Security. The key in `index.html` is the public anon key.
True answers and secret pieces stay in the browser of the player who wrote them until the rules reveal them.
