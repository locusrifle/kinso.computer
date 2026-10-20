package computer.imperfect.code

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * A file from Files, saved in the phone's Downloads folder.
 *
 * The page asks as any browser would: Download in Files is a link to
 * `/files/raw?…&download=1`, which the computer sends as an attachment. The
 * WebView hands that here (Surfaces.kt), and this asks the computer for the
 * file again itself, as Update.kt does for a new version of the app: at the
 * same Tailscale HTTPS address the page came from, so over the same tailnet,
 * with nothing to sign in with (the computer asks for nothing: being on the
 * tailnet is the key). The computer sees its own name as the Host, as it
 * does for the page, and no Origin or Sec-Fetch-Site, which only a browser
 * sends; it refuses files only to pages from elsewhere, so its checks for
 * browsers are untouched. Only a file Files offers, from one of the person's
 * own computers, is fetched here. Anything else the WebView calls a
 * download is left as before: a PDF shown in a frame is one, to a WebView,
 * and opening it in Files must not send anything anywhere.
 *
 * The bytes go from the connection into a MediaStore Downloads entry
 * (Android 10 and later, no storage permission), a buffer at a time, hidden
 * while it fills and deleted if it does not finish, so a film of gigabytes is
 * never held in memory. A connection that drops partway asks for the rest
 * (Range, If-Range on the file's ETag) a few times: the computer sends the
 * rest only if the file is still the one begun, else the whole again. One
 * download at a time, the others waiting their turn.
 */
object Downloads {
  /** What the band at the foot of the window shows (DownloadBand.kt). */
  sealed interface State {
    val name: String
    data class Going(override val name: String, val done: Long, val total: Long, val waiting: Int) : State
    data class Saved(override val name: String, val uri: Uri, val type: String) : State
    data class Failed(override val name: String, val why: String) : State
  }

  private const val BUFFER = 64 shl 10
  private const val RESUMES = 3
  private const val TELL_MS = 250L

  private class Job(val url: String, val agent: String?, var name: String) {
    @Volatile var stopped = false
    @Volatile var connection: HttpURLConnection? = null
  }
  private class Stopped : Exception()
  private class Refused(message: String) : IOException(message)

  private val queue = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private val waiting = AtomicInteger(0)
  @Volatile private var current: Job? = null
  @Volatile private var watcher: Pair<Any, (State) -> Unit>? = null
  @Volatile private var last: State? = null
  @Volatile private var lastAt = 0L

  /**
   * The window that shows them: each change, and, for a window made again
   * (its page's renderer gone), what is coming in now or has just finished.
   */
  fun watch(owner: Any, show: (State) -> Unit) {
    watcher = owner to show
    last?.takeIf { it is State.Going || System.currentTimeMillis() - lastAt < DownloadBand.SHOWN_MS }?.let(show)
  }
  fun unwatch(owner: Any) { if (watcher?.first === owner) watcher = null }
  private fun tell(state: State) {
    last = state
    lastAt = System.currentTimeMillis()
    main.post { watcher?.second?.invoke(state) }
  }

  /**
   * A download the page asked for (the WebView's DownloadListener): taken
   * only if the computer sent it to be saved (attachment, which it never
   * says of a refusal), from Files, on one of the person's own computers.
   */
  fun ask(context: Context, url: String, agent: String?, disposition: String?) {
    if (!Disposition.attachment(disposition) || !Disposition.isFiles(url) || !Machine.owns(url)) return
    val app = context.applicationContext
    val name = Disposition.safe(Disposition.name(disposition) ?: Disposition.fromAddress(url))
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      tell(State.Failed(name, app.getString(R.string.download_needs_android_10)))
      return
    }
    val job = Job(url, agent, name)
    waiting.incrementAndGet()
    queue.execute {
      waiting.decrementAndGet()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) save(app, job)
    }
  }

  /** Stop the one coming in now; what it had is deleted. */
  fun stop() {
    val job = current ?: return
    job.stopped = true
    // Closing a connection can touch the network: never on the main thread.
    Thread { runCatching { job.connection?.disconnect() } }.start()
  }

  /** A saved file, in whatever on the phone opens its kind, else in Downloads. */
  fun open(context: Context, saved: State.Saved) {
    val view = Intent(Intent.ACTION_VIEW).setDataAndType(saved.uri, saved.type)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    try {
      context.startActivity(view)
    } catch (_: ActivityNotFoundException) {
      runCatching { context.startActivity(Intent(DownloadManager.ACTION_VIEW_DOWNLOADS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
  }

  /**
   * What the phone files it as, by its name, as Android knows names: the
   * name then stays exactly as it is (MediaStore adds an extension to one
   * that does not match its type). A name Android does not know is bytes.
   */
  fun typeOf(name: String): String {
    val ext = name.substringAfterLast('.', "").lowercase()
    return ext.takeIf { it.isNotEmpty() }?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) } ?: "application/octet-stream"
  }

  private fun fetch(job: Job, from: Long = 0, etag: String? = null): HttpURLConnection =
    (URL(job.url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 10_000
      readTimeout = 60_000
      instanceFollowRedirects = false
      // The bytes as they are on the computer, counted as they come.
      setRequestProperty("Accept-Encoding", "identity")
      job.agent?.takeIf { it.isNotBlank() }?.let { setRequestProperty("User-Agent", it) }
      if (from > 0 && etag != null) {
        setRequestProperty("Range", "bytes=$from-")
        setRequestProperty("If-Range", etag)
      }
      job.connection = this
    }

  // What the computer said, when it would not send it ({ error } in JSON).
  private fun refusal(context: Context, connection: HttpURLConnection, code: Int): Refused {
    val said = runCatching {
      connection.errorStream?.use { stream ->
        val bytes = ByteArray(4096)
        var n = 0
        while (n < bytes.size) { val got = stream.read(bytes, n, bytes.size - n); if (got < 0) break; n += got }
        JSONObject(String(bytes, 0, n, Charsets.UTF_8)).optString("error")
      }
    }.getOrNull()
    return Refused(said?.takeIf { it.isNotBlank() } ?: context.getString(R.string.download_said, code))
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun save(context: Context, job: Job) {
    current = job
    val files = context.contentResolver
    var item: Uri? = null
    var connection: HttpURLConnection? = null
    var input: InputStream? = null
    var output: OutputStream? = null
    try {
      if (job.stopped) throw Stopped()
      tell(State.Going(job.name, 0, -1, waiting.get()))
      connection = fetch(job)
      if (connection.responseCode != HttpURLConnection.HTTP_OK) throw refusal(context, connection, connection.responseCode)
      if (!Disposition.attachment(connection.getHeaderField("Content-Disposition"))) throw Refused(context.getString(R.string.download_not_sent))
      val name = Disposition.safe(Disposition.name(connection.getHeaderField("Content-Disposition")) ?: job.name)
      job.name = name
      val type = typeOf(name)
      var total = connection.contentLengthLong
      var etag = strong(connection)
      item = files.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, type)
        put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }) ?: throw IOException(context.getString(R.string.download_no_file))
      output = files.openOutputStream(item, "w") ?: throw IOException(context.getString(R.string.download_no_file))
      input = connection.inputStream
      val buffer = ByteArray(BUFFER)
      var written = 0L
      var resumes = 0
      var told = 0L
      while (true) {
        // -2: the connection broke off. A write that fails is the phone's
        // (out of room) and is not tried again.
        val n = try { input?.read(buffer) ?: -2 } catch (_: IOException) { -2 }
        if (job.stopped) throw Stopped()
        if (n > 0) {
          output!!.write(buffer, 0, n)
          written += n
          val now = System.currentTimeMillis()
          if (now - told >= TELL_MS) { told = now; tell(State.Going(name, written, total, waiting.get())) }
          continue
        }
        if (n == -1 && (total < 0 || written >= total)) break
        // Broke off: the rest, if the file is still the one begun. A try
        // that cannot reach the computer yet is one of the few allowed.
        var answer = 0
        while (answer == 0) {
          if (etag == null || ++resumes > RESUMES) throw IOException(context.getString(R.string.download_dropped))
          runCatching { input?.close() }
          runCatching { connection?.disconnect() }
          Thread.sleep(1000L * resumes)
          if (job.stopped) throw Stopped()
          try {
            connection = fetch(job, from = written, etag = etag)
            answer = connection.responseCode
          } catch (_: IOException) {
            if (job.stopped) throw Stopped()
          }
        }
        val reached = connection!!
        when (answer) {
          HttpURLConnection.HTTP_PARTIAL -> {
            val (from, whole) = Disposition.range(reached.getHeaderField("Content-Range")) ?: throw Refused(context.getString(R.string.download_dropped))
            if (from != written) throw Refused(context.getString(R.string.download_dropped))
            total = whole
          }
          HttpURLConnection.HTTP_OK -> {
            // Changed on the computer meanwhile: all of it again, from the start.
            if (!Disposition.attachment(reached.getHeaderField("Content-Disposition"))) throw Refused(context.getString(R.string.download_not_sent))
            runCatching { output!!.close() }
            output = files.openOutputStream(item, "wt") ?: throw IOException(context.getString(R.string.download_no_file))
            written = 0
            total = reached.contentLengthLong
            etag = strong(reached)
          }
          else -> throw refusal(context, reached, answer)
        }
        input = try { reached.inputStream } catch (_: IOException) { null }
      }
      output!!.close()
      output = null
      files.update(item, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      tell(State.Saved(savedName(files, item) ?: name, item, type))
      item = null
    } catch (error: Exception) {
      val why = when {
        job.stopped || error is Stopped || error is InterruptedException -> context.getString(R.string.download_stopped)
        error is UnknownHostException || error is ConnectException || error is NoRouteToHostException || error is SocketTimeoutException ->
          context.getString(R.string.download_unreachable)
        else -> error.message ?: error.javaClass.simpleName
      }
      tell(State.Failed(job.name, why))
    } finally {
      runCatching { input?.close() }
      runCatching { output?.close() }
      runCatching { connection?.disconnect() }
      // Not finished: nothing half there is left behind.
      item?.let { runCatching { files.delete(it, null, null) } }
      current = null
    }
  }

  // Only a strong ETag says the bytes are the same: a weak one never resumes.
  private fun strong(connection: HttpURLConnection): String? =
    connection.getHeaderField("ETag")?.takeIf { it.startsWith("\"") }

  // The name it was saved under: Downloads may already have had one, and
  // then MediaStore gives it another, "name (1).ext".
  private fun savedName(files: ContentResolver, item: Uri): String? = runCatching {
    files.query(item, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { row ->
      if (row.moveToFirst()) row.getString(0) else null
    }
  }.getOrNull()
}
