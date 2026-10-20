import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = path => readFile(new URL(`../app/src/main/${path}`, import.meta.url), 'utf8');

test('existing files open the document picker; camera and new audio are separately named choices', async () => {
  const attach = await source('java/computer/imperfect/code/Attach.kt');
  const activity = await source('java/computer/imperfect/code/MainActivity.kt');
  const strings = await source('res/values/strings.xml');
  assert.match(attach, /add\(Choice\(R\.string\.attach_files, documents\(params\)\)\)/);
  assert.match(attach, /Intent\(Intent\.ACTION_OPEN_DOCUMENT\)/);
  assert.match(attach, /CATEGORY_OPENABLE/);
  assert.match(attach, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(attach, /intent\.type = "\*\/\*"/);
  assert.match(attach, /mimeTypes\(params\.acceptTypes\)/);
  assert.match(attach, /EXTRA_MIME_TYPES, types/);
  assert.match(attach, /MODE_OPEN_MULTIPLE[\s\S]*EXTRA_ALLOW_MULTIPLE, true/);
  assert.doesNotMatch(attach, /createChooser|ACTION_GET_CONTENT|createIntent\(/);
  assert.match(attach, /Choice\(R\.string\.attach_photo, camera\)/);
  assert.match(attach, /Choice\(R\.string\.attach_recording, recorder\)/);
  assert.match(attach, /MediaStore\.ACTION_IMAGE_CAPTURE/);
  assert.match(attach, /MediaStore\.Audio\.Media\.RECORD_SOUND_ACTION/);
  assert.match(strings, /Choose existing files \(audio, photos, documents\)/);
  assert.match(strings, /Record new audio/);
  assert.match(activity, /setItems\(choices\.map[\s\S]*pickFiles\.launch\(choices\[which\]\.intent\)/);
  assert.match(activity, /setOnCancelListener \{ cancelFilePicker\(\) \}/);
  assert.match(activity, /private fun cancelFilePicker\(\)[\s\S]*fileCallback\?\.onReceiveValue\(null\)/);
});

test('audio is accepted by the web input and document results keep single and multiple URIs without storage permissions', async () => {
  const attach = await source('java/computer/imperfect/code/Attach.kt');
  const manifest = await source('AndroidManifest.xml');
  const html = await readFile(new URL('../../apps/code/native/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="entry-files"[^>]*multiple[^>]*accept="audio\/\*,image\/\*,\.m4a,/);
  assert.match(attach, /data\.clipData\?\.let/);
  assert.match(attach, /data\.data\?\.let\(out::add\)/);
  assert.match(attach, /resultCode != android\.app\.Activity\.RESULT_OK/);
  assert.doesNotMatch(manifest, /READ_EXTERNAL_STORAGE|MANAGE_EXTERNAL_STORAGE|READ_MEDIA_AUDIO/);
  assert.match(manifest, /android\.intent\.action\.OPEN_DOCUMENT/);
});
