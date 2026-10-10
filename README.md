# Daily Quiz Alexa Skill

A personal Alexa quiz skill that imports the previous day's Jeopardy-style board from JeopardyToday into Supabase.

## 1. Create the Supabase tables
Open Supabase -> SQL Editor and run `sql/schema.sql`.

## 2. Configure the importer
Copy `.env.example` to `.env` and fill in:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Do not commit `.env` or expose the service-role key in browser code.

## 3. Install dependencies
```bash
npm install
```

## 4. Test with October 8, 2026
```bash
node scripts/import-jeopardy-today.mjs 2026-10-08
```

If successful it should save 61 rows: 30 Jeopardy, 30 Double Jeopardy, and 1 Final Jeopardy.

To import yesterday automatically:
```bash
npm run import:yesterday
```

## 5. Alexa
Create a Custom Skill in the Alexa Developer Console.
- Invocation name: `daily quiz`
- Paste `interaction-model/en-US.json` into the JSON editor and build the model.
- Use Node.js 20 for the Lambda runtime.
- Upload/install the dependencies used in `lambda/index.js`.
- Set Lambda environment variables `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
- Connect the Lambda ARN as the skill endpoint.

## Current gameplay
- “Alexa, open daily quiz.”
- Alexa reads the six first-round categories.
- “Historical Hodgepodge for 200.”
- Alexa reads the clue.
- “Who is Medici?”
- Alexa checks the answer and updates your score.

## Next upgrades
- Track used clues so they disappear from the board.
- Announce remaining values by category.
- Handle Daily Double wagering.
- Transition automatically to Double Jeopardy and Final Jeopardy.
- Better fuzzy answer matching and aliases.
- Run the importer nightly with GitHub Actions or a scheduled serverless job.

## Game format (v0.2)

Each Alexa game is intentionally short:

- 6 clues from the Jeopardy round: one random clue from each category
- 6 clues from the Double Jeopardy round: one random clue from each category
- Final Jeopardy as clue 13
- Alexa automatically advances after every answer; the player never chooses a category
- A new game re-randomizes the 12 category clues
- Standard clues use their original board value for scoring
- Final Jeopardy is currently a fixed $2,000 clue (no wagering yet)
- A wrong answer subtracts the clue value; saying "I don't know" / "pass" leaves the score unchanged
- Say "repeat" to hear the current clue again

The game selection is created once at launch and kept in Alexa session attributes, so the selected clues do not change midway through a game.
