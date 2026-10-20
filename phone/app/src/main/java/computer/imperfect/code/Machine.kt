package computer.imperfect.code

import android.content.Context
import android.content.Intent
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * The machine is the computer. This app holds its address and nothing else.
 *
 * What is open and what the theme is -- the machine answers all of that to the page it serves, so this shell does
 * not ask the same questions again in Kotlin and get a second, disagreeing
 * answer.
 *
 * There may be more than one candidate, because the home moves: the laptop
 * today, the testbed next, a desktop machine later. The phone asks each
 * in turn which one is actually up and talks to that one. It is not a setting,
 * a login or a server list a person maintains -- it is the same question the
 * brief already answers: the phone talks to whichever machine is home on the
 * tailnet.
 *
 * The app carries no addresses: its owner scans the QR code `./install.sh
 * phone` shows (or types one computer's Tailscale address) the first time,
 * and that one address is remembered. The machine it reaches lists the others
 * (`/machines.json`) and serves them through `/peer/<id>/`, so one pairing
 * gives every computer. Their addresses are remembered too, so the phone
 * still finds one when the paired computer is off.
 */
object Machine {
  private const val PREFS = "machine"
  private const val ADDRESS = "address"
  private const val KNOWN = "known"

  @Volatile
  var candidates: List<String> = emptyList()
    private set

  /** The one that answered last, so every request does not re-run the search. */
  @Volatile
  var base: String = candidates.firstOrNull().orEmpty()
    private set

  /** The paired address first, then the computers it listed. */
  fun load(context: Context) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val saved = prefs.getString(ADDRESS, null).orEmpty()
    val known = prefs.getString(KNOWN, null).orEmpty().split(',')
    candidates = (listOf(saved) + known).filter { it.isNotEmpty() }.distinct()
    if (base !in candidates) base = candidates.firstOrNull().orEmpty()
  }

  /** A pairing: this computer, and only what it lists from now on. */
  fun remember(context: Context, address: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(ADDRESS, address).remove(KNOWN).apply()
    load(context)
    base = address
  }

  /**
   * Blocking. Asks the computer that answered which computers it knows
   * (`/machines.json`, itself included) and keeps their addresses as the
   * ones to try when it is off.
   */
  fun learn(context: Context) {
    val home = base
    if (home.isEmpty()) return
    try {
      val connection = URL("$home/machines.json").openConnection() as HttpURLConnection
      connection.connectTimeout = 3000
      connection.readTimeout = 3000
      val body = try {
        if (connection.responseCode != 200) return
        connection.inputStream.use { it.readBytes().decodeToString() }
      } finally {
        connection.disconnect()
      }
      val rows = JSONObject(body).optJSONArray("machines") ?: return
      val known = (0 until rows.length()).mapNotNull { rows.optJSONObject(it)?.optString("url")?.let(::origin) }
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val edit = prefs.edit().putString(KNOWN, known.joinToString(","))
      if (prefs.getString(ADDRESS, null).isNullOrEmpty()) edit.putString(ADDRESS, home)
      edit.apply()
      load(context)
    } catch (_: Exception) {
      // Away from it, or an older computer: keep what is remembered.
    }
  }

  /**
   * What a person typed or scanned, as an origin: `desk.tail-name.ts.net`,
   * `https://desk.tail-name.ts.net/phone` (the QR code `./install.sh phone`
   * shows) and `imperfect://desk.tail-name.ts.net` all become
   * `https://desk.tail-name.ts.net`. HTTPS only, and nothing but scheme, host
   * and port.
   */
  fun origin(typed: String): String? = try {
    var text = typed.trim().trimEnd('/')
    if (text.startsWith("imperfect://", ignoreCase = true)) text = "https://" + text.substring("imperfect://".length)
    if (!text.contains("://")) text = "https://$text"
    val uri = URI(text)
    val host = uri.host.orEmpty()
    if (uri.scheme != "https" || host.isEmpty() || uri.userInfo != null) null
    else "https://$host${if (uri.port != -1) ":${uri.port}" else ""}"
  } catch (_: Exception) { null }

  /**
   * The address a pairing link carries: `imperfect://desk.tail-name.ts.net`,
   * from the page that `./install.sh phone`'s QR code opens. Null for any
   * other launch, and for a reopen from recents, which would replay the link.
   */
  fun offered(intent: Intent?): String? {
    val data = intent?.data ?: return null
    if (intent.action != Intent.ACTION_VIEW || data.scheme != "imperfect") return null
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return null
    return data.authority?.let { origin(it) }
  }

  fun configured(): Boolean = candidates.isNotEmpty()

  /** Blocking; for checking a typed address before it is remembered. */
  fun answers(address: String): Boolean = alive(address)

  /** True for configured origins or another HTTPS node in the same tailnet. */
  fun owns(url: String): Boolean = try {
    val asked = URI(url)
    if (asked.userInfo != null) false else candidates.any { origin ->
      val configured = URI(origin)
      if (asked.scheme == configured.scheme && asked.host == configured.host && asked.port == configured.port) return@any true
      // Tailscale HTTPS names are <machine>.<tailnet>.ts.net. A peer rename
      // changes only the first label, so accepting this derived private suffix
      // keeps owner navigation working without accepting the public web.
      val host = configured.host.orEmpty().lowercase()
      val suffix = host.indexOf('.').takeIf { it >= 0 }?.let { host.substring(it) }.orEmpty()
      configured.scheme == "https" && suffix.endsWith(".ts.net") &&
        asked.scheme == "https" && asked.port == -1 && asked.host?.lowercase()?.endsWith(suffix) == true
    }
  } catch (_: Exception) { false }

  /**
   * Ask every candidate for `/health` at once and keep the first, in the
   * order they are listed, that answers: the remembered one wins when it is
   * up, and when it is not, the others have already been asked. Blocking: the
   * caller runs it off the main thread. Returns false when none of them is
   * up, which the window says in a sentence rather than spinning on.
   */
  fun findHome(): Boolean {
    val asked = candidates
    if (asked.isEmpty()) return false
    val pool = Executors.newFixedThreadPool(asked.size)
    try {
      val answers = asked.map { address -> pool.submit<Boolean> { alive(address) } }
      for ((i, answer) in answers.withIndex()) {
        val up = try { answer.get() } catch (_: Exception) { false }
        if (up) {
          base = asked[i]
          return true
        }
      }
      return false
    } finally {
      pool.shutdownNow()
    }
  }

  private fun alive(address: String): Boolean = try {
    val connection = URL("$address/health").openConnection() as HttpURLConnection
    connection.connectTimeout = 3000
    connection.readTimeout = 3000
    try {
      connection.responseCode in 200..299
    } finally {
      connection.disconnect()
    }
  } catch (error: Exception) {
    false
  }
}
