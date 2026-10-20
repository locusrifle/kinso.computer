// Kinso Computer, as kinso.computer tells it: Noah's words (~/workbench/kinso-computer/script.md) and his recordings.
// Until a recording is here its words play as subtitles, timed as if spoken (timeline.mjs), and the build follows them.
//
// His recordings drop in under website/media/kinso/, named in MEDIA below (paths from website/, with ?v= so a new take
// reaches visitors at once):
//   opener     part 1, Noah on camera: a video with its own sound.            'media/kinso/opener.mp4?v=1'
//   launch     the launch video, no words.                                       'media/kinso/launch.mp4?v=1'
//   voiceover  part 2, the voice-over the build is timed to: the sound and its words' timings,
//              { audio: 'media/kinso/voiceover.m4a?v=1', words: 'media/kinso/voiceover.words.json?v=1' }
// opener may also be { video, words } to keep subtitles over it (the same words format).
//
// The words' timings, the format ~/workbench/kinso-film's words.json uses: seconds from the start of the recording,
//   { "duration": 162.4, "words": [ { "text": "If", "start": 0.52, "end": 0.61 }, { "text": "I", ... }, ... ] }
// Extra fields are ignored. The recorded words are matched to BEATS' words in order, so each step lands on the word
// it names below (build.mjs) even if a word or two differs from the script; a word may say "beat": <n> to pin it.

export const MEDIA = Object.freeze({
  opener: null,
  launch: null,
  voiceover: null,
});

// Part 1: on camera, about 75 seconds. One paragraph per entry.
export const OPENER = Object.freeze([
  "Hi, I'm Noah. I've just become a Kinso customer, and I build software.",
  "I'm very pro this technology. I live and breathe it. The future I picture is one of abundance, where the things I don't care about get handled for me and there's a lot more room for the things I love. For most of us, most of that will happen inside a computer. We spend hours a day in one window or another, and the window you spend your day in shapes what comes out of you.",
  "That's why Kinso caught my attention. Kinso, Claude Code, Codex, the ChatGPT app: everyone is racing to build the one window people actually need. I think Kinso has one of the strongest claims to it, and I have strong opinions about how to win it.",
  "So instead of telling you, I built it. The story goes that when Alexandr Wang went to Meta, he went to Zuckerberg and said: if I were in your position, here's what I'd do. I'm borrowing that playbook. What you're about to see is what I would do if I were Kinso, and at the end, it's yours to use.",
  'Enjoy.',
]);

// Part 2: the voice-over while Kinso is built, about 2 minutes 40. One beat per entry; screen is what is seen.
export const BEATS = Object.freeze([
  { name: 'The empty window', screen: 'The launch video shrinks into a plain, empty window in the middle of the Mac desktop.',
    text: "If I were building Kinso, I'd start with an empty window. Not an inbox yet, just the one window you'd be happy to spend your whole day in." },
  { name: 'The harnesses', screen: 'Claude Code and Codex drop out of the Dock into the window. A session opens on "what do you want?"',
    text: "First, I'd wrap the harnesses: Claude Code and Codex, the agents people already pay for, running inside Kinso on the subscriptions they already have. You don't choose a model to get started. It just asks what you want." },
  { name: 'Files', screen: 'Finder drops in. The files open in the panel beside the conversation.',
    text: "Then my files. If I'm working with agents all day, I want what they're working on right there beside the conversation, not in another app." },
  { name: 'The browser', screen: 'Safari drops in. The panel shows the Kinso Computer page.',
    text: 'Then a browser, in the same window, so the agent and I are looking at the same page.' },
  { name: 'Messages', screen: 'Gmail, LinkedIn and Instagram drop in. Conversations fill the sidebar beside the sessions.',
    text: 'And then the part you already know: messages. Gmail, LinkedIn, Instagram, one inbox, sitting right beside the agents. The same Claude that writes my code can find the thread and draft the reply, on the subscription I already pay for.' },
  { name: 'The video becomes a file', screen: 'The launch video minimises into a file in the Files panel.',
    text: 'Even the video you just watched is only a file now. Open it again whenever you like.' },
  { name: 'The race', screen: 'The window settles: sessions and messages on the left, the conversation in the middle, the panel on the right.',
    text: "That's the whole idea. Everyone is building this window: Anthropic with Claude Code, OpenAI with Codex and the ChatGPT app, and you with the inbox. They want you in their window because it means you use their models. Kinso doesn't have to win that way. Kinso can be the window that runs on whichever AI you already pay for." },
  { name: 'The business', screen: 'The browser shows the Kinso Computer page: US$39 a month.',
    text: "So here's the business I'd build. Not another AI subscription. For thirty-nine dollars a month, you rent your own computer with Kinso on it, and it runs on the Claude and ChatGPT subscriptions you already have." },
  { name: "It's real", screen: 'The cursor lets go of the window.',
    text: "And it's real. This one runs on my own subscriptions, so please don't go crazy, but you're free to use it. Ask it something, open the messages, look around." },
  { name: 'The source', screen: 'The Kinso Computer page in the browser: Get yours.',
    text: "If you'd like the source, press Get yours on the page. It's thirty-nine dollars, once, and then one command installs it with your own agent." },
  { name: 'Close', screen: '',
    text: "Thanks for watching. I'd love to help build this with you." },
]);

// The launch video's slot while there is no video: this long, plainly a slot.
export const LAUNCH_SLOT_S = 5;
