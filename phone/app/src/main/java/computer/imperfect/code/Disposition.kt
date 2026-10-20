package computer.imperfect.code

import java.net.URI
import java.net.URLDecoder

/**
 * What a download is, from its address and headers alone: whether it is a
 * file Files offers, and what it is called. No Android in here, so it reads
 * the same anywhere.
 */
object Disposition {
  private val FILES = Regex("^(/peer/[^/]+)?/files/raw$")
  // charset'language'value, the value percent-encoded (RFC 8187).
  private val EXTENDED = Regex("""([A-Za-z0-9!#$%&+^_`{}~-]+)'[A-Za-z0-9-]*'((?:%[0-9A-Fa-f]{2}|[A-Za-z0-9!#$&+.^_`|~-])+)""")
  private val RANGE = Regex("""^bytes (\d+)-(\d+)/(\d+)$""")

  /**
   * A file Files offers for download: `/files/raw?…&download=1` over HTTPS,
   * on a computer or through one (`/peer/<id>/`). Whose computer it is,
   * Machine.owns says.
   */
  fun isFiles(url: String): Boolean = try {
    val uri = URI(url)
    uri.scheme == "https" && uri.userInfo == null && FILES.matches(uri.rawPath.orEmpty()) &&
      uri.rawQuery.orEmpty().split('&').contains("download=1")
  } catch (_: Exception) { false }

  /**
   * Whether a Content-Disposition sends a file to be saved: the computer
   * says attachment for a download, and never for a refusal.
   */
  fun attachment(header: String?): Boolean =
    header.orEmpty().substringBefore(';').trim().equals("attachment", ignoreCase = true)

  /**
   * The name a Content-Disposition gives (RFC 6266): filename*, as the
   * computer writes it (UTF-8, percent-encoded, RFC 8187), else filename.
   * Each is found by its exact name among the header's parameters, so a
   * name with "; filename*=" in it, quoted, is only ever that name.
   */
  fun name(header: String?): String? {
    if (header.isNullOrBlank()) return null
    val given = parameters(header)
    given["filename*"]?.let(EXTENDED::matchEntire)?.let { found ->
      // RFC 8187 has no + for a space: a + is itself.
      val decoded = runCatching { URLDecoder.decode(found.groupValues[2].replace("+", "%2B"), found.groupValues[1]) }.getOrNull()
      if (!decoded.isNullOrBlank()) return decoded
    }
    return given["filename"]?.takeIf { it.isNotBlank() }
  }

  // A header's parameters by name (lower case), the first of each: split at
  // each ; outside a quoted string, a quoted value unquoted. The first part
  // is the type (attachment, inline), not a parameter.
  private fun parameters(header: String): Map<String, String> {
    val parts = mutableListOf<String>()
    val part = StringBuilder()
    var quoted = false
    var i = 0
    while (i < header.length) {
      val c = header[i]
      when {
        quoted && c == '\\' && i + 1 < header.length -> { part.append(c).append(header[i + 1]); i++ }
        c == '"' -> { quoted = !quoted; part.append(c) }
        c == ';' && !quoted -> { parts += part.toString(); part.clear() }
        else -> part.append(c)
      }
      i++
    }
    parts += part.toString()
    val given = LinkedHashMap<String, String>()
    for (one in parts.drop(1)) {
      val equals = one.indexOf('=')
      if (equals <= 0) continue
      val key = one.substring(0, equals).trim().lowercase()
      var value = one.substring(equals + 1).trim()
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.substring(1, value.length - 1).replace(Regex("""\\(.)"""), "$1")
      }
      given.putIfAbsent(key, value)
    }
    return given
  }

  /** The name in Files' own address (its path=), for when no header says. */
  fun fromAddress(url: String): String? = try {
    URI(url).rawQuery.orEmpty().split('&').firstOrNull { it.startsWith("path=") }
      ?.let { URLDecoder.decode(it.removePrefix("path=").replace("+", "%2B"), "UTF-8") }
      ?.substringAfterLast('/')?.takeIf { it.isNotEmpty() }
  } catch (_: Exception) { null }

  /** A name to save under: no folder in it, no control characters, never empty. */
  fun safe(name: String?): String {
    val clean = name.orEmpty().substringAfterLast('/').replace(Regex("[\\u0000-\\u001f\\u007f]"), "_").trim()
    return if (clean.isEmpty() || clean.all { it == '.' }) "download" else clean
  }

  /** Where a range answered begins and the whole file's size: `bytes 10-99/100`. */
  fun range(header: String?): Pair<Long, Long>? =
    RANGE.matchEntire(header.orEmpty().trim())?.let { it.groupValues[1].toLong() to it.groupValues[3].toLong() }
}
