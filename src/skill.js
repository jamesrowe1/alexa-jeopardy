const Alexa = require('ask-sdk-core');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false, autoRefreshToken: false } }
);

function escapeSsml(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function supportsAPL(handlerInput) {
  return !!handlerInput.requestEnvelope
    ?.context
    ?.System
    ?.device
    ?.supportedInterfaces
    ?.[ 'Alexa.Presentation.APL' ];
}

function escapeAplText(text = '') {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function addClueVisual(handlerInput, clue, attrs) {
  if (!supportsAPL(handlerInput)) {
    return;
  }

  let roundLabel;

  if (clue.round === 'DJ') {
    roundLabel = 'DOUBLE JEOPARDY';
  } else if (clue.round === 'FJ') {
    roundLabel = 'FINAL JEOPARDY';
  } else {
    roundLabel = 'JEOPARDY';
  }

  const clueNumber =
    Number(attrs.gameIndex || 0) + 1;

  const totalClues =
    attrs.game?.length || 13;

  const valueText =
    clue.round === 'FJ'
      ? `Clue ${clueNumber} of ${totalClues}`
      : `$${Number(clue.gameValue || clue.value || 0).toLocaleString()} • Clue ${clueNumber} of ${totalClues}`;

  handlerInput.responseBuilder.addDirective({
    type: 'Alexa.Presentation.APL.RenderDocument',
    token: `daily-quiz-clue-${clueNumber}`,

    document: {
      type: 'APL',
      version: '2024.3',
      theme: 'dark',
      
      settings: {
        idleTimeout: 300000
      },
      
      mainTemplate: {
        items: [
          {
            type: 'Container',
            width: '100vw',
            height: '100vh',

            paddingLeft: '6vw',
            paddingRight: '6vw',
            paddingTop: '5vh',
            paddingBottom: '5vh',

            items: [
              {
                type: 'Text',
                text: escapeAplText(roundLabel),
                fontSize: '28dp',
                fontWeight: 'bold',
                textAlign: 'center',
                color: '#FFD700',
                maxLines: 1
              },

              {
                type: 'Text',
                text: escapeAplText(clue.category),
                fontSize: '42dp',
                fontWeight: 'bold',
                textAlign: 'center',
                spacing: '2vh',
                maxLines: 2
              },

              {
                type: 'Text',
                text: escapeAplText(valueText),
                fontSize: '26dp',
                textAlign: 'center',
                spacing: '1vh',
                maxLines: 1
              },

              {
                type: 'Text',
                text: escapeAplText(clue.clue),
                fontSize: '36dp',
                textAlign: 'center',
                textAlignVertical: 'center',
                spacing: '5vh',
                maxLines: 8
              }
            ]
          }
        ]
      }
    }
  });
}

async function latestEpisode() {
  const { data, error } = await supabase
    .from('episodes')
    .select('*')
    .order('air_date', { ascending: false })
    .limit(1)
    .single();

  if (error) throw error;
  return data;
}

function getAlexaUserId(h) {
  return (
    h.requestEnvelope.context?.System?.user?.userId ||
    h.requestEnvelope.session?.user?.userId
  );
}

function hasUnfinishedGame(state) {
  return (
    state &&
    Array.isArray(state.game) &&
    Number.isInteger(state.gameIndex) &&
    state.gameIndex >= 0 &&
    state.gameIndex < state.game.length &&
    state.currentClueId != null
  );
}

async function loadInProgressGame(h) {
  const userId = getAlexaUserId(h);
  if (!userId) return null;

  const { data, error } = await supabase
    .from('alexa_in_progress_games')
    .select('state')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  return data?.state || null;
}

async function saveInProgressGame(h, state) {
  const userId = getAlexaUserId(h);

  if (!userId) {
    throw new Error('Cannot save game without Alexa user ID');
  }

  const { error } = await supabase
    .from('alexa_in_progress_games')
    .upsert(
      {
        user_id: userId,
        state,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'user_id' }
    );

  if (error) throw error;
}

async function clearInProgressGame(h) {
  const userId = getAlexaUserId(h);
  if (!userId) return;

  const { error } = await supabase
    .from('alexa_in_progress_games')
    .delete()
    .eq('user_id', userId);

  if (error) throw error;
}

async function mostRecentUnplayedEpisode(h) {
  const userId = getAlexaUserId(h);

  if (!userId) {
    throw new Error('Alexa user ID unavailable');
  }

  const { data: episodes, error: episodeError } =
    await supabase
      .from('episodes')
      .select('id, air_date')
      .order('air_date', { ascending: false })
      .limit(500);

  if (episodeError) throw episodeError;

  const { data: completed, error: completedError } =
    await supabase
      .from('alexa_completed_games')
      .select('episode_id')
      .eq('user_id', userId);

  if (completedError) throw completedError;

  const completedIds = new Set(
    completed.map(row => String(row.episode_id))
  );

  return episodes.find(
    episode => !completedIds.has(String(episode.id))
  ) || null;
}

async function markEpisodePlayed(h, episodeId) {
  const userId = getAlexaUserId(h);

  if (!userId || !episodeId) {
    throw new Error('Missing user or episode ID');
  }

  const { error } = await supabase
    .from('alexa_completed_games')
    .upsert(
      {
        user_id: userId,
        episode_id: episodeId,
        completed_at: new Date().toISOString()
      },
      {
        onConflict: 'user_id,episode_id'
      }
    );

  if (error) throw error;
}

async function cluesForEpisode(episodeId) {
  const { data, error } = await supabase
    .from('clues')
    .select('*')
    .eq('episode_id', episodeId)
    .order('round')
    .order('category')
    .order('board_position');

  if (error) throw error;
  return data;
}

function chooseDifficultyPerCategory(clues, round, difficulty) {
  const roundClues = clues.filter(c => c.round === round);
  const byCategory = new Map();

  for (const clue of roundClues) {
    if (!byCategory.has(clue.category)) {
      byCategory.set(clue.category, []);
    }

    byCategory.get(clue.category).push(clue);
  }

  return [...byCategory.values()].map(categoryClues => {
    const selected = categoryClues.find(
      clue => Number(clue.board_position) === Number(difficulty)
    );

    if (!selected) {
      throw new Error(
        `Could not find difficulty ${difficulty} clue for category ${categoryClues[0]?.category}`
      );
    }

    return selected;
  });
}

function buildGame(clues, difficulty) {
  const jeopardy =
    chooseDifficultyPerCategory(clues, 'J', difficulty);

  const doubleJeopardy =
    chooseDifficultyPerCategory(clues, 'DJ', difficulty);

  const finalJeopardy =
    clues.find(c => c.round === 'FJ');

  if (
    jeopardy.length !== 6 ||
    doubleJeopardy.length !== 6 ||
    !finalJeopardy
  ) {
    throw new Error(
      `Episode is incomplete: J=${jeopardy.length}, DJ=${doubleJeopardy.length}, FJ=${finalJeopardy ? 1 : 0}`
    );
  }

  return [
    ...jeopardy,
    ...doubleJeopardy,
    finalJeopardy
  ].map((clue, index) => ({
    ...clue,
    gameNumber: index + 1,
    gameValue:
      clue.round === 'FJ'
        ? 2000
        : Number(clue.value || 0)
  }));
}

function formatDate(dateString) {
  const [year, month, day] = dateString.split('-').map(Number);

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC'
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatMoney(value) {
  const n = Number(value || 0);

  return n < 0
    ? `negative $${Math.abs(n).toLocaleString()}`
    : `$${n.toLocaleString()}`;
}

function clueSpeech(clue) {
  const category = escapeSsml(clue.category);
  const clueText = escapeSsml(clue.clue);

  if (clue.round === 'FJ') {
    return (
      `Final Jeopardy. ` +
      `The category is ${category}. ` +
      `Here is your final clue. ${clueText}`
    );
  }

  const roundName =
    clue.round === 'DJ' ? 'Double Jeopardy' : 'Jeopardy';

  const dailyDoubleText = clue.is_daily_double
    ? ' This was a Daily Double on the show.'
    : '';

  return (
    `${roundName}. ` +
    `Category: ${category}. ` +
    `For ${formatMoney(clue.gameValue)}.` +
    `${dailyDoubleText} ${clueText}`
  );
}

function setCurrentClue(attrs) {
  const clue = attrs.game[attrs.gameIndex];

  attrs.currentClueId = clue.id;
  attrs.currentResponse = clue.response;
  attrs.currentValue = clue.gameValue;
  attrs.currentCategory = clue.category;
  attrs.currentRound = clue.round;

  return clue;
}

function fuzzy(userAnswer, expectedAnswer) {
  function normalize(text) {
    return String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // remove accents
      .toLowerCase()
      .replace(/['’]/g, '')           // apostrophes
      .replace(/&/g, ' and ')
      .replace(/\b(what|who|where|when|which)\b/g, ' ')
      .replace(/\b(is|are|was|were)\b/g, ' ')
      .replace(/\b(the|a|an)\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function singularize(word) {
    if (word.length > 4 && word.endsWith('ies')) {
      return word.slice(0, -3) + 'y';
    }

    if (
      word.length > 4 &&
      word.endsWith('s') &&
      !word.endsWith('ss')
    ) {
      return word.slice(0, -1);
    }

    return word;
  }

  function normalizeWords(text) {
    return normalize(text)
      .split(' ')
      .filter(Boolean)
      .map(singularize);
  }

  function levenshtein(a, b) {
    const matrix = Array.from(
      { length: b.length + 1 },
      () => Array(a.length + 1).fill(0)
    );

    for (let i = 0; i <= b.length; i++) {
      matrix[i][0] = i;
    }

    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        const cost =
          b[i - 1] === a[j - 1] ? 0 : 1;

        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost
        );
      }
    }

    return matrix[b.length][a.length];
  }

  const user = normalize(userAnswer);
  const expected = normalize(expectedAnswer);

  if (!user || !expected) {
    return false;
  }

  // Exact normalized match.
  if (user === expected) {
    return true;
  }

  const userWords = normalizeWords(userAnswer);
  const expectedWords = normalizeWords(expectedAnswer);

  const userJoined = userWords.join(' ');
  const expectedJoined = expectedWords.join(' ');

  if (userJoined === expectedJoined) {
    return true;
  }

  // Allow a small speech-recognition / spelling error.
  const distance = levenshtein(
    userJoined,
    expectedJoined
  );

  const longest = Math.max(
    userJoined.length,
    expectedJoined.length
  );

  if (
    longest >= 6 &&
    distance / longest <= 0.16
  ) {
    return true;
  }

  /*
   * Allow surname-only responses for obvious person names.
   *
   * Benedict Arnold -> Arnold
   * Thomas Jefferson -> Jefferson
   * Abraham Lincoln -> Lincoln
   *
   * But don't do this for ordinary phrases like
   * "breech birth" -> "birth".
   */
  if (userWords.length === 1) {
    const originalExpected = String(expectedAnswer)
      .replace(/[()[\],]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    const capitalizedWords = originalExpected.filter(
      word => /^[A-Z][A-Za-z'’.-]+$/.test(word)
    );

    const userWord = userWords[0];

    if (
      capitalizedWords.length >= 2 &&
      userWord.length >= 4 &&
      expectedWords.includes(userWord)
    ) {
      return true;
    }
  }

  /*
   * Accept answers that omit a generic trailing descriptor
   * when the distinctive part is still present.
   *
   * "Hadrian Wall" -> "Hadrian's Wall"
   * "Medici" -> "de' Medici"
   */
  const ignoredWords = new Set([
    'de',
    'da',
    'del',
    'di',
    'du',
    'la',
    'le',
    'van',
    'von',
    'of'
  ]);

  const importantExpected = expectedWords.filter(
    word => !ignoredWords.has(word)
  );

  const importantUser = userWords.filter(
    word => !ignoredWords.has(word)
  );

  if (
    importantUser.length > 0 &&
    importantUser.every(word =>
      importantExpected.includes(word)
    ) &&
    importantUser.join('').length >= 5 &&
    importantUser.length >=
      Math.max(1, importantExpected.length - 1)
  ) {
    return true;
  }

  return false;
}

function advanceAfterAnswer(
  handlerInput,
  attrs,
  wasCorrect,
  expected
) {
  const scoreText = `Your score is ${formatMoney(attrs.score)}.`;

  const resultText = wasCorrect
    ? `Correct! ${scoreText}`
    : `Sorry, the correct response was ${escapeSsml(expected)}. ${scoreText}`;

  attrs.gameIndex += 1;
  attrs.currentClueId = null;
  attrs.currentResponse = null;

  if (attrs.gameIndex >= attrs.game.length) {
    return {
      done: true,
      speech:
        `${resultText} ` +
        `That's the end of today's game. ` +
        `Your final score is ${formatMoney(attrs.score)}. ` +
        `Thanks for playing Daily Quiz.`
    };
  }

  const next = setCurrentClue(attrs);

  addClueVisual(
  handlerInput,
  next,
  attrs
);

  let transition = '';

  if (next.gameNumber === 7) {
    transition = ' Now we move to Double Jeopardy.';
  }

  if (next.gameNumber === 13) {
    transition = ' And now, Final Jeopardy.';
  }

  return {
    done: false,
    speech: `${resultText}${transition} ${clueSpeech(next)}`
  };
}

const LaunchRequestHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) ===
      'LaunchRequest'
    );
  },

  handle(h) {
    const attrs =
      h.attributesManager.getSessionAttributes();

    // Resume an unfinished game.
    if (hasUnfinishedGame(attrs)) {
      const clue = attrs.game[attrs.gameIndex];

      // Restore the Echo Show display.
      addClueVisual(h, clue, attrs);

      return h.responseBuilder
        .speak(
          `Welcome back to Daily Quiz. ` +
          `You're on clue ${attrs.gameIndex + 1} ` +
          `of ${attrs.game.length}. ` +
          `Your score is ${formatMoney(attrs.score)}. ` +
          `${clueSpeech(clue)}`
        )
        .reprompt('What is your response?')
        .getResponse();
    }

    // No unfinished game: normal selection menu.
    h.attributesManager.setSessionAttributes({
      awaitingGameChoice: true
    });

    return h.responseBuilder
      .speak(
        `Welcome to Daily Quiz. ` +
        `Would you like the latest game, ` +
        `or the most recent unplayed game?`
      )
      .reprompt(
        'Say latest game or unplayed game.'
      )
      .getResponse();
  }
};

const LatestGameIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) ===
        'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) ===
        'LatestGameIntent'
    );
  },

  async handle(h) {
    const episode = await latestEpisode();

    h.attributesManager.setSessionAttributes({
      selectedEpisodeId: episode.id,
      airDate: episode.air_date,
      awaitingDifficulty: true
    });

    return h.responseBuilder
      .speak(
        `The latest game is from ` +
        `${formatDate(episode.air_date)}. ` +
        `Choose a difficulty from 1 to 5.`
      )
      .reprompt('Choose a difficulty from 1 to 5.')
      .getResponse();
  }
};

const UnplayedGameIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) ===
        'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) ===
        'UnplayedGameIntent'
    );
  },

  async handle(h) {
    const episode = await mostRecentUnplayedEpisode(h);

    if (!episode) {
      return h.responseBuilder
        .speak(
          'You have completed every game currently ' +
          'available in your database. ' +
          'You can play the latest game again.'
        )
        .reprompt('Say latest game to play again.')
        .getResponse();
    }

    h.attributesManager.setSessionAttributes({
      selectedEpisodeId: episode.id,
      airDate: episode.air_date,
      awaitingDifficulty: true
    });

    return h.responseBuilder
      .speak(
        `Your most recent unplayed game is from ` +
        `${formatDate(episode.air_date)}. ` +
        `Choose a difficulty from 1 to 5.`
      )
      .reprompt('What difficulty would you like?')
      .getResponse();
  }
};

const DifficultyIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'DifficultyIntent'
    );
  },

  async handle(h) {
    const difficulty = Number(
      Alexa.getSlotValue(
        h.requestEnvelope,
        'difficulty'
      )
    );

    if (
      !Number.isInteger(difficulty) ||
      difficulty < 1 ||
      difficulty > 5
    ) {
      return h.responseBuilder
        .speak(
          'Please choose a difficulty from 1 to 5.'
        )
        .reprompt(
          'What difficulty would you like? Choose 1 through 5.'
        )
        .getResponse();
    }

    const selectedAttrs =
      h.attributesManager.getSessionAttributes();

    let episode;

    if (selectedAttrs.selectedEpisodeId) {
      const { data, error } = await supabase
        .from('episodes')
        .select('*')
        .eq('id', selectedAttrs.selectedEpisodeId)
        .single();

      if (error) throw error;

      episode = data;
    } else {
      episode = await latestEpisode();
    }
    const clues = await cluesForEpisode(episode.id);

    const game = buildGame(
      clues,
      difficulty
    );

    const attrs = {
      episodeId: episode.id,
      airDate: episode.air_date,
      difficulty,
      score: 0,
      game,
      gameIndex: 0,
      awaitingDifficulty: false
    };

    const first = setCurrentClue(attrs);

    h.attributesManager.setSessionAttributes(attrs);

    addClueVisual(h, first, attrs);

    return h.responseBuilder
      .speak(
        `Difficulty ${difficulty}. ` +
        `I'm using the game from ${formatDate(episode.air_date)}. ` +
        `You'll get one clue from each of the twelve categories, ` +
        `followed by Final Jeopardy. ` +
        `Let's begin. ` +
        `${clueSpeech(first)}`
      )
      .reprompt(
        'What is your response?'
      )
      .getResponse();
  }
};

const AnswerIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'AnswerIntent'
    );
  },

  async handle(h) {
    const attrs = h.attributesManager.getSessionAttributes();

    if (!attrs.currentClueId || !attrs.game) {
      return h.responseBuilder
        .speak(
          'There is no active clue. Please reopen Daily Quiz to begin a new game.'
        )
        .getResponse();
    }

    const answer =
      Alexa.getSlotValue(h.requestEnvelope, 'answer') || '';

    const expected = attrs.currentResponse || '';
    const correct = fuzzy(answer, expected);
    const value = Number(attrs.currentValue || 0);

    attrs.score =
        Number(attrs.score || 0) + (correct ? value : 0);

    const result = advanceAfterAnswer(
      h,
      attrs,
      correct,
      expected
    );

    h.attributesManager.setSessionAttributes(attrs);

    if (result.done) {
      try {
        await markEpisodePlayed(h, attrs.episodeId);
      } catch (error) {
        console.error('Could not save completed game:', error);
      }

      return h.responseBuilder
        .speak(result.speech)
        .getResponse();
    }

    return h.responseBuilder
      .speak(result.speech)
      .reprompt('What is your response?')
      .getResponse();
  }
};

const GiveUpIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'GiveUpIntent'
    );
  },

  async handle(h) {
    const attrs = h.attributesManager.getSessionAttributes();

    if (!attrs.currentClueId || !attrs.game) {
      return h.responseBuilder
        .speak(
          'There is no active clue. Please reopen Daily Quiz to begin a new game.'
        )
        .getResponse();
    }

    const expected = attrs.currentResponse || '';

    const resultText =
      `The correct response was ${escapeSsml(expected)}. ` +
      `Your score is ${formatMoney(attrs.score)}.`;

    attrs.gameIndex += 1;
    attrs.currentClueId = null;
    attrs.currentResponse = null;

    if (attrs.gameIndex >= attrs.game.length) {
      h.attributesManager.setSessionAttributes(attrs);
      try {
        await markEpisodePlayed(h, attrs.episodeId);
      } catch (error) {
        console.error('Could not save completed game:', error);
      }
      return h.responseBuilder
        .speak(
          `${resultText} ` +
          `That's the end of today's game. ` +
          `Your final score is ${formatMoney(attrs.score)}. ` +
          `Thanks for playing Daily Quiz.`
        )
        .getResponse();
    }

    const next = setCurrentClue(attrs);

    addClueVisual(
      h,
      next,
      attrs
    );

    let transition = '';

    if (next.gameNumber === 7) {
      transition = ' Now we move to Double Jeopardy.';
    }

    if (next.gameNumber === 13) {
      transition = ' And now, Final Jeopardy.';
    }

    h.attributesManager.setSessionAttributes(attrs);

    return h.responseBuilder
      .speak(`${resultText}${transition} ${clueSpeech(next)}`)
      .reprompt('What is your response?')
      .getResponse();
  }
};

const RepeatClueIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') {
      return false;
    }

    const intent = Alexa.getIntentName(h.requestEnvelope);

    return (
      intent === 'AMAZON.RepeatIntent' ||
      intent === 'RepeatClueIntent'
    );
  },

  handle(h) {
    const attrs = h.attributesManager.getSessionAttributes();

    if (!attrs.game || !attrs.currentClueId) {
      return h.responseBuilder
        .speak('There is no active clue to repeat.')
        .getResponse();
    }

    const clue = attrs.game[attrs.gameIndex];
    
    addClueVisual(
      h,
      clue,
      attrs
    );

    return h.responseBuilder
      .speak(clueSpeech(clue))
      .reprompt('What is your response?')
      .getResponse();
  }
};

const RepeatCategoryIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'RepeatCategoryIntent'
    );
  },

  handle(h) {
    const attrs = h.attributesManager.getSessionAttributes();

    if (!attrs.currentCategory) {
      return h.responseBuilder
        .speak('There is no active category right now.')
        .getResponse();
    }

    return h.responseBuilder
      .speak(
        `The category is ${escapeSsml(attrs.currentCategory)}.`
      )
      .reprompt('What is your response?')
      .getResponse();
  }
};

const ScoreIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'ScoreIntent'
    );
  },

  handle(h) {
    const attrs = h.attributesManager.getSessionAttributes();
    const score = Number(attrs.score || 0);

    return h.responseBuilder
      .speak(`Your score is ${formatMoney(score)}.`)
      .reprompt('What is your response?')
      .getResponse();
  }
};

const ProgressIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'ProgressIntent'
    );
  },

  handle(h) {
    const attrs = h.attributesManager.getSessionAttributes();

    if (!attrs.game) {
      return h.responseBuilder
        .speak('There is no active game.')
        .getResponse();
    }

    const current = Number(attrs.gameIndex || 0) + 1;
    const total = attrs.game.length;
    const remaining = total - current;

    let speech =
      `You are on clue ${current} of ${total}.`;

    if (remaining === 0) {
      speech += ' This is the last clue.';
    } else if (remaining === 1) {
      speech += ' There is one clue after this one.';
    } else {
      speech += ` There are ${remaining} clues after this one.`;
    }

    return h.responseBuilder
      .speak(speech)
      .reprompt('What is your response?')
      .getResponse();
  }
};

const RulesIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'RulesIntent'
    );
  },

  handle(h) {
    return h.responseBuilder
      .speak(
        `You will hear one clue from each of twelve categories, followed by Final Jeopardy. ` +
        `Correct answers add the clue's value to your score. ` +
        `Wrong answers and skipped clues do not subtract points. ` +
        `You can say repeat clue, repeat category, what's my score, or I don't know at any time.`
      )
      .reprompt('What is your response?')
      .getResponse();
  }
};

const RestartGameIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) === 'RestartGameIntent'
    );
  },

  async handle(h) {
    const attrs = h.attributesManager.getSessionAttributes();

    if (!attrs.episodeId || !attrs.difficulty) {
      h.attributesManager.setSessionAttributes({
        awaitingDifficulty: true
      });

      return h.responseBuilder
        .speak(
          `Let's start over. Choose a difficulty from 1 to 5.`
        )
        .reprompt(
          'What difficulty would you like?'
        )
        .getResponse();
    }

    const clues = await cluesForEpisode(
      attrs.episodeId
    );

    const game = buildGame(
      clues,
      attrs.difficulty
    );

    attrs.score = 0;
    attrs.game = game;
    attrs.gameIndex = 0;

    const first = setCurrentClue(attrs);

    h.attributesManager.setSessionAttributes(attrs);

    addClueVisual(
      h,
      first,
      attrs
    );

    return h.responseBuilder
      .speak(
        `Starting over. Your score is back to zero. ` +
        `${clueSpeech(first)}`
      )
      .reprompt('What is your response?')
      .getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) ===
        'AMAZON.HelpIntent'
    );
  },

  handle(h) {
    return h.responseBuilder
      .speak(
        `Answer each clue naturally, for example, what is Jupiter. ` +
        `Say repeat to hear the clue again, or say I don't know to pass.`
      )
      .reprompt('What is your response?')
      .getResponse();
  }
};

const FallbackIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) ===
        'AMAZON.FallbackIntent'
    );
  },

  handle(h) {
    return h.responseBuilder
      .speak(
        `I didn't catch that response. ` +
        `Please answer the clue with something like, what is Jupiter, ` +
        `or say I don't know.`
      )
      .reprompt('What is your response?')
      .getResponse();
  }
};

const CancelAndStopIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest' &&
      ['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(
        Alexa.getIntentName(h.requestEnvelope)
      )
    );
  },

  handle(h) {
    const score =
      h.attributesManager.getSessionAttributes().score || 0;

    return h.responseBuilder
      .speak(
        `Thanks for playing. Your score is ${formatMoney(score)}.`
      )
      .getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) ===
      'SessionEndedRequest'
    );
  },

  handle(h) {
    console.log(
      'Session ended:',
      JSON.stringify(
        h.requestEnvelope.request,
        null,
        2
      )
    );

    return h.responseBuilder.getResponse();
  }
};

const ErrorHandler = {
  canHandle() {
    return true;
  },

  handle(h, error) {
    console.error('Alexa skill error:', error);

    return h.responseBuilder
      .speak('Something went wrong. Please try again.')
      .reprompt('What is your response?')
      .getResponse();
  }
};

const NewGameIntentHandler = {
  canHandle(h) {
    return (
      Alexa.getRequestType(h.requestEnvelope) ===
        'IntentRequest' &&
      Alexa.getIntentName(h.requestEnvelope) ===
        'NewGameIntent'
    );
  },

  handle(h) {
    h.attributesManager.setSessionAttributes({
      awaitingGameChoice: true
    });

    return h.responseBuilder
      .speak(
        `Starting a new game. ` +
        `Would you like the latest game, ` +
        `or the most recent unplayed game?`
      )
      .reprompt(
        'Say latest game or unplayed game.'
      )
      .getResponse();
  }
};

const LoadInProgressInterceptor = {
  async process(h) {
    const requestType =
      Alexa.getRequestType(h.requestEnvelope);

    if (requestType === 'SessionEndedRequest') {
      return;
    }

    const attrs =
      h.attributesManager.getSessionAttributes();

    // Current-session state takes precedence.
    if (Object.keys(attrs || {}).length > 0) {
      return;
    }

    // New session: restore the saved game if one exists.
    const saved = await loadInProgressGame(h);

    if (hasUnfinishedGame(saved)) {
      h.attributesManager.setSessionAttributes(saved);
    }
  }
};

const SaveInProgressInterceptor = {
  async process(h) {
    const requestType =
      Alexa.getRequestType(h.requestEnvelope);

    if (requestType === 'SessionEndedRequest') {
      return;
    }

    const attrs =
      h.attributesManager.getSessionAttributes();

    const intentName =
      requestType === 'IntentRequest'
        ? Alexa.getIntentName(h.requestEnvelope)
        : null;

    // Choosing another game discards the old progress.
    if (
      [
        'NewGameIntent',
        'LatestGameIntent',
        'UnplayedGameIntent'
      ].includes(intentName) &&
      !hasUnfinishedGame(attrs)
    ) {
      await clearInProgressGame(h);
      return;
    }

    // Save the current clue, score, difficulty, etc.
    if (hasUnfinishedGame(attrs)) {
      await saveInProgressGame(h, attrs);
      return;
    }

    // Completed all thirteen clues: remove saved progress.
    if (
      Array.isArray(attrs?.game) &&
      attrs.game.length > 0 &&
      attrs.gameIndex >= attrs.game.length
    ) {
      await clearInProgressGame(h);
    }
  }
};

const SkillIdValidationInterceptor = {
  process(handlerInput) {
    const expectedSkillId =
      process.env.ALEXA_SKILL_ID;

    if (!expectedSkillId) {
      return;
    }

    const envelope = handlerInput.requestEnvelope;

    const actualSkillId =
      envelope?.context?.System?.application?.applicationId ||
      envelope?.session?.application?.applicationId;

    if (actualSkillId !== expectedSkillId) {
      throw new Error(
        'Request was sent to the wrong Alexa skill.'
      );
    }
  }
};

const skill = Alexa.SkillBuilders.custom()
  .addRequestInterceptors(
  SkillIdValidationInterceptor,
  LoadInProgressInterceptor
  )
  .addResponseInterceptors(
    SaveInProgressInterceptor
  )
  .addRequestHandlers(
    LaunchRequestHandler,
    LatestGameIntentHandler,
    UnplayedGameIntentHandler,
    NewGameIntentHandler,
    DifficultyIntentHandler,

    AnswerIntentHandler,
    GiveUpIntentHandler,

    RepeatClueIntentHandler,
    RepeatCategoryIntentHandler,
    ScoreIntentHandler,
    ProgressIntentHandler,
    RulesIntentHandler,
    RestartGameIntentHandler,

    HelpIntentHandler,
    FallbackIntentHandler,
    CancelAndStopIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

module.exports = skill;