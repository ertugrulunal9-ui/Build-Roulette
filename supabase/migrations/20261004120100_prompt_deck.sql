-- Build Roulette: the prompt deck (60 BUILD, 40 RULE, 30 STYLE cards).
--
-- Seeded in a migration, not seed.sql, because production needs it
-- (seed.sql only runs on a local `supabase db reset`).
--
-- Every BUILD card is a small browser app that a vibe coder with an AI
-- assistant can get working in 5–15 minutes. RULE cards add a constraint and
-- STYLE cards set the look. The fun is in the collision of the three.
--
-- ─── Tag rules ────────────────────────────────────────────────────────────
-- Tags exist only to rule out impossible combinations; they are not genres.
--
--   needs:<cap>   the card cannot be done without <cap>
--   no:<cap>      the card forbids <cap>
--
-- A draw is valid when no card forbids what another card needs
-- (private.tags_compatible, checked pairwise over BUILD, RULE and STYLE).
-- Capabilities in use:
--
--   text       readable words on screen (letters; digits alone do not count)
--   keyboard   physical key input
--   pointer    mouse or touch input
--   audio      sound output
--   color      more than one hue
--   animation  motion over time
--   scroll     content taller than the viewport
--   buttons    <button> elements
--
-- Tag sparingly: a hard combination is the game, only an impossible one is
-- excluded. "Keyboard only" + "A pixel art editor" stays legal (arrow keys
-- and space work); "No words" + "A typing speed test" does not.
-- A tag outside this vocabulary is rejected by a check constraint, and
-- tests/03_deck.test.sql checks that every BUILD card still has plenty of
-- compatible RULE and STYLE cards.
--
-- Weights: 10 is normal, 15 is a crowd-pleaser, 5 is niche or hard.

-- ─── Constraints ──────────────────────────────────────────────────────────
alter table public.prompt_cards
  add constraint prompt_cards_text_not_blank check (btrim(text) <> '' and char_length(text) <= 120),
  add constraint prompt_cards_hint_not_blank check (hint is null or (btrim(hint) <> '' and char_length(hint) <= 200)),
  add constraint prompt_cards_tags_vocabulary check (
    array_to_string(tags, ' ')
      ~ '^((needs|no):(text|keyboard|pointer|audio|color|animation|scroll|buttons)( |$))*$'
  );

-- One card per text and kind (case-insensitive), so the deck has no duplicates.
create unique index prompt_cards_kind_text_key on public.prompt_cards (kind, lower(text));

-- Draws filter by kind among active cards.
create index prompt_cards_draw_idx on public.prompt_cards (kind) where is_active;

-- ─── Challenge hints ──────────────────────────────────────────────────────
-- Not in the §5.2 draft: the card hints are snapshotted with the texts, so
-- the spin and the results page can show them and editing a card never
-- rewrites history.
alter table public.challenges
  add column build_hint text,
  add column rule_hint  text,
  add column style_hint text;

-- ─── BUILD (60) ───────────────────────────────────────────────────────────
insert into public.prompt_cards (kind, text, hint, weight, tags) values
  ('build', 'A pomodoro timer that keeps you honest', 'Work, break, repeat. Bonus points for guilt.', 10, '{}'),
  ('build', 'A tip calculator for a group dinner', 'Bill, tip, people, and the friend who "forgot" their wallet.', 10, '{}'),
  ('build', 'A habit tracker for exactly one habit', 'One habit. One streak. Maximum pressure.', 10, '{}'),
  ('build', 'A mood tracker with a week view', 'Seven days, one feeling each.', 10, '{}'),
  ('build', 'A dice roller for tabletop night', 'Any dice you like. Critical hits deserve a celebration.', 10, '{}'),
  ('build', 'A Magic 8-Ball', 'Ask a question, get a questionable answer.', 15, '{}'),
  ('build', 'A color palette generator', 'Lock the colors you love, reroll the rest.', 10, '{needs:color}'),
  ('build', 'A "guess the hex code" game', 'Show a color, offer four hex codes, keep score.', 5, '{needs:color,needs:text}'),
  ('build', 'A typing speed test', 'Words per minute, accuracy, and a little drama.', 10, '{needs:keyboard,needs:text}'),
  ('build', 'Whack-a-mole', 'Moles optional. Anything that pops up counts.', 15, '{}'),
  ('build', 'Snake', 'The classic. Make it yours.', 10, '{}'),
  ('build', 'A drum machine', 'A grid of steps that loops. Web Audio is your friend.', 10, '{needs:audio}'),
  ('build', 'A soundboard of ridiculous noises', 'Synthesize them: boing, honk, sad trombone.', 10, '{needs:audio}'),
  ('build', 'A pixel art editor', '16 × 16 is plenty. Export optional.', 10, '{}'),
  ('build', 'A to-do list that judges you', 'It has opinions about your priorities.', 15, '{needs:text}'),
  ('build', 'A chore wheel for roommates', 'Spin it, assign it, no arguments.', 10, '{}'),
  ('build', 'A countdown to a holiday you just made up', 'Name it, date it, hype it.', 10, '{}'),
  ('build', 'An excuse generator', 'For being late, skipping the gym, or ignoring texts.', 15, '{needs:text}'),
  ('build', 'A password strength meter with opinions', 'It is not angry, just disappointed.', 10, '{needs:keyboard,needs:text}'),
  ('build', 'A kitchen unit converter', 'Cups, grams, spoons, and "a pinch".', 10, '{}'),
  ('build', 'Flashcards for a subject nobody needs', 'Pirate law. Medieval cheeses. Your call.', 10, '{needs:text}'),
  ('build', 'A reaction-time tester', 'Wait for it... wait for it... NOW.', 15, '{}'),
  ('build', 'A "would you rather" poll', 'Two choices, a running tally, plenty of drama.', 10, '{}'),
  ('build', 'A plant watering reminder', 'Your plants have feelings. Track them.', 10, '{}'),
  ('build', 'A breathing exercise guide', 'In for four, hold for four, out for four.', 10, '{needs:animation}'),
  ('build', 'A lava lamp', 'Relaxing blobs. Interactivity encouraged.', 10, '{needs:animation}'),
  ('build', 'A bouncing-logo screensaver', 'Will it ever hit the corner?', 10, '{needs:animation}'),
  ('build', 'A memory card matching game', 'Flip two, find pairs, beat your best time.', 10, '{}'),
  ('build', 'Tic-tac-toe against a terrible AI', 'It tries its best. Its best is bad.', 15, '{}'),
  ('build', 'Rock, paper, scissors, plus two new moves', 'Invent the moves and what beats what.', 10, '{}'),
  ('build', 'An idle clicker game about a tiny business', 'Lemonade stand, cat café, dragon daycare...', 15, '{}'),
  ('build', 'A meme generator', 'Pick or draw a picture, add top and bottom text.', 10, '{needs:text}'),
  ('build', 'A stock ticker for your snack drawer', 'Chips are up 12%. Cookies are crashing.', 10, '{}'),
  ('build', 'A pet rock tamagotchi', 'Feed it? Walk it? It is a rock.', 15, '{}'),
  ('build', 'A spin-the-wheel decision maker', 'Settle "where should we eat?" forever.', 10, '{needs:animation}'),
  ('build', 'A metronome', 'Tap tempo is a nice touch.', 5, '{needs:audio}'),
  ('build', 'A playable piano', 'One octave is enough to annoy everyone.', 10, '{needs:audio}'),
  ('build', 'A haiku generator', 'Five, seven, five. Syllable counting optional.', 10, '{needs:text}'),
  ('build', 'An "Is it Friday yet?" page', 'Answer one question. Overdeliver.', 10, '{}'),
  ('build', 'A loading screen that is secretly a game', 'Something to do while nothing loads.', 10, '{}'),
  ('build', 'A fidget toy', 'Switches, sliders, spinners. Pure satisfaction.', 10, '{}'),
  ('build', 'A weather dashboard for a made-up planet', 'Forecast: 80% chance of meteor showers.', 10, '{}'),
  ('build', 'A recipe scaler', 'Serves 4 → serves 37.', 5, '{}'),
  ('build', 'A rocket launch control panel', 'Checklist, toggles, a countdown, then liftoff.', 15, '{}'),
  ('build', 'A sleep cycle calculator', 'When should I go to bed to wake up fresh at 7?', 5, '{}'),
  ('build', 'A word-guessing game', 'Like Wordle, but you choose the twist.', 10, '{needs:text}'),
  ('build', 'A personality quiz with one very important question', 'Which kind of bread are you?', 10, '{}'),
  ('build', 'A symmetry drawing toy', 'Draw on one side, it mirrors on the others.', 10, '{needs:pointer}'),
  ('build', 'A star rating app for everyday things', 'Rate your chair, the weather, this exact moment.', 10, '{}'),
  ('build', 'A link-in-bio page for a pet', 'Followers, favorite snacks, a booking button for belly rubs.', 10, '{}'),
  ('build', 'A big red button you must not press', 'What happens when someone presses it anyway?', 15, '{needs:buttons}'),
  ('build', 'An infinite feed of fake facts', 'Keep scrolling. Did you know...?', 10, '{needs:scroll,needs:text}'),
  ('build', 'A bubble wrap popping simulator', 'Pop. Pop. Pop.', 10, '{}'),
  ('build', 'A dramatic coin flip', 'Slow motion strongly encouraged.', 10, '{needs:animation}'),
  ('build', 'A kanban board with exactly three cards', 'To do, doing, done. No scope creep.', 5, '{}'),
  ('build', 'A constellation maker', 'Place stars, connect them, name your creation.', 10, '{needs:pointer}'),
  ('build', 'A rubber duck debugging chat', 'Explain your bug. The duck listens. Quack.', 10, '{needs:keyboard,needs:text}'),
  ('build', 'The worst possible volume slider', 'Make choosing a number a quest.', 15, '{}'),
  ('build', 'An ambient noise mixer', 'Rain, café, fireplace. Synthesize them with Web Audio.', 5, '{needs:audio}'),
  ('build', 'A slot machine', 'Three reels, fake coins, real suspense.', 10, '{needs:animation}');

-- ─── RULE (40) ────────────────────────────────────────────────────────────
insert into public.prompt_cards (kind, text, hint, weight, tags) values
  ('rule', 'No buttons. Not a single <button>.', 'Links, gestures, sliders, keys: anything but a button.', 10, '{no:buttons}'),
  ('rule', 'Keyboard only. No mouse, no touch.', 'Arrow keys, Enter and Space are your whole world.', 10, '{no:pointer}'),
  ('rule', 'No keyboard. Mouse or touch only.', 'On-screen controls are fine; physical keys do nothing.', 10, '{no:keyboard}'),
  ('rule', 'No words. Icons, emoji, shapes and numbers only.', 'Not a single letter anywhere on screen.', 10, '{no:text}'),
  ('rule', 'Every action makes a sound.', 'Clicks, hovers, mistakes. Web Audio beeps count.', 10, '{needs:audio}'),
  ('rule', 'It must fit in a 320 × 320 box.', 'Tiny app, big ideas.', 10, '{}'),
  ('rule', 'No scrolling. Everything fits on one screen.', null, 10, '{no:scroll}'),
  ('rule', 'Nothing moves. Zero animations or transitions.', 'Change is instant, like a slideshow.', 10, '{no:animation}'),
  ('rule', 'Something is always wobbling.', 'At least one thing is animating at all times.', 10, '{needs:animation}'),
  ('rule', 'One color only, plus black and white.', 'Shades of your one color are allowed.', 10, '{no:color}'),
  ('rule', 'Hide an easter egg in it.', 'Show us where it is at the end. Or don''t.', 15, '{}'),
  ('rule', 'Upside down. The whole UI is rotated 180°.', 'Still has to be usable.', 5, '{}'),
  ('rule', 'Add a "chaos mode" switch that makes everything worse.', null, 15, '{}'),
  ('rule', 'Every action needs an absurd "Are you sure?" step.', 'Build it in the page: no alert() or confirm().', 10, '{}'),
  ('rule', 'A narrator comments on everything the user does.', 'Sports commentator, nature host or disappointed parent.', 15, '{}'),
  ('rule', 'Show a live counter of every single interaction.', null, 10, '{}'),
  ('rule', 'There is an undo, and it does something unexpected.', null, 10, '{}'),
  ('rule', 'Custom cursor: the pointer is part of the experience.', null, 10, '{needs:pointer}'),
  ('rule', 'One input only: a single key or a single kind of click.', 'Everything else is ignored.', 10, '{}'),
  ('rule', 'It gets slowly more chaotic the longer you use it.', null, 15, '{}'),
  ('rule', 'It has a loading screen that is more fun than the app.', null, 10, '{}'),
  ('rule', 'No straight edges. Everything is round.', 'Circles, blobs, pills. Corners are illegal.', 10, '{}'),
  ('rule', 'Include a progress bar that lies.', null, 10, '{}'),
  ('rule', 'The main control moves after every use.', null, 10, '{}'),
  ('rule', 'Gravity is on: things fall unless you hold them up.', null, 10, '{needs:animation}'),
  ('rule', 'It has a high-score table.', 'Local is fine. Fake rivals are encouraged.', 10, '{}'),
  ('rule', 'Huge mode: nothing smaller than 32 px.', null, 10, '{}'),
  ('rule', 'Command line only: everything happens by typing commands.', 'Type "help" first.', 5, '{needs:keyboard,needs:text}'),
  ('rule', 'At least ten emoji, and every one of them does something.', null, 10, '{}'),
  ('rule', 'Something changes every 10 seconds, no matter what.', null, 10, '{}'),
  ('rule', 'The app compliments the user constantly.', null, 15, '{}'),
  ('rule', 'There is a villain who tries to stop you.', null, 15, '{}'),
  ('rule', 'Two players, one device.', 'Hot seat, split screen, or one keyboard shared.', 10, '{}'),
  ('rule', 'Doing things fast builds a combo meter.', null, 10, '{}'),
  ('rule', 'It has at least three achievements to unlock.', null, 10, '{}'),
  ('rule', 'It tells a story with a beginning, middle and end.', null, 10, '{}'),
  ('rule', 'Use exactly one npm package, and make it the star.', null, 10, '{}'),
  ('rule', 'Zero dependencies. No npm packages at all.', null, 10, '{}'),
  ('rule', 'Every label lies: controls say the opposite of what they do.', null, 10, '{needs:text}'),
  ('rule', 'Everything lives on a 3 × 3 grid.', null, 10, '{}');

-- ─── STYLE (30) ───────────────────────────────────────────────────────────
insert into public.prompt_cards (kind, text, hint, weight, tags) values
  ('style', 'Brutalist', 'Raw HTML energy, thick borders, default fonts, zero apologies.', 10, '{}'),
  ('style', 'Windows 95', 'Grey bevels, title bars, a Start button for no reason.', 15, '{}'),
  ('style', 'Y2K chrome', 'Bubbles, gloss and chrome: the future as imagined in 1999.', 10, '{}'),
  ('style', 'Vaporwave', 'Pink and teal sunsets, marble busts, ｗｉｄｅ ｔｅｘｔ.', 10, '{}'),
  ('style', 'Green-screen terminal', 'Monospace, one phosphor color on black, blinking cursor.', 10, '{no:color}'),
  ('style', 'Newspaper front page', 'Black ink, serif headlines, columns. EXTRA! EXTRA!', 10, '{no:color,needs:text}'),
  ('style', 'Kawaii pastel', 'Soft colors, round everything, and everything has a face.', 10, '{}'),
  ('style', 'Cyberpunk neon', 'Magenta and cyan glow, glitches, rain-soaked dark mode.', 10, '{}'),
  ('style', 'Swiss poster', 'Strict grid, giant sans-serif type, one red accent.', 10, '{}'),
  ('style', '8-bit arcade', 'Pixel fonts, chunky sprites, INSERT COIN.', 15, '{}'),
  ('style', 'Notebook doodles', 'Lined paper, wobbly hand-drawn lines, a coffee stain.', 10, '{}'),
  ('style', 'Frosted glass', 'Blurry translucent panels floating over a colorful background.', 10, '{}'),
  ('style', 'Skeuomorphic 2010', 'Leather, stitching, glossy knobs. Everything looks real.', 10, '{}'),
  ('style', 'Personal homepage, 1998', 'Tiled backgrounds, "under construction", a visitor counter.', 15, '{}'),
  ('style', 'Bauhaus', 'Primary colors, circles, squares and triangles.', 10, '{}'),
  ('style', 'Art Deco', 'Gold on black, geometric luxury, 1920s glamour.', 10, '{}'),
  ('style', 'Blueprint', 'White lines on a blue grid, dimension arrows, technical labels.', 10, '{}'),
  ('style', 'Comic book', 'Halftone dots, speech bubbles, POW! BAM!', 10, '{}'),
  ('style', 'Thermal receipt', 'Narrow, monospace, dotted lines, slightly faded.', 10, '{no:color}'),
  ('style', 'Mission control, 1969', 'Panels, toggle switches, blinking lights, serious acronyms.', 10, '{}'),
  ('style', 'Medieval manuscript', 'Parchment, illuminated capitals, ornate borders.', 10, '{}'),
  ('style', 'Synthwave', 'Sunset gradient, neon grid horizon, chrome lettering.', 10, '{}'),
  ('style', 'Zen minimal', 'Mostly whitespace. One quiet accent. Breathe.', 10, '{}'),
  ('style', 'Grandma''s forwarded email', 'Comic Sans, clip art, rainbow word art, too many exclamation marks!!!', 15, '{}'),
  ('style', 'Silent film', 'Black and white, title cards, film grain. Not a sound.', 10, '{no:color,no:audio}'),
  ('style', 'Monochrome', 'One hue in many shades. Nothing else.', 10, '{no:color}'),
  ('style', 'Nature documentary', 'Earthy tones, field notes, a calm voice describing the user.', 10, '{}'),
  ('style', 'Claymation', 'Soft, puffy shapes that look hand-made.', 10, '{}'),
  ('style', 'Rainbow overload', 'Every element a different color. More is more.', 10, '{needs:color}'),
  ('style', 'Jelly physics', 'Everything squishes, bounces and jiggles.', 10, '{needs:animation}');
