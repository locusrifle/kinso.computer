import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const source = name => read(`../app/src/main/java/computer/imperfect/code/${name}.kt`);
const code = text => text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const between = (text, from, to) => text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from) + from.length));

// Download in Files is a link the computer answers as an attachment. A
// WebView does nothing with a download unless it is handed on: the app
// takes it, but only a file Files offers, from the person's own computers.
// Anything else stays as it was: a PDF shown in a frame is a "download" to
// a WebView, and opening one must not send anything anywhere.
test('a download in the window is handed to the app, which takes only Files\' own, from the person\'s computers', async () => {
  const surfaces = await source('Surfaces');
  assert.match(surfaces, /view\.setDownloadListener \{ url, userAgent, contentDisposition, _, _ ->\n\s+Downloads\.ask\(context, url, userAgent, contentDisposition\)/);
  const downloads = await source('Downloads');
  const ask = between(downloads, 'fun ask(context: Context', 'fun stop()');
  assert.match(ask, /^\s+if \(!Disposition\.attachment\(disposition\) \|\| !Disposition\.isFiles\(url\) \|\| !Machine\.owns\(url\)\) return$/m, 'checked before anything at all');
  assert.ok(ask.indexOf('Machine.owns') < ask.indexOf('queue.execute'));
  assert.doesNotMatch(code(downloads), /ACTION_VIEW, Uri\.parse|startActivity\(Intent\(Intent\.ACTION_VIEW, /, 'nothing else is opened elsewhere');
  const disposition = await source('Disposition');
  assert.doesNotMatch(disposition, /^import android/m, 'reads the same anywhere');
  assert.match(disposition, /Regex\("\^\(\/peer\/\[\^\/\]\+\)\?\/files\/raw\$"\)/, 'here, or through one other computer, never chained');
  assert.match(disposition, /uri\.scheme == "https" && uri\.userInfo == null/);
  assert.match(disposition, /split\('&'\)\.contains\("download=1"\)/);
});

// A refusal is never a download. A page elsewhere (an agent's, on 8443) that
// points a frame at a file is refused by the computer; if a WebView took that
// refusal for a download, the app, asking again without the browser's
// Sec-Fetch-Site, would be let in. So the app takes only what the computer
// sent to be saved (attachment), and the computer's refusals say they are text.
test('only a file the computer sent to be saved is taken, and its refusals say they are text', async () => {
  const disposition = await source('Disposition');
  assert.match(disposition, /fun attachment\(header: String\?\): Boolean =\n\s+header\.orEmpty\(\)\.substringBefore\(';'\)\.trim\(\)\.equals\("attachment", ignoreCase = true\)/);
  const downloads = code(await source('Downloads'));
  const save = between(downloads, 'private fun save(', 'private fun strong(');
  assert.equal((save.match(/if \(!Disposition\.attachment\(\w+\.getHeaderField\("Content-Disposition"\)\)\) throw Refused/g) ?? []).length, 2, 'its own answer too, first and when it starts again');
  const server = await read('../../system/server.mjs');
  assert.match(server, /const PLAIN = \{ 'content-type': 'text\/plain; charset=utf-8' \};/);
  assert.match(server, /res\.writeHead\(403, PLAIN\)\.end\('files are read only from Workbench'\)/);
  assert.match(server, /res\.writeHead\(403, PLAIN\)\.end\('Private local origin required'\)/);
  assert.doesNotMatch(server, /res\.writeHead\(40\d\)\.end\('(files are read only|Private local origin|bad peer path)/);
});

// The name is read parameter by parameter, a quoted value whole: a file
// called "notes; filename*=UTF-8''setup.apk; x.txt" is saved as that, a text
// file, and never as setup.apk.
test('a name is read by its exact parameter, outside quotes, never from inside another', async () => {
  const disposition = code(await source('Disposition'));
  const name = between(disposition, 'fun name(header: String?)', 'private fun parameters(');
  assert.match(name, /val given = parameters\(header\)/);
  assert.match(name, /given\["filename\*"\]\?\.let\(EXTENDED::matchEntire\)/, 'filename* by its exact name, its value whole');
  assert.match(name, /return given\["filename"\]/);
  const parameters = between(disposition, 'private fun parameters(', '/** A name to save under');
  assert.match(parameters, /c == '"' -> \{ quoted = !quoted/);
  assert.match(parameters, /c == ';' && !quoted -> \{ parts \+= part\.toString\(\); part\.clear\(\) \}/, 'split only outside quotes');
  assert.match(parameters, /quoted && c == '\\\\'/, 'a quoted backslash keeps what follows');
  assert.match(parameters, /parts\.drop\(1\)/, 'the type is not a parameter');
  assert.doesNotMatch(disposition, /\.find\(header\)/, 'nothing searched for anywhere in the header');
});

// MediaStore's Downloads collection (Android 10 and later) takes a file
// with no storage permission. The bytes go from the connection to the file
// a buffer at a time: never whole in memory, never through the page.
test('a download streams into Downloads through MediaStore, with no storage permission', async () => {
  const downloads = await source('Downloads');
  const save = code(between(downloads, 'private fun save(', 'private fun savedName('));
  assert.match(downloads, /@RequiresApi\(Build\.VERSION_CODES\.Q\)\n\s+private fun save\(/);
  assert.match(between(downloads, 'fun ask(context: Context', 'fun stop()'), /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.Q\) \{\n\s+tell\(State\.Failed\(name, app\.getString\(R\.string\.download_needs_android_10\)\)\)/);
  assert.match(save, /files\.insert\(MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/);
  assert.match(save, /put\(MediaStore\.MediaColumns\.RELATIVE_PATH, Environment\.DIRECTORY_DOWNLOADS\)/);
  assert.match(save, /put\(MediaStore\.MediaColumns\.IS_PENDING, 1\)/, 'hidden while it fills');
  assert.match(save, /put\(MediaStore\.MediaColumns\.IS_PENDING, 0\)/, 'shown once whole');
  assert.ok(save.indexOf('IS_PENDING, 0') > save.indexOf('output!!.close()'), 'only after the last byte is written');
  assert.match(save, /files\.openOutputStream\(item, "w"\)/);
  assert.match(downloads, /BUFFER = 64 shl 10/);
  assert.match(save, /val buffer = ByteArray\(BUFFER\)/);
  assert.match(save, /input\?\.read\(buffer\) \?: -2/);
  assert.match(save, /output!!\.write\(buffer, 0, n\)/);
  assert.doesNotMatch(code(downloads), /readBytes|readText|Base64|ByteArrayOutputStream|evaluateJavascript|addJavascriptInterface/, 'nothing whole in memory, nothing through the page');
  assert.match(between(downloads, '} finally {', 'current = null'), /item\?\.let \{ runCatching \{ files\.delete\(it, null, null\) \} \}/, 'what did not finish is not left half there');
  const manifest = await read('../app/src/main/AndroidManifest.xml');
  assert.doesNotMatch(manifest, /STORAGE|READ_MEDIA|WRITE_EXTERNAL/, 'no storage permission');
});

// The app asks the computer as Update.kt does: the address the page came
// from, over the tailnet, with nothing a browser sends. The computer's own
// checks for browsers (Sec-Fetch-Site, Origin, Host) stay as they are.
test('the app reaches the computer as the page does, and the computer\'s checks for browsers are untouched', async () => {
  const downloads = code(await source('Downloads'));
  const fetch = between(downloads, 'private fun fetch(', 'private fun refusal(');
  assert.match(fetch, /URL\(job\.url\)\.openConnection\(\) as HttpURLConnection/, "the page's own address");
  assert.match(fetch, /instanceFollowRedirects = false/, 'never sent anywhere else');
  assert.match(fetch, /setRequestProperty\("Accept-Encoding", "identity"\)/);
  assert.doesNotMatch(downloads, /Origin|Sec-Fetch|Cookie|Authorization|CookieManager/i, 'claims nothing it is not');
  const files = await read('../../system/files.mjs');
  assert.match(files, /export const fromElsewhere = req => \{\n\s+const site = req\.headers\?\.\['sec-fetch-site'\];\n\s+return Boolean\(site\) && site !== 'same-origin' && site !== 'none';\n\};/);
  assert.match(files, /if \(READS\.has\(path\) && fromElsewhere\(req\)\) \{/);
  assert.match(files, /READS = new Set\(\[[^\]]*'\/files\/raw'/);
});

// A film on a phone's connection may break off: the rest is asked for, but
// only if the file on the computer is still the one begun.
test('a download that broke off asks for the rest of the same file, else starts again', async () => {
  const downloads = code(await source('Downloads'));
  assert.match(downloads, /setRequestProperty\("Range", "bytes=\$from-"\)/);
  assert.match(downloads, /setRequestProperty\("If-Range", etag\)/);
  assert.match(downloads, /var etag = strong\(connection\)/);
  assert.match(downloads, /getHeaderField\("ETag"\)\?\.takeIf \{ it\.startsWith\("\\""\) \}/, 'a weak ETag never resumes');
  assert.match(downloads, /RESUMES = 3/);
  const partial = between(downloads, 'HttpURLConnection.HTTP_PARTIAL ->', 'HttpURLConnection.HTTP_OK ->');
  assert.match(partial, /Disposition\.range\(reached\.getHeaderField\("Content-Range"\)\)/);
  assert.match(partial, /if \(from != written\) throw/, 'the rest begins where it broke off, or not at all');
  const whole = between(downloads, 'HttpURLConnection.HTTP_OK ->', 'else -> throw refusal');
  assert.match(whole, /files\.openOutputStream\(item, "wt"\)/, 'changed meanwhile: written again from the start');
  assert.match(whole, /written = 0/);
  // A failed write is the phone's (out of room), not a dropped connection.
  assert.match(downloads, /val n = try \{ input\?\.read\(buffer\) \?: -2 \} catch \(_: IOException\) \{ -2 \}/);
  // A computer still out of reach as it asks again is one more try, not the end.
  const again = between(downloads, 'var answer = 0', 'val reached = connection!!');
  assert.match(again, /while \(answer == 0\) \{/);
  assert.match(again, /if \(etag == null \|\| \+\+resumes > RESUMES\) throw/, 'within the few tries allowed');
  assert.match(again, /try \{\n\s+connection = fetch\(job, from = written, etag = etag\)\n\s+answer = connection\.responseCode\n\s+\} catch \(_: IOException\) \{\n\s+if \(job\.stopped\) throw Stopped\(\)\n\s+\}/);
  assert.match(downloads, /input = try \{ reached\.inputStream \} catch \(_: IOException\) \{ null \}/);
});

// The name is the file's own, read from the header the computer writes
// (filename*, RFC 8187), and its type is Android's for that name, so
// MediaStore keeps the name exactly and the right app opens it.
test('the file keeps its own name and is filed by the type Android knows for it', async () => {
  const disposition = await source('Disposition');
  assert.ok(disposition.indexOf('given["filename*"]') < disposition.indexOf('given["filename"]'), 'filename* first');
  assert.match(disposition, /replace\("\+", "%2B"\)/, 'a + in a name is a +');
  const downloads = await source('Downloads');
  assert.match(downloads, /MimeTypeMap\.getSingleton\(\)\.getMimeTypeFromExtension\(it\) \} \?: "application\/octet-stream"/);
  assert.match(downloads, /put\(MediaStore\.MediaColumns\.MIME_TYPE, type\)/);
  assert.match(downloads, /State\.Saved\(savedName\(files, item\) \?: name, item, type\)/, 'the name Downloads gave it, if it had one already');
});

// How far it has come, then where it went, in the window: a band of the
// app's own, hard edged, with Cancel and then Open.
test('a band at the foot of the window shows the download coming in, then "Saved to Downloads" with Open', async () => {
  const band = await source('DownloadBand');
  assert.match(band, /R\.color\.band/);
  assert.match(band, /bar\.scaleX = if \(now\.total > 0\)/, 'the accent line fills as it comes');
  assert.match(band, /offer\(context\.getString\(R\.string\.download_cancel\)\) \{ Downloads\.stop\(\) \}/);
  assert.match(band, /offer\(context\.getString\(R\.string\.download_open\), open\)/);
  assert.doesNotMatch(code(band), /cornerRadius|GradientDrawable|ProgressBar|Toast/, 'hard edges, no spinner');
  const strings = await read('../app/src/main/res/values/strings.xml');
  assert.match(strings, /<string name="download_saved">Saved to Downloads: %1\$s<\/string>/);
  assert.match(strings, /<string name="download_going">Downloading %1\$s · %2\$s<\/string>/);
  const downloads = await source('Downloads');
  const open = between(downloads, 'fun open(context: Context', 'fun typeOf(');
  assert.match(open, /Intent\(Intent\.ACTION_VIEW\)\.setDataAndType\(saved\.uri, saved\.type\)/);
  assert.match(open, /FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(open, /DownloadManager\.ACTION_VIEW_DOWNLOADS/, 'nothing opens it: the phone\'s Downloads, where it is');
  const main = await source('MainActivity');
  assert.match(main, /Downloads\.watch\(this, band::show\)/);
  assert.match(between(main, 'override fun onDestroy()', 'super.onDestroy()'), /Downloads\.unwatch\(this\)/);
  assert.match(main, /if \(::band\.isInitialized\) band\.layoutParams = \(band\.layoutParams as FrameLayout\.LayoutParams\)\.apply \{ bottomMargin = safeBottomPx \}/, 'clear of the gesture bar and the keys');
  assert.match(between(main, 'override fun onStart()', 'override fun onStop()'), /band\.awake\(true\)/);
  assert.match(between(main, 'override fun onStop()', 'override fun onDestroy()'), /band\.awake\(false\)/);
});
