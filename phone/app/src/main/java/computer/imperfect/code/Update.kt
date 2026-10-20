package computer.imperfect.code

import android.app.Activity
import androidx.appcompat.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * The app updates itself from the computer it talks to, wherever the phone
 * is. Coming to the front, it asks the machine which APK main pins
 * (`/phone/android.json`). When that is not the one installed here (the two
 * are compared by content, so there is no version number to keep in step), it
 * fetches it (`/phone/android.apk`), checks it is exactly that, and offers to
 * install it. Android always asks the person before installing; the first
 * time it also asks them to let imperfect install apps.
 *
 * A new version that was put off is offered again the next time the app is
 * opened, not every time it comes back to the front.
 */
object Update {
  private const val MAX_BYTES = 256L shl 20
  @Volatile private var checking = false
  @Volatile private var putOff = ""
  @Volatile private var lastAsked = 0L

  fun check(activity: Activity) {
    val base = Machine.base
    if (checking || base.isEmpty() || System.currentTimeMillis() - lastAsked < 10 * 60_000) return
    checking = true
    lastAsked = System.currentTimeMillis()
    Thread {
      try {
        val wanted = JSONObject(get("$base/phone/android.json").use { it.readBytes().decodeToString() }).getString("sha256")
        if (wanted == putOff || wanted == sha256(File(activity.applicationInfo.sourceDir))) return@Thread
        val dir = File(activity.cacheDir, "updates").apply { mkdirs() }
        val apk = File(dir, "imperfect.apk")
        if (!apk.isFile || sha256(apk) != wanted) {
          dir.listFiles()?.forEach { it.delete() }
          val part = File(dir, "imperfect.apk.part")
          get("$base/phone/android.apk").use { input ->
            part.outputStream().use { output ->
              val buffer = ByteArray(64 shl 10)
              var total = 0L
              while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                total += n
                if (total > MAX_BYTES) error("too large")
                output.write(buffer, 0, n)
              }
            }
          }
          if (sha256(part) != wanted) { part.delete(); return@Thread }
          part.renameTo(apk)
        }
        activity.runOnUiThread { offer(activity, apk, wanted) }
      } catch (_: Exception) {
        // Away from the machine, or it pins no app: nothing to offer.
      } finally {
        checking = false
      }
    }.start()
  }

  private fun offer(activity: Activity, apk: File, sha: String) {
    if (activity.isFinishing || activity.isDestroyed) return
    AlertDialog.Builder(activity)
      .setTitle(activity.getString(R.string.update_title))
      .setMessage(activity.getString(R.string.update_message))
      .setPositiveButton(activity.getString(R.string.update_install)) { _, _ -> install(activity, apk) }
      .setNegativeButton(activity.getString(R.string.update_later)) { _, _ -> putOff = sha }
      .setOnCancelListener { putOff = sha }
      .show()
  }

  private fun install(activity: Activity, apk: File) {
    // The first time: Android's own switch for letting imperfect install apps.
    // Back from it, the app comes to the front and offers the update again.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      lastAsked = 0L
      activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
      return
    }
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.attachments", apk)
    activity.startActivity(Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
  }

  private fun get(url: String) = (URL(url).openConnection() as HttpURLConnection).run {
    connectTimeout = 8_000
    readTimeout = 60_000
    instanceFollowRedirects = false
    if (responseCode != 200) { disconnect(); error("$url: $responseCode") }
    inputStream
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(64 shl 10)
      while (true) {
        val n = input.read(buffer)
        if (n < 0) break
        digest.update(buffer, 0, n)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}
