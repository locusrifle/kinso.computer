package computer.imperfect.code

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient

/** Files already saved are a separate choice from making a photo or recording. */
object Attach {
  data class Choice(val label: Int, val intent: Intent)

  fun choices(
    context: Context,
    params: WebChromeClient.FileChooserParams,
    photo: Uri?,
  ): List<Choice> = buildList {
    add(Choice(R.string.attach_files, documents(params)))
    val accept = params.acceptTypes
    if (photo != null && admits(accept, "image/jpeg")) {
      val camera = capture(context, photo)
      if (camera.resolveActivity(context.packageManager) != null) {
        add(Choice(R.string.attach_photo, camera))
      }
    }
    if (admits(accept, "audio/mp4")) {
      val recorder = Intent(MediaStore.Audio.Media.RECORD_SOUND_ACTION)
      if (recorder.resolveActivity(context.packageManager) != null) {
        add(Choice(R.string.attach_recording, recorder))
      }
    }
  }

  /** Open Android's document picker directly, not an app/new-recording resolver. */
  private fun documents(params: WebChromeClient.FileChooserParams): Intent {
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
    intent.addCategory(Intent.CATEGORY_OPENABLE)
    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    // All accepted families, including existing audio. A document provider can
    // expose Files or Drive, but cannot browse another app's private recordings.
    intent.type = "*/*"
    val types = mimeTypes(params.acceptTypes)
    if (types.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types)
    if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
      intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
    }
    return intent
  }

  private fun capture(context: Context, photo: Uri): Intent {
    val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE)
    intent.putExtra(MediaStore.EXTRA_OUTPUT, photo)
    // A camera app writes the picture itself, so it needs the grant carried on
    // the intent as well as the per-package one the caller hands out.
    intent.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    grant(context, intent, photo)
    return intent
  }

  private fun grant(context: Context, intent: Intent, uri: Uri) {
    val matches = context.packageManager.queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY)
    for (match in matches) {
      context.grantUriPermission(
        match.activityInfo.packageName, uri,
        Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION,
      )
    }
  }

  /**
   * The accept list as MIME types a picker understands. Extensions are turned
   * into their type; anything with no known type is dropped rather than passed
   * on, because one unresolvable entry in EXTRA_MIME_TYPES is a picker that
   * shows an empty folder.
   */
  fun mimeTypes(accept: Array<String>?): Array<String> {
    val out = LinkedHashSet<String>()
    for (raw in accept ?: emptyArray()) {
      val token = raw.trim()
      if (token.isEmpty() || token == "*/*") continue
      if (token.contains('/')) { out.add(token); continue }
      val extension = token.removePrefix(".").lowercase()
      val mapped = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
      if (mapped != null) out.add(mapped)
    }
    return out.toTypedArray()
  }

  /**
   * What the picker handed back. `FileChooserParams.parseResult` reads only the
   * intent's single Uri, but a picker opened for several files -- Photos, the
   * system photo picker -- answers with a ClipData list and no Uri at all, even
   * when one image was chosen. Reading only the Uri meant choosing images from
   * the + attached nothing.
   */
  fun chosen(resultCode: Int, data: Intent?): Array<Uri>? {
    if (resultCode != android.app.Activity.RESULT_OK || data == null) return null
    val out = LinkedHashSet<Uri>()
    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(out::add) }
    data.data?.let(out::add)
    return out.takeIf { it.isNotEmpty() }?.toTypedArray()
  }

  /** Does the field accept this kind of thing? An empty list accepts anything. */
  fun admits(accept: Array<String>?, mime: String): Boolean {
    val types = mimeTypes(accept)
    if (types.isEmpty()) return true
    val family = mime.substringBefore('/')
    return types.any { it == mime || it == "$family/*" || it == "*/*" }
  }
}
