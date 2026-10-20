// AskUserQuestion for Pi: the question tool Claude Code has, by the same name
// and shape, so both harnesses ask the person the same way, in the window's
// one questions dialog (extension-ui.mjs askQuestions, harness.js). Claude's
// own arrives through canUseTool (claude-runtime.mjs); Pi's is registered
// with imperfect's part of every Pi session (runtime.mjs).
const OPTION = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'the choice, in a few words' },
    description: { type: 'string', description: 'what choosing it means' },
  },
  required: ['label'],
};
const QUESTION = {
  type: 'object',
  properties: {
    question: { type: 'string', description: 'the whole question, ending in a question mark' },
    header: { type: 'string', description: 'a short label for it, a word or two' },
    options: { type: 'array', items: OPTION, minItems: 2, maxItems: 4, description: 'the choices; the person can always write their own instead' },
    multiSelect: { type: 'boolean', description: 'whether more than one choice can be picked' },
  },
  required: ['question', 'header', 'options'],
};

// The answers map ({ question: answer }) as the model reads it, the way
// Claude Code words it.
export function answered(questions, answers) {
  if (!answers) return 'The person closed the questions without answering.';
  return `The person answered your questions: ${questions.map(({ question }) => `"${question}"="${answers[question] ?? ''}"`).join(', ')}. You can now continue with their answers in mind.`;
}

export function questionsTool(ui) {
  return {
    name: 'AskUserQuestion',
    label: 'Questions',
    description: 'Ask the person one to four questions, each with two to four choices (they can always write their own answer instead), in a dialog in their imperfect window, and wait for their answers, however long that takes. Use it for a decision that is theirs: what they want, which way to go.',
    parameters: { type: 'object', properties: { questions: { type: 'array', items: QUESTION, minItems: 1, maxItems: 4 } }, required: ['questions'] },
    async execute(_id, { questions } = {}, signal) {
      if (!Array.isArray(questions) || !questions.length) throw new Error('AskUserQuestion needs at least one question');
      const answers = await ui.askQuestions(questions, { signal });
      return { content: [{ type: 'text', text: answered(questions, answers) }], details: { answers: answers ?? null } };
    },
  };
}
