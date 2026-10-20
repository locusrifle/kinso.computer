// The transcriber's child process (transcribe.mjs): Parakeet loaded once,
// then each job's pieces heard in turn and joined into one text.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const sherpa = createRequire(import.meta.url)('sherpa-onnx-node');
const dir = process.argv[2];
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: join(dir, 'encoder.int8.onnx'), decoder: join(dir, 'decoder.int8.onnx'), joiner: join(dir, 'joiner.int8.onnx') },
    tokens: join(dir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0, modelType: 'nemo_transducer',
  },
});

process.on('message', ({ id, pieces }) => {
  try {
    const said = [];
    for (const samples of pieces) {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ sampleRate: 16000, samples });
      recognizer.decode(stream);
      const text = recognizer.getResult(stream).text.trim();
      if (text) said.push(text);
    }
    process.send({ id, text: said.join(' ') });
  } catch (error) {
    process.send({ id, error: error.message });
  }
});
